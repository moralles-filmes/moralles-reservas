# Fase 6b — Ciclo de vida da instância de WhatsApp (Z-API), fluxo manual assistido

> **Status: EM ELABORAÇÃO.** Seções A e B aprovadas pelo dono. Seções C (worker, alertas, divergência, painel) e D (validação, segurança, rollout) pendentes de apresentação e aprovação.
>
> Antecessora: [Fase 5b](2026-07-27-billing-asaas-fase-5b-design.md) — enforcement por serviço, validado ao vivo em 2026-07-31.
> Plano do programa: [docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md).

---

## 0. Por que esta fase existe, e por que ela não é a Fase 6 do plano

O plano original previa provisionar, assinar e cancelar instâncias Z-API **via API do programa de Parceiro Integrador**. Em 2026-07-31 o suporte da Z-API respondeu às três perguntas em aberto e a premissa caiu ([02-ZAPI-PARCEIRO.md](../../billing-asaas/02-ZAPI-PARCEIRO.md), bloco "RESPOSTAS OFICIAIS DO SUPORTE"):

1. **Não existe rota de API para cancelar assinatura.** O cancelamento é manual, pelo painel, e **não é imediato**: a instância segue ativa até o fim do ciclo já pago; só a próxima cobrança é cancelada.
2. **Não há sandbox de parceiro.** O único mecanismo de teste é o trial de 2 dias, válido apenas na 1ª instância criada na conta.
3. **No Plano Partner o pagamento é único mensal** sobre o total de instâncias; no Ultimate (atual) cada instância é cobrada individualmente.

Decisão comercial do dono, na mesma data: **o Partner só compensa a partir de ~10 instâncias, e hoje há 1 canal — não entramos agora.** A fase vira o "fluxo manual assistido" que o próprio plano previa como alternativa.

### 0.1 O invariante que governa o desenho inteiro

**Cancelar no painel da Z-API interrompe o CUSTO DA PLATAFORMA, não o SERVIÇO DO CLIENTE.** A instância continua viva até o fim do ciclo já pago. Quem interrompe o serviço do cliente é o **enforcement da Fase 5b** — que já existe, já foi validado ao vivo (inadimplência suspende, pagamento restaura) e hoje está com a flag `whatsapp_service_enforcement` OFF.

São **duas ações, com dois relógios e duas consequências**. Tratar como uma só produz a família de bug que já custou caro neste projeto — o [bug 08](../../billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md), em que o sistema afirmava um cancelamento que o provedor nunca fez.

Regra normativa, verificável em revisão de código:

> **`whatsapp_instances.lifecycle_state` MUST NOT be used as an entitlement or message-sending authorization source.**

Nenhum consumidor de envio, agente, webhook ou job pode decidir permissão lendo `lifecycle_state`. A fonte de direito de uso continua sendo o gate de sete estados da 5b ([_shared/whatsapp-service-state-core.ts](../../../supabase/functions/_shared/whatsapp-service-state-core.ts)).

### 0.2 Decomposição: 6b antes, 6a depois

A Fase 6 do plano foi decomposta em dois subprojetos independentes, com specs e ciclos próprios:

| Subfase | Escopo | Risco | Ordem |
|---|---|---|---|
| **6b** (esta spec) | Rastrear ciclo, custo, estado e vínculo da instância. Duas tabelas, um worker, um painel. Não toca envio nem credencial. | Baixo — nenhum caminho vivo é alterado | **Primeiro** |
| **6a** (spec própria, futura) | Hardening: criptografia em repouso de `whatsapp_channels.credentials`, chave fora da tabela e do código, leitura dupla, migração controlada, rotação, auditoria, atualização de todos os consumidores | Alto — toca o caminho de envio do único canal vivo | Depois, e **antes de qualquer novo provisionamento real** |

Razão da ordem (decisão do dono): a 6b entrega valor operacional imediato com risco menor e não copia credenciais; a 6a passa a ser **gate obrigatório de expansão** em vez de bloquear um rastreamento que já pode ser construído com segurança. As duas specs **não ficam abertas ao mesmo tempo** — a 6a começa com o contexto real produzido pela implementação da 6b.

### 0.3 Contrato negativo da 6b (obrigatório)

A 6b **não pode**:

- armazenar tokens, senhas, API keys, client tokens ou qualquer credencial;
- duplicar `whatsapp_channels.credentials`;
- alterar o formato atual das credenciais;
- alterar o caminho de leitura usado pelo envio;
- migrar, cifrar ou reescrever o segredo do canal do Ren Sushi;
- provisionar instância nova na Z-API;
- criar uma nova fonte de verdade para credenciais;
- introduzir uma chave global adicional (não haverá `zapi_partner_token`).

**Dívida de segurança registrada explicitamente:** `whatsapp_channels.credentials` contém credenciais em texto puro (o `-- add pgcrypto encryption in production` está em [manage-channels/index.ts:157](../../../supabase/functions/manage-channels/index.ts) desde a migration 013, e é o R5 da auditoria de Fase 0). A 6b não piora nem melhora essa exposição. A 6a é quem a fecha.

---

## 1. Fronteira da fase

| Camada | Onde vive hoje | A 6b faz o quê |
|---|---|---|
| Credencial e envio | `whatsapp_channels.credentials` → `whatsapp-send`, `send-*`, `webhook-whatsapp` | **Nada.** Fase 6a |
| Conexão / QR / saúde | `whatsapp_channels.status`, `whatsapp-health`, `manage-channels` action `test` | Só **lê**, para detectar divergência |
| Direito de uso e suspensão | gate de 7 estados da 5b, `process-whatsapp-enforcement` | Só **lê**, nunca decide |
| **Custo da plataforma e calendário do fornecedor** | **`whatsapp_instances` + `whatsapp_instance_cycles` (novas)** | **É esta fase** |

## 2. O gate `NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A`

Constante exportada de um núcleo puro — **não** `platform_flag`. A intenção não é rollout gradual: é proibição estrutural temporária que **desaparece** quando a 6a concluir. Uma flag existiria para ser ligada; esta constante existe para ser removida por um PR.

**Aplicação obrigatória em:**

- criação de canal que represente instância real nova (`manage-channels` action `create`);
- registro de instância com estado inicial `AWAITING_PROVISION`;
- qualquer action futura que inicie provisionamento;
- qualquer fluxo administrativo que gere custo novo no fornecedor.

**Não bloqueia:** rotação de credencial (`rotate_secret`), atualização de canal existente (`update`), correção de metadados, desligamento, cancelamento, e **backfill de instância já existente**.

O gate compõe com o gate de provisionamento da 5b, que já recusa canal novo quando a unidade tem zero canais e o direito não confere ([manage-channels/index.ts:130](../../../supabase/functions/manage-channels/index.ts)): mesmo ponto de entrada, razão distinta, mensagem distinta.

**Backfill permitido** somente com evidência objetiva de que a instância já existe no fornecedor, exigindo: `provider`, `provider_instance_ref`, canal relacionado quando identificável, evidência administrativa, motivo, operador, datas conhecidas — e **nenhuma chamada de provisionamento**.

**Limite honesto, que a spec registra em vez de esconder:** nada impede um humano de abrir o painel da Z-API e clicar em criar. O gate bloqueia o que o sistema autoriza e registra; ele não é um cadeado no fornecedor.

**Quando a 6a remover o gate**, não basta apagar a constante: o PR da 6a substitui os testes de recusa por testes de liberação condicionada a entitlement válido, credencial cifrada, autorização administrativa, idempotência, ausência de instância duplicada e disponibilidade do provider.

## 3. `whatsapp_instances` — inventário de custo, zero segredo

Uma linha por instância Z-API que a plataforma paga (ou pagará).

### 3.1 Campos

| Campo | Tipo | Papel |
|---|---|---|
| `organization_id` | uuid **not null** | Dono comercial. A cobrança do cliente é por organização |
| `unit_id` | uuid | Unidade servida. Obrigatório em instância operacional normal; **nulo apenas em backfill incompleto ou revisão administrativa, com motivo explícito** — e o painel destaca a pendência |
| `channel_id` | uuid FK → `whatsapp_channels`, nullable | Elo com a mensageria. Nulo enquanto o canal não existir |
| `provider` | text check (`zapi`\|`waha`\|`official`) | Não fingir que só existe Z-API |
| `provider_instance_ref` | text | Identificador da instância no painel do fornecedor. **Identificador, não credencial** — ver §3.3 |
| `lifecycle_state` | text check | Os 4 estados de §4 |
| `provider_cycle_anchor_day` | smallint 1–31 | Dia-âncora original do ciclo — ver §6.3 |
| `current_cycle_started_on`, `current_cycle_due_on` | date | **Projeção** do ciclo `OPEN`. Fonte histórica é `whatsapp_instance_cycles` (§7) |
| `cycle_source` | text check (`ADMIN_CONFIRMED`\|`SYSTEM_ROLLED`\|`UNKNOWN`) | Como o sistema sabe a data — ver §6.2 |
| `current_monthly_cost_cents` | integer **nullable** | Custo desconhecido é `NULL`, **nunca zero** |
| `cost_source`, `cost_updated_at`, `cost_updated_by`, `cost_note` | | Procedência e auditoria do custo |
| `cancellation_requested_at`, `cancellation_requested_by`, `cancellation_reason`, `provider_access_until` | | Congelados no ato do cancelamento (§8) |
| `end_confirmation_required_at`, `ended_at`, `ended_by`, `end_confirmation_note` | | Fluxo "worker propõe, admin confirma" (§8.2) |
| `planned_provision_on` | date | Data planejada de instalação (o dono cobra ~3 dias antes) |
| `last_synced_at`, `last_seen_provider_status`, `last_divergence_kind`, `last_divergence_at` | | Detecção de divergência (Seção C) |
| `notes`, `created_by`, `updated_by`, `created_at`, `updated_at` | | Padrão da migration 071 |

Valores monetários em **centavos inteiros**, nunca `float`. Datas de calendário do fornecedor em `date`; eventos administrativos em `timestamptz`.

### 3.2 Unicidade e integridade

- `UNIQUE (provider, provider_instance_ref) WHERE provider_instance_ref IS NOT NULL` — a mesma instância física do fornecedor não pode pertencer a duas organizações nem a duas linhas internas. **Antes de criar a constraint, confirmar formato e sensibilidade a maiúsculas/minúsculas do identificador de cada provider** e normalizar de acordo.
- `UNIQUE (channel_id) WHERE channel_id IS NOT NULL` — um canal não aponta para duas instâncias de custo ao mesmo tempo. Troca histórica de instância no mesmo canal preserva a linha antiga com `channel_id = NULL` ao encerrar, em vez de permitir duas linhas ativas.
- **Sem unicidade por `organization_id`** — ver §5.
- **Integridade cross-tenant server-side** (FK isolada não garante): `unit_id` deve pertencer a `organization_id`; `channel_id`, quando informado, deve pertencer à mesma organização; se o canal tiver `unit_id`, ele deve ser compatível com a unidade da instância. Implementar por trigger de integridade ou RPC transacional, conforme o padrão do projeto. **Não confiar em validação de frontend.**

### 3.3 `provider_instance_ref` — identificador, não credencial

Autorizado porque é identificador operacional, não autentica isoladamente (o token, a outra metade da URL de envio, permanece só no canal) e é necessário para inventário, reconciliação e identificação no painel do fornecedor.

**Fontes declaradas:**

- `whatsapp_instances.provider_instance_ref` — fonte canônica para inventário, custo, ciclo e reconciliação;
- `whatsapp_channels.credentials.instance_id` — campo **legado**, usado pelo caminho atual da mensageria até a 6a.

A duplicação é aceitável **como transição**. A 6b pode **comparar** os dois, mas **não atualiza silenciosamente nenhum**. Quando divergirem: não escolher automaticamente, não sobrescrever credenciais, registrar `last_divergence_kind = 'INSTANCE_REF_MISMATCH'`, abrir alerta administrativo e exigir revisão humana. A 6a decide se elimina a duplicação ou mantém projeção segura e sincronizada.

Validação de sanidade contra valor evidentemente sensível: string não vazia, tamanho máximo razoável, sem URL completa contendo token, sem formato conhecido de credencial quando isso puder ser verificado com segurança. Não registrar o valor em logs públicos nem em respostas tenant-scoped, embora não seja credencial.

### 3.4 RLS e auditoria

`ENABLE` + `FORCE ROW LEVEL SECURITY`, policy única de `platform_admin` — mesma postura de `whatsapp_implementations` ([migration 071](../../../supabase/migrations/20260726100000_071_whatsapp_implementations.sql)). O lojista **não lê** esta tabela: ela contém o que a plataforma paga.

Se alguma tela tenant-scoped precisar futuramente mostrar status genérico, criar projeção segura ou RPC separada **sem** custo, margem, identificador do fornecedor, notas internas ou dados administrativos. O painel da 6b usa Edge Function/RPC administrativa com autorização server-side, nunca apenas ocultação de rota.

Trigger `audit_trigger_func()` como na 071. **Operação sensível que exige motivo não depende do trigger genérico** — o motivo é campo obrigatório na própria action administrativa (alteração de custo, cancelamento, correção de ciclo, mudança de vínculo, confirmação de encerramento).

## 4. Lifecycle: dos 16 estados da spec original sobram 4

| Estado | Significado | Quem move |
|---|---|---|
| *(ausência de linha)* | Nunca registrada/provisionada. **Não criar estado `NEVER_PROVISIONED`** | — |
| `AWAITING_PROVISION` | Decidido/cobrado, ainda não criado no painel. **Bloqueado pelo gate §2 até a 6a** | admin |
| `ACTIVE` | Existe no painel, a plataforma paga, ciclo conhecido ou em revisão | admin |
| `CANCELLATION_REQUESTED` | Cancelamento pedido no painel. **Custo termina em `provider_access_until`; o serviço do cliente não** | admin, com motivo |
| `ENDED` | Morte confirmada no fornecedor | admin, após confirmação (§8.2) |

**Transições explícitas:**

- backfill de instância real existente → `ACTIVE`
- decisão futura de provisionar → `AWAITING_PROVISION` (hoje bloqueada pela constante)
- `ACTIVE` → `CANCELLATION_REQUESTED`
- `CANCELLATION_REQUESTED` → `ACTIVE` **somente** se o cancelamento foi revertido no fornecedor e há evidência
- `CANCELLATION_REQUESTED` → `ENDED` após confirmação administrativa
- `ENDED` **não volta** a `ACTIVE` silenciosamente: instância encerrada que reapareça no fornecedor exige reativação administrativa explícita (se o fornecedor preservou a mesma instância) ou **nova linha** (se é outra instância física)

**O que morreu dos 16, e por quê:** os estados de transição por API (`PROVISIONING`, `SUBSCRIBING`, `CANCELLING`) não existem quando a ação é um humano num painel — do ponto de vista do sistema ela é instantânea, e o que importa é o registro. Os de conexão (`WAITING_QR_CODE`, `CONNECTED`, `DISCONNECTED`) já são `whatsapp_channels.status`. Os de suspensão já são o gate da 5b, e replicá-los aqui é a família do bug 08.

**Fora do lifecycle, deliberadamente:** divergência é observação (`last_divergence_kind`), não estado. Custo pendente de revisão é status do **ciclo**, não da instância.

## 5. N instâncias por organização

Permitido, sem unicidade por `organization_id`, sem unicidade por assinatura e sem equivalência artificial "uma assinatura = uma instância".

O sistema **precisa conseguir revelar** o caso: uma assinatura de R$149, três instâncias pagas pela plataforma, três custos mensais, margem negativa. Isso é informação administrativa, não inconsistência de schema.

Gera **alerta** (nunca bloqueio automático):

- instâncias `ACTIVE`/`CANCELLATION_REQUESTED` acima do coberto pela política comercial;
- custo mensal agregado maior que a receita atribuível;
- instância ativa sem assinatura, override ou justificativa administrativa;
- mais de uma instância ativa para a mesma unidade;
- instância sem `unit_id` quando o modelo exige unidade.

Margem negativa **não bloqueia nada** — a decisão é administrativa.

## 6. O vencimento como fato, nunca como estimativa

### 6.1 Semântica das datas

```
cycle_start       date  — 1º dia coberto pelo pagamento              [INCLUSIVO]
provider_due_on   date  — dia da próxima cobrança do fornecedor      [= cycle_start do ciclo seguinte]
```

O ciclo cobre **`[cycle_start, provider_due_on)`** — início inclusivo, fim exclusivo. `provider_due_on` do ciclo N é exatamente `cycle_start` do ciclo N+1.

**Não existe campo `cycle_end`**: o nome admitia duas leituras ("último dia pago" vs "dia da próxima cobrança") e a diferença de um dia é justamente a que erra o D-7.

Todas as comparações de data civil em **America/Sao_Paulo**, reusando `todayBrt(nowMs)` de [_shared/billing-delinquency-core.ts:12](../../../supabase/functions/_shared/billing-delinquency-core.ts) — helper existente, testado, com clock injetável. **Não criar outro.** Nunca `new Date()` cru: o Deno roda em UTC e das 21h à meia-noite BRT o dia já virou.

### 6.2 `cycle_source` — como o sistema sabe a data

| Valor | Significado | D-7/D-1 saem? |
|---|---|---|
| `ADMIN_CONFIRMED` | O administrador informou ou confirmou explicitamente | Sim |
| `SYSTEM_ROLLED` | Rolagem a partir de um ciclo anterior confiável | Sim |
| `UNKNOWN` | Backfill sem data, ou "não sei" declarado | **Não.** Pendência `DATE_REVIEW_REQUIRED` |

`UNKNOWN` é o caminho honesto exigido: **data ausente não vira vencimento inventado, vira fila de revisão.** A instância aparece no painel com a pendência e gera aviso administrativo próprio; nenhum e-mail afirma uma data. Ausência de data **não é erro de implantação, não bloqueia o uso da instância existente e não gera data padrão.**

**Ação administrativa de confirmação da data** (transacional): registra a data confirmada e o `provider_cycle_anchor_day`, muda `cycle_source` para `ADMIN_CONFIRMED`, cria ou completa o ciclo aberto, registra autoria, timestamp e evidência/origem da informação, remove a pendência `DATE_REVIEW_REQUIRED` e libera D-7/D-1 daquele ciclo em diante.

### 6.3 `provider_cycle_anchor_day` — persistido, nunca re-derivado

O dia-âncora é **armazenado explicitamente**. Derivar continuamente o próximo vencimento a partir do `provider_due_on` atual perde informação em meses com clamp:

```
âncora 31 → 31/01 → 28/02 (ou 29/02) → 31/03 → 30/04 → 31/05
```

O clamp do mês corrente **nunca** substitui a âncora original.

- **Onde:** `whatsapp_instances.provider_cycle_anchor_day` (smallint, 1–31). Nome com prefixo `provider_` de propósito: neste projeto "billing" designa a cobrança do **cliente** (Asaas), e `billing_anchor_day` numa tabela de instância seria lido como o ciclo da mensalidade dele — a exata confusão de dois relógios que esta fase impede.
- **Preenchimento:** na ação administrativa de confirmação da data inicial.
- **Ambiguidade de fevereiro:** se a data confirmada cair em 28, 29 ou 30 e não for possível saber honestamente se houve clamp, o painel **pede confirmação explícita do dia-âncora** em vez de adivinhar.
- **Alteração:** auditada (valor anterior, novo, motivo, operador, data).
- **`cycle_source = UNKNOWN` não permite inferir a âncora automaticamente.**

### 6.4 Limite exato da rolagem

O ciclo está vencido quando:

```
todayBrt(now) >= provider_due_on
```

**Não** `>` — com fim exclusivo, `>` deixaria a rolagem um dia atrasada.

O helper puro recebe a data civil de referência (ou clock injetável) **explicitamente**, nunca lê o relógio por conta própria. Testes obrigatórios: antes do vencimento; exatamente no vencimento; depois do vencimento; virada UTC entre 21h e 00h no Brasil; meses de 28, 29, 30 e 31 dias; ano bissexto e não bissexto; reexecução idempotente do worker; concorrência entre duas execuções do worker.

## 7. Rolagem transacional e ciclos append-only

### 7.1 A operação única

Fechamento do ciclo vigente, abertura do próximo e projeção em `whatsapp_instances` são **uma única operação transacional e idempotente** — RPC `SECURITY DEFINER` restrita a `service_role`, no padrão já estabelecido (`revoke all ... from public, anon, authenticated` + `grant execute ... to service_role`, como em [try_giftback_lock](../../../supabase/migrations/20260517110000_giftback_hardening.sql)).

```
para cada instância ACTIVE com ciclo OPEN cujo provider_due_on já venceu (§6.4):

  1. ciclo vencido recebe closed_at
     ├─ tem provider_cost_cents?  → status CLOSED
     └─ não tem?                  → status PENDING_REVIEW      (custo desconhecido ≠ zero)
  2. abre o próximo: cycle_start      = provider_due_on do anterior
                     provider_due_on  = próxima data a partir de provider_cycle_anchor_day
                     provider_cost_cents = custo ATUAL da instância   ← congela na ABERTURA
                     customer_revenue_cents / revenue_source conforme §7.3
  3. projeta na instância: current_cycle_started_on, current_cycle_due_on,
                           cycle_source = 'SYSTEM_ROLLED'
```

**Nunca pode existir estado intermediário persistido** em que: o ciclo anterior fechou e o próximo não foi criado; dois ciclos estejam `OPEN`; `whatsapp_instances` aponte para datas diferentes do ciclo `OPEN`; o custo do novo ciclo seja obtido depois da abertura; uma reexecução abra o mesmo ciclo de novo.

### 7.2 `whatsapp_instance_cycles` — histórico imutável

Campos: `instance_id`, `cycle_start`, `provider_due_on`, `provider_cost_cents`, `customer_revenue_cents`, `gross_margin_cents`, `status` (`OPEN`\|`CLOSED`\|`PENDING_REVIEW`), `cost_source`, `revenue_source`, `cost_snapshot_at`, `customer_revenue_snapshot_at`, referência à assinatura ou ao cálculo que produziu a receita, `closed_at`, autoria, `notes`, timestamps.

**Sem credenciais e sem payloads secretos.**

Unicidade:

- `UNIQUE (instance_id, cycle_start)` — reexecução do fechamento não duplica;
- `UNIQUE (instance_id) WHERE status = 'OPEN'` — **nunca dois ciclos economicamente correntes**.

`PENDING_REVIEW` é **posterior** a `OPEN`, nunca concorrente: designa um ciclo que terminou mas não fechou financeiramente (custo ausente). Por isso não conflita com a unicidade de `OPEN`, e o ciclo seguinte pode abrir normalmente.

**Relação instância ↔ ciclos:** `current_cycle_started_on`/`current_cycle_due_on` na instância são **projeção operacional rápida** do ciclo `OPEN`; `whatsapp_instance_cycles` é a **fonte histórica**. Abertura e fechamento atualizam os dois pelo mesmo helper. Divergência entre a projeção e o ciclo `OPEN` gera alerta.

### 7.3 Custo, receita e margem

**Custo congelado na ABERTURA** do ciclo — representa o custo vigente quando a competência começou. Mudança em `whatsapp_instances.current_monthly_cost_cents` afeta **somente ciclos futuros**.

- ciclo `OPEN`: correção administrativa permitida **apenas** por ação específica, com motivo obrigatório, autoria, valor anterior, valor novo e auditoria;
- ciclo `CLOSED`/`PENDING_REVIEW`: imutável no fluxo comum; correção histórica só por operação administrativa específica e auditada, **nunca** `UPDATE` genérico;
- custo desconhecido: `NULL`, nunca zero; ciclo não fecha como financeiramente concluído; worker não inventa default. O valor de ~R$100 só vira default **se** houver confirmação comercial explícita.

**Receita atribuída** — a política existe porque N instâncias por organização é permitido:

| Situação da organização no ciclo | `customer_revenue_cents` | `revenue_source` |
|---|---|---|
| 1 instância + 1 assinatura de WhatsApp ativa | valor da assinatura | `SUBSCRIPTION_SOLE_INSTANCE` |
| N>1 instâncias + 1 assinatura | **`NULL`** | `AMBIGUOUS_MULTI_INSTANCE` |
| Override vitalício (Ren Sushi) | **`0`** — zero verdadeiro, não desconhecido | `LIFETIME_OVERRIDE` |
| Sem assinatura e sem override | `NULL` + alerta administrativo | `NO_ENTITLEMENT` |

**Nunca copiar os R$149 para cada instância** (inflaria a receita em N×) e **nunca ratear igualmente sem decisão comercial explícita**. Margem por instância existe só nos casos 1 e 3; nos demais a margem verdadeira é **consolidada por organização** (soma dos custos das instâncias contra a receita da assinatura). Rateio por instância, se um dia for desejado, exige regra versionada e auditável definida em spec.

**Fórmulas:**

```
gross_margin_cents      = customer_revenue_cents - provider_cost_cents
gross_margin_percentage = gross_margin_cents / customer_revenue_cents     (derivado, NUNCA armazenado)
```

O percentual **não é gravado**: é derivável de dois inteiros já persistidos, e um percentual armazenado só pode divergir deles. Apresentação: receita positiva → percentual; receita zero → "não aplicável"; receita `NULL` → "pendente". **Nunca exibir `0%` para valor desconhecido.**

Consequência imediata e desejada: o Ren Sushi aparece com margem **−(custo)/mês**, rotulada `LIFETIME_OVERRIDE`. Não é anomalia — é o custo real de uma decisão comercial, visível pela primeira vez.

## 8. Cancelamento

### 8.1 Congelamento no ato

Ao mover para `CANCELLATION_REQUESTED`, congelar `cancellation_requested_at`, `cancellation_requested_by`, `cancellation_reason` e `provider_access_until`. **`provider_access_until` não é recalculado silenciosamente a cada execução do worker.** Correção administrativa preserva o valor anterior, exige motivo e gera auditoria.

**Semântica de `provider_access_until`: EXCLUSIVO** — é o primeiro dia **não** coberto, idêntico em natureza a `provider_due_on`. O último dia de acesso real é `provider_access_until - 1 dia`. Escolha deliberada para não introduzir um segundo erro de um dia ao lado do já evitado em §6.1; a UI escreve "acesso até `<provider_access_until - 1>`" para o leitor humano.

**A rolagem para:** instância em `CANCELLATION_REQUESTED` **não abre ciclo novo** além de `provider_access_until`. O ciclo efetivamente coberto fecha normalmente.

**O cancelamento da instância NÃO pode:** alterar assinatura do cliente, modificar `organizations.billing_status`, alterar entitlement, suspender mensagens, apagar canal ou apagar credencial. Ele registra o término planejado do custo e da existência no fornecedor — nada mais.

### 8.2 "Worker propõe, admin confirma" — modelado, não implícito

O worker **não** move para `ENDED` só porque a data passou. Ao vencer `provider_access_until`:

1. registra `end_confirmation_required_at`;
2. mantém `lifecycle_state = CANCELLATION_REQUESTED`;
3. envia alerta ao platform admin;
4. o administrador verifica no painel do fornecedor e então confirma, preenchendo `ended_at`, `ended_by` e `end_confirmation_note` e movendo para `ENDED`.

Confirmação de encerramento é **processo de lifecycle**, não divergência — por isso campos próprios, e não `last_divergence_kind`. Se um dia houver API confiável do fornecedor, a automação poderá confirmar; isso **não pertence à 6b**.

## 9. Flags

**Remoção das três flags órfãs** criadas na [migration 061](../../../supabase/migrations/20260716130000_061_platform_flags.sql) para a API de Parceiro: `zapi_auto_provisioning`, `zapi_auto_disconnect`, `zapi_auto_cancel`. Nenhum código as lê (grep confirma), os nomes prometem automação inexistente, e `platform_flags` deve representar controle operacional existente, não ideia futura.

**Correção factual registrada:** a migration 061 **já foi aplicada em produção** (2026-07-16, Fase 1, commit `ca957c7` — [FASE-1-RESUMO.md](../../billing-asaas/FASE-1-RESUMO.md)). As três flags são linhas vivas hoje, não seed pendente. Editar a 061 causaria drift em `schema_migrations` e exigiria `migration repair` — proibido pelo CLAUDE.md. Portanto a remoção é feita por **migration corretiva nova**, com o rodapé de rastreabilidade exigido: nomes reservados, motivo da remoção, ausência de consumidor, e a condição para recriação (só junto de automação real, com consumidor, testes, auditoria e rollback). Bloco SQL apenas **comentado**, nunca configuração ativa.

Verificações após a remoção: a migration não insere nenhuma das três; nenhuma consulta, tipo ou UI depende delas; nenhum teste espera sua presença; o painel não exibe controle sem efeito; a busca pelos nomes encontra apenas documentação e comentário; a migration é idempotente; nenhuma flag viva foi removida por engano.

**Nenhuma flag nova nesta fase até aqui** — as flags da 5b (`whatsapp_service_enforcement`, `billing_invoice_ingestion`) e da 5a (`whatsapp_implementation_flow`, `whatsapp_subscription_checkout`) permanecem OFF; ligá-las é decisão do dono, fora do escopo desta spec. O Asaas permanece em **sandbox** até a última fase.

---

## Seções pendentes

- **C** — worker de ciclo e alertas (D-7 sempre; D-1 condicional; dedupe por `instância + ciclo + tipo`; destinatários só `platform_admin`), detecção de divergência reaproveitando o caminho de status já existente, e painel administrativo (estimado × realizado, decisão do Partner).
- **D** — validação em três camadas (interna executável hoje; leitura do fornecedor ao vivo contra o canal existente, sem escrita; escrita no fornecedor declarada **inexecutável** com protocolo de evidência para a primeira ocorrência real), segurança/RLS, gates `saas-shield-br`, checklist de redeploy, rollout e rollback.

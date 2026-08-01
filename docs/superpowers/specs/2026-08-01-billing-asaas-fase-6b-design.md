# Fase 6b — Ciclo de vida da instância de WhatsApp (Z-API), fluxo manual assistido

> **Status: EM ELABORAÇÃO.** Seções A, B e C aprovadas pelo dono. Seção D (validação, segurança, rollout, rollback) pendente de apresentação e aprovação.
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

## 10. Worker, alertas, divergência e painel (Seção C — aprovada)

### 10.1 Um worker, não vários

`process-whatsapp-instance-cycles`, agendado em **`10 12 * * *` UTC** (09:10 BRT), no padrão obrigatório: `pg_cron` → wrapper `trigger_*` `SECURITY DEFINER` lendo `internal_api_key` do Vault → `pg_net.http_post` com `x-internal-key`.

Um worker e não vários porque os cinco passos leem o mesmo conjunto de instâncias e ciclos: separá-los faria três varreduras da mesma tabela decidindo sobre estados que o passo anterior acabou de mudar.

**Ressalva de UTC, registrada de propósito:** o `pg_cron` agenda em UTC fixo. Hoje o Brasil não tem horário de verão, então `12:10 UTC` = `09:10 BRT`; se o horário de verão voltar, o horário civil desloca e **ninguém será avisado disso pelo sistema**. Isso é aceitável aqui porque **nenhum veredito depende da hora do cron**: toda decisão de data compara contra `todayBrt(now)` ([billing-delinquency-core.ts:12](../../../supabase/functions/_shared/billing-delinquency-core.ts)), então rodar às 09:10 ou às 10:10 BRT muda a hora em que o alerta chega, nunca se ele deve existir. O horário 12:10 e não 12:00 evita colidir com `process-voucher-triggers` (`0 12 * * *`).

### 10.2 Ordem interna e isolamento de falha

```
1. rolagem dos ciclos vencidos (§7)          ← precede tudo: muda as datas que os passos 2-3 leem
2. alertas D-7                                (sempre)
3. alertas D-1                                (condicional — só com motivo)
4. confirmação de encerramento pendente       (END_CONFIRMATION_REQUIRED, §8.2)
5. divergências passivas + desequilíbrio econômico por organização
```

Regras de isolamento, verificáveis em revisão:

- falha em um passo **não** aborta os seguintes;
- falha em uma instância **não** aborta as demais instâncias do mesmo passo;
- toda falha loga com `needsAdminAction: true` quando exigir olho humano — o padrão já aplicado no hotfix do Risco 7 ([process-billing-overdue/index.ts:68](../../../supabase/functions/process-billing-overdue/index.ts));
- o worker responde 200 com o resumo por passo mesmo com falha parcial. `pg_net` é fire-and-forget e não faz retry por status; devolver 500 não recuperaria nada e apagaria o resumo. **O sinal de falha é a telemetria, não o código HTTP.**

### 10.3 Lock: reaproveitado, e explicitamente não é a garantia

Reaproveita o padrão advisory do giftback ([try_giftback_lock](../../../supabase/migrations/20260517110000_giftback_hardening.sql):70) com chave própria: `pg_try_advisory_lock` em função `SECURITY DEFINER`, `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role`, release no `finally`, **falha aberta**.

Registro honesto do que esse lock é e não é: advisory lock é **session-scoped** e não sobrevive de forma confiável ao pooling transaction-mode do PgBouncer em holds de vários segundos — foi exatamente por isso que o lock de conversa usa TTL em coluna e não advisory ([migration 056](../../../supabase/migrations/20260610150000_056_conversation_ai_lock.sql)). Aqui isso é aceitável porque **a correção não depende do lock**: a garantia real é a RPC transacional de rolagem (§7.1) mais `UNIQUE (instance_id, cycle_start)` e `UNIQUE (instance_id) WHERE status = 'OPEN'` (§7.2). Duas execuções simultâneas não podem abrir ciclo duplicado nem com o lock perdido. O lock economiza trabalho; ele não é o invariante.

### 10.4 `whatsapp_instance_alerts` — o ledger

Tabela nova, `FORCE RLS` **sem policies**, lida só via Edge Function — padrão das tabelas administrativas. Não guarda credencial nem payload de provedor.

**Chave de assunto em dois campos, não em `instance_id`:** `subject_type` (`INSTANCE` \| `ORGANIZATION`) + `subject_id`. Alerta econômico pertence à **organização**, e chavear tudo por instância obrigaria a **eleger uma instância arbitrária para representar um desequilíbrio da organização** — o que seria falso e produziria alertas que apontam para o lugar errado. `organization_id` fica denormalizado em todas as linhas (inclusive nas de instância) para escopo de consulta e auditoria; `instance_id` é `NULL` quando `subject_type = 'ORGANIZATION'`.

Campos: `subject_type`, `subject_id`, `organization_id`, `instance_id` (nullable), `alert_type`, `dedupe_key`, `status`, `first_detected_at`, `last_seen_at`, `occurrences`, `last_reminder_at`, `acknowledged_at`/`acknowledged_by`, `resolved_at`/`resolved_by`, `resolution_note`, `payload` (jsonb, sem segredo), `dispatch_enabled_at_enqueue`, timestamps.

`UNIQUE (subject_type, subject_id, alert_type, dedupe_key)`.

**Por que o ledger carrega o próprio tempo e a própria contagem:** verificado no ambiente real — `billing_notifications` **não tem `created_at` nem contador de tentativa**. Hoje não existe telemetria capaz de detectar uma fila de avisos parada. O ledger não repete esse defeito: `first_detected_at`, `last_seen_at`, `occurrences` e `last_reminder_at` são dele, e permitem responder "há quanto tempo isto está aberto sem ninguém olhar" sem depender da fila.

**Ciclo de vida:** `OPEN` → `ACKNOWLEDGED` (admin viu; interrompe o lembrete, não fecha o fato) → `RESOLVED` (o fato deixou de existir, ou o admin resolveu com nota). `SUPERSEDED` quando o fato mudou de forma e virou outro alerta. **Fato que desaparece sozinho é resolvido automaticamente com nota do sistema — nunca apagado.** O histórico de alerta é registro administrativo.

**Dedupe e lembrete, por tipo:**

| Tipo | `dedupe_key` | Reemissão |
|---|---|---|
| D-7 | `cycle_start` do ciclo `OPEN` | Nenhuma — um por ciclo |
| D-1 | `cycle_start` + motivos ordenados | Só se o **conjunto de motivos** mudar |
| Confirmação de encerramento | `provider_access_until` | Lembrete **mensal** enquanto `OPEN` |
| Divergência | assinatura do fato divergente | Lembrete **mensal** enquanto o fato persistir |
| Custo desconhecido | `cycle_start` do ciclo em `PENDING_REVIEW` | Lembrete **mensal** |
| Desequilíbrio econômico | mês de competência | Um por mês, por organização |

Lembrete **reemite o aviso e incrementa `occurrences`; não cria linha nova.** Cadência mensal e não diária pela mesma razão que descartou o alerta diário na janela dos 7 dias: **aviso diário treina o administrador a ignorar.**

### 10.5 D-7 sempre, D-1 condicional, D-3 não existe

- **D-7** — sempre, um por ciclo. É o alerta que dá tempo de cancelar no painel da Z-API antes da próxima cobrança. Este é o produto da fase.
- **D-1** — **condicional**: só existe se `resolveD1Reasons(...)` devolver ao menos um motivo (ciclo com custo desconhecido, divergência aberta, cancelamento pretendido e não registrado, receita `NULL` fora dos casos previstos). Sem motivo, silêncio.
- **D-3 não existe.** Três avisos para a mesma data é a cadência que produz cegueira.

`resolveD1Reasons` é **núcleo puro** — zero imports, importável tanto pela Edge Function quanto por vitest a partir de `src/`. Um único `import` de `esm.sh`, mesmo `import type`, quebra a resolução do Vite e derruba a suíte inteira.

**Destinatário: apenas `platform_admin`.** O lojista não conhece o ciclo da Z-API — para ele, esse calendário não existe — e o aviso da mensalidade dele já existe desde a 5b (`process-billing-reminders`). Mandar o calendário do fornecedor para o cliente seria expor custo interno.

**Conteúdo proibido no alerta:** credencial, token, client token, conteúdo de conversa e dado pessoal do cliente final. O alerta nomeia organização, rótulo interno da instância, data e ação esperada — nada mais.

**Registrado, não escondido:** `resolvePlatformAdminRecipients` para no **primeiro** e-mail utilizável ([billing-notify.ts:101-146](../../../supabase/functions/_shared/billing-notify.ts)). Para aviso administrativo isso é aceitável; deixa de ser no dia em que houver mais de um administrador que precise ser avisado. Fica anotado como limitação conhecida, não como comportamento desejado.

### 10.6 Os seis `event_type` e o acoplamento por string

`admin_zapi_cycle_due_soon` · `admin_zapi_cycle_due_tomorrow` · `admin_zapi_end_confirmation_required` · `admin_zapi_instance_divergence` · `admin_zapi_cycle_cost_unknown` · `admin_zapi_org_economic_imbalance`

Cada um exige entrada em `TEMPLATE_BY_EVENT` de `process-billing-notifications` **no mesmo commit e com deploy conjunto**. As duas funções não compartilham nenhum arquivo `_shared/` para esse acoplamento — é só a string. Sem a entrada, as linhas morrem em `failed/unknown_event_type`. É a **quarta ocorrência** do mesmo padrão (já registrado no CLAUDE.md para `process-asaas-invoice-reconcile`, `process-whatsapp-enforcement` e `manage-billing`).

**Evidência verificada no ambiente real: `billing_notifications_dispatch` está OFF.** Consequência aceita e deliberada: nesta fase o **painel é a superfície viva dos alertas**, e a fila acumula. Por isso o ledger é **independente da fila** — ele registra o alerta mesmo com o dispatcher parado, e grava `dispatch_enabled_at_enqueue = false` para que ninguém leia "não recebi e-mail" como "não houve alerta".

### 10.7 Divergência é passiva; o teste ativo continua onde já está

**O worker nunca chama a Z-API.** Ele compara fatos já presentes no banco. A chamada real ao provedor permanece exclusiva do caminho existente e acionado por humano — `manage-channels` action `test` e `whatsapp-health`.

> **Não copiar lógica de chamada ao provider para `manage-whatsapp-instances` nem para `process-whatsapp-instance-cycles`.**

As cinco divergências:

| Tipo | Fato |
|---|---|
| `CHANNEL_WITHOUT_INSTANCE` | Canal `connected` sem instância registrada — **custo invisível**, o mais caro dos cinco: pagamos sem rastro |
| `INSTANCE_WITHOUT_CHANNEL` | Instância `ACTIVE` sem canal vinculado vivo |
| `INSTANCE_REF_MISMATCH` | `provider_instance_ref` da instância ≠ identificador presente no canal (§3) |
| `LIFECYCLE_VS_CHANNEL_STATE` | Estado de lifecycle contradiz o estado do canal |
| `CYCLE_PROJECTION_MISMATCH` | `whatsapp_instances.current_cycle_*` ≠ ciclo `OPEN` (§7.2) |

**Ajuste semântico obrigatório em `LIFECYCLE_VS_CHANNEL_STATE`:** canal desconectado **não é divergência por si só** — o cliente pode ter derrubado o celular, e isso é rotina operacional, não inconsistência de cadastro. Vira divergência quando **persiste além de um limiar** e contradiz o lifecycle (instância `ACTIVE` com canal caído há muito tempo; instância `ENDED` ou com `provider_access_until` vencido e canal ainda `connected`).

**Nenhuma divergência gera ação automática.** Todas geram linha no ledger. Não há cancelamento automático, desconexão automática ou correção automática de cadastro nesta fase.

### 10.8 Desequilíbrio econômico pertence à organização

`subject_type = 'ORGANIZATION'`. Compara a soma dos custos conhecidos das instâncias da organização no mês contra a receita atribuída (§7.3).

- **`LIFETIME_OVERRIDE` não é erro.** Margem negativa do Ren Sushi é o custo conhecido de uma decisão comercial: aparece rotulada no painel e **nunca** vira alerta de anomalia.
- Alerta quando: organização com instância `ACTIVE` sem assinatura e sem override (`NO_ENTITLEMENT`), ou receita conhecida menor que custo conhecido fora do caso de override.
- Receita `NULL` (`AMBIGUOUS_MULTI_INSTANCE`) **não** é desequilíbrio — é dado ausente, e é apresentado como "pendente", nunca como prejuízo.

### 10.9 Painel `/platform/instancias-whatsapp` — três camadas

1. **Rota** sob `/platform/*`, exclusiva de `platform_admin` (`App.tsx`);
2. **Edge Function** `manage-whatsapp-instances` valida `platform_admin` no JWT, com `verify_jwt = true` explícito em `config.toml`;
3. **RLS `FORCE` sem policies** nas tabelas da fase — nem `authenticated` lê direto; o acesso é só pela EF.

**Projeção segura, não filtro tardio:** a EF devolve **lista explícita de colunas**, nunca `select("*")` moldado depois. É a lição já paga duas vezes — o vazamento de `billing_email` por privilégio de coluna ([migration 086](../../../supabase/migrations/20260731170000_086_anon_column_grants.sql)) e o molde de `ORG_BILLING_PUBLIC_COLUMNS` em `manage-billing`: campo novo entra por `select("*")` e vaza sozinho.

Conteúdo: ciclo vigente e vencimento, custo, receita atribuída e rótulo da fonte, margem (percentual **derivado**, §7.3), **estimado × realizado**, alertas abertos por assunto, e o simulador do Partner.

**Ações administrativas** — criar e editar instância, corrigir data de ciclo, informar custo, solicitar cancelamento, confirmar encerramento, reconhecer e resolver alerta. Toda ação que altere fato financeiro, data ou estado exige **motivo obrigatório na própria ação**, autoria, valor anterior e valor novo, e gera auditoria. Motivo não é campo opcional preenchido depois.

### 10.10 Simulador do Partner — simulação rotulada, sem preço inventado

Responde "a partir de quantas instâncias o Plano Partner compensa" usando **apenas** custo real registrado nos ciclos e um **preço-alvo do Partner informado pelo administrador no momento da simulação**.

- **Nunca** constante de preço no código, nunca valor "de mercado", nunca estimativa embutida — a Z-API não publicou preço de Partner para nós, e um número inventado viraria base de decisão comercial;
- rotulado explicitamente como **simulação**, jamais como projeção do sistema;
- **não escreve nada** — nem instância, nem ciclo, nem alerta.

É o que transforma a decisão do Partner de palpite em conta, que era o item (e) do briefing.

### 10.11 `verify_jwt` — verificação obrigatória antes do deploy

| Função | `verify_jwt` | Por quê |
|---|---|---|
| `process-whatsapp-instance-cycles` | **`false`**, entrada explícita | Worker `pg_cron`; sem a entrada, o gateway responde 401 antes do `requireInternalAuth` e o cron silencia — `pg_net` é fire-and-forget |
| `manage-whatsapp-instances` | **`true`**, entrada explícita | EF de super-admin, defesa em profundidade |

Ambas as entradas entram em `supabase/config.toml` **antes** do primeiro deploy, não depois.

---

## Seções pendentes

- **D** — validação em três camadas (interna executável hoje; leitura do fornecedor ao vivo contra o canal existente, sem escrita; escrita no fornecedor declarada **inexecutável** com protocolo de evidência para a primeira ocorrência real), segurança/RLS, gates `saas-shield-br`, checklist de redeploy, rollout e rollback.

# Fase 6b — Ciclo de vida da instância de WhatsApp (Z-API), fluxo manual assistido

> **Status: COMPLETA.** Seções A, B, C e D aprovadas pelo dono. Pronta para `superpowers:writing-plans`.
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

O helper puro recebe a data civil de referência (ou clock injetável) **explicitamente**, nunca lê o relógio por conta própria. Casos obrigatórios (enumerados, sem contagem resumida — a lista é a especificação):

1. antes do vencimento;
2. exatamente no vencimento;
3. depois do vencimento;
4. virada UTC entre 21h e 00h BRT;
5. mês de 28 dias;
6. fevereiro bissexto, 29 dias;
7. mês de 30 dias;
8. mês de 31 dias;
9. preservação do dia-âncora após *clamp* (§6.3);
10. reexecução idempotente.

**Concorrência não entra aqui.** Duas execuções simultâneas são um fato de banco, não de aritmética de calendário — simular no núcleo puro provaria apenas que o mock foi escrito de acordo. O caso vive na camada de integração (§11.2).

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

Campos: `subject_type`, `subject_id`, `organization_id`, `instance_id` (nullable), `channel_id` (nullable — só `CHANNEL_WITHOUT_INSTANCE` a preenche, ver §10.7), `alert_type`, `dedupe_key`, `status`, `first_detected_at`, `last_seen_at`, `occurrences`, `last_reminder_at`, `acknowledged_at`/`acknowledged_by`, `resolved_at`/`resolved_by`, `resolution_note`, `payload` (jsonb, sem segredo), `dispatch_enabled_at_enqueue`, timestamps.

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

`admin_zapi_cycle_d7` · `admin_zapi_cycle_d1_action_required` · `admin_zapi_end_confirmation_required` · `admin_zapi_date_review_required` · `admin_zapi_divergence` · `admin_zapi_economic_imbalance`

**Fonte canônica única:** `EVENT_TYPE_BY_ALERT` em [_shared/whatsapp-instance-alerts-core.ts](../../../supabase/functions/_shared/whatsapp-instance-alerts-core.ts). Nenhum produtor emite string fora dela, e a lista não é redigitada em teste nem em documentação executável.

**`admin_zapi_cycle_cost_unknown` NÃO existe** — custo desconhecido não ganha `event_type` próprio nesta fase. Ele é pendência financeira visível no painel (ciclo em `PENDING_REVIEW`) e entra como **motivo do D-1** (`COST_UNKNOWN` em `resolveD1Reasons`), que é quando vira acionável: há uma cobrança chegando. Criar um tipo só porque um valor está `NULL` multiplicaria avisos sem multiplicar decisão.

**`admin_zapi_date_review_required` existe e é enviável.** Instância com `cycle_source = UNKNOWN` não recebe D-7, mantém pendência visível no painel, gera esta ocorrência, recebe **no máximo um lembrete por mês** enquanto a data continuar desconhecida — garantido pelo `dedupe_key` no formato `<YYYY-MM BRT>:<instance_id>`, que abre ocorrência nova a cada mês em vez de reemitir a mesma linha — e tem **todas** as ocorrências abertas resolvidas quando data e âncora forem confirmadas. O texto do aviso não afirma data alguma: ele diz que a data falta.

Cada um exige entrada em `TEMPLATE_BY_EVENT` de `process-billing-notifications` **no mesmo commit e com deploy conjunto**. As duas funções não compartilham nenhum arquivo `_shared/` para esse acoplamento — é só a string. Sem a entrada, as linhas morrem em `failed/unknown_event_type`. É a **quarta ocorrência** do mesmo padrão (já registrado no CLAUDE.md para `process-asaas-invoice-reconcile`, `process-whatsapp-enforcement` e `manage-billing`).

**Evidência verificada no ambiente real: `billing_notifications_dispatch` está OFF.** Consequência aceita e deliberada: nesta fase o **painel é a superfície viva dos alertas**, e a fila acumula. Por isso o ledger é **independente da fila** — ele registra o alerta mesmo com o dispatcher parado, e grava `dispatch_enabled_at_enqueue = false` para que ninguém leia "não recebi e-mail" como "não houve alerta".

### 10.7 Divergência é passiva; o teste ativo continua onde já está

**O worker nunca chama a Z-API.** Ele compara fatos já presentes no banco. A chamada real ao provedor permanece exclusiva do caminho existente e acionado por humano — `manage-channels` action `test` e `whatsapp-health`.

> **Não copiar lógica de chamada ao provider para `manage-whatsapp-instances` nem para `process-whatsapp-instance-cycles`.**

**Vocabulário canônico — cinco tipos, sem sobreposição:**

| Tipo | Fato | Pergunta que ele faz |
|---|---|---|
| `CHANNEL_WITHOUT_INSTANCE` | Canal operacional existente sem registro correspondente no inventário de instâncias | "Estou pagando algo que não está no inventário?" — **custo invisível**, o mais caro dos cinco |
| `PAYING_WITHOUT_CHANNEL` | Instância `ACTIVE` no inventário sem `channel_id` associado | "Estou pagando por algo que ninguém usa?" |
| `INSTANCE_REF_MISMATCH` | `provider_instance_ref` do inventário diverge do identificador legado usado pelo canal (§3) | "O inventário aponta para a instância certa?" |
| `LIFECYCLE_VS_CHANNEL_STATE` | Instância `ACTIVE` com canal conhecido persistentemente fora de `connected` pelo limiar de sete dias completos | "O cliente perdeu o WhatsApp?" |
| `ALIVE_AFTER_END` | Instância `ENDED`, mas sinais locais **posteriores** indicam que canal ou integração pode continuar existindo | "O encerramento aconteceu de verdade lá fora?" |

**Decisões de vocabulário registradas:**

- `PAYING_WITHOUT_CHANNEL` substitui o nome anterior `INSTANCE_WITHOUT_CHANNEL` — diz a consequência, não a topologia.
- `CHANNEL_WITHOUT_INSTANCE` e `PAYING_WITHOUT_CHANNEL` são **direções opostas do mesmo eixo** e ambos existem: o primeiro é canal sem registro de inventário, o segundo é instância `ACTIVE` sem canal. Sem o primeiro, um *backfill* incompleto — do Ren Sushi ou de qualquer instância legada — permaneceria fora do inventário e, portanto, fora do acompanhamento de custo.
- `ALIVE_AFTER_END` foi **separado** de `LIFECYCLE_VS_CHANNEL_STATE`, que antes acumulava os dois sentidos. São perguntas operacionais diferentes: uma é sobre o cliente, a outra é sobre o fornecedor e sobre custo que deveria ter cessado. Manter juntas era exatamente a sobreposição que o vocabulário precisa eliminar.
- `CHANNEL_DOWN_WHILE_PAYING` **não existe** nesta spec e não deve ser criado — a condição é `LIFECYCLE_VS_CHANNEL_STATE`.
- `CYCLE_PROJECTION_MISMATCH` **não é divergência** e sai desta tabela: `whatsapp_instances.current_cycle_*` ≠ ciclo `OPEN` é violação de invariante interno (§7.2), não desencontro com o mundo. Vira falha de consistência com `needsAdminAction: true` na telemetria do worker, no passo 5 (§10.2), sem entrar no vocabulário de divergência.
- **`SILENT_CHANNEL` sai da fase e não é substituído por nome equivalente.** Não há definição honesta e verificável dentro da fronteira desta fase: "canal conectado sem tráfego há N dias" mede **uso**, não consistência entre inventário, *lifecycle* e estado operacional — e um restaurante pode passar dias sem mensagens sem que exista falha, custo indevido ou divergência técnica. Implementá-lo exigiria definir o que conta como tráfego, ler conversas ou eventos, escolher limiar arbitrário, distinguir sazonalidade de falha e ampliar o worker para uma fonte que não é inventário nem custo — tocando informação operacional e de mensageria desnecessária aqui. **Sem placeholder, sem enum morto, sem constante de limiar, sem teste planejado.** Se um dia houver necessidade de saúde por ausência de atividade, ela entra em spec própria de observabilidade operacional, com definição de evento, janela, sazonalidade, privacidade e ação esperada.

**`CHANNEL_WITHOUT_INSTANCE` — divergência administrativa, nunca inferência:**

Ela **não** cria `whatsapp_instances` automaticamente, **não** presume custo, **não** presume vencimento, **não** altera o canal, **não** altera entitlement, **não** bloqueia envio e **não** chama o provedor. Pede revisão e eventual *backfill* manual.

A detecção usa **apenas evidência persistida e confiável**, e antes de abrir o alerta confirma que o canal representa integração real que deveria estar no inventário. **Não gera alerta para:** registro técnico incompleto · canal de teste descartado · canal explicitamente desativado · registro que não representa instância faturável · registro já associado a uma instância por outro vínculo canônico.

**Havendo ambiguidade** sobre se o canal representa instância real, abre revisão administrativa — **nunca** cria inventário automaticamente.

*Dedupe* e sujeito, já que `subject_type = 'INSTANCE'` não se aplica quando a instância ainda não existe:

- `subject_type = 'ORGANIZATION'`, `subject_id = organization_id`, `instance_id = NULL` — **nenhuma instância fictícia é escolhida**;
- `dedupe_key = channel_without_instance:<channel_id>:<YYYY-MM BRT>`, que carrega a identidade estável do canal;
- **`subject_type = 'CHANNEL'` não é criado nesta fase.** Expandir o enum exigiria revisar RLS, *constraints*, consultas e painel, e o escopo `ORGANIZATION` já é suficiente e menos expansivo.

**Decisão sobre `channel_id` no ledger: sim, coluna `channel_id uuid null references whatsapp_channels(id) on delete set null`.** O ganho é concreto e não é duplicação decorativa: o painel precisa mostrar *qual* canal está fora do inventário e ligá-lo à unidade, e a resolução por *backfill* precisa da referência — extrair isso de dentro do `dedupe_key` por parsing de string seria frágil e não indexável. `on delete set null` preserva a linha do ledger, que é registro de auditoria e não pode ser apagada em cascata; a identidade textual sobrevive no `dedupe_key`. A coluna é `NULL` em todos os outros tipos de alerta.

**Resolução:** o canal é associado por *backfill* a uma `whatsapp_instance` válida · ou é confirmado como não faturável / fora de escopo · ou o registro é encerrado administrativamente com motivo.

**`ALIVE_AFTER_END` — evidência local, nunca afirmação sobre cobrança:**

Ele significa apenas que **há evidência local incompatível com o encerramento registrado**. Sinais aceitáveis: status local voltou a `connected` depois de `ended_at` · action `test` posterior encontrou integração viva · `last_event_at` posterior ao encerramento · outro sinal operacional persistido após a transição para `ENDED`. Sinal **anterior** a `ended_at` não conta.

A mensagem é **"Há sinais posteriores ao encerramento registrado. Verifique o estado real no provider."** — nunca "A Z-API continua cobrando". A resolução é administrativa e **não reativa a instância automaticamente**.

**Limiar de `LIFECYCLE_VS_CHANNEL_STATE`:**

Canal desconectado **não é divergência por si só** — o cliente pode ter derrubado o celular, e isso é rotina operacional. Vira divergência quando **todas** as condições valem:

1. `lifecycle_state = ACTIVE`;
2. estado do canal persistentemente diferente de `connected`;
3. **último estado conhecido**, com idade suficiente — status ausente ou nunca sincronizado **não** é interpretado como desconectado há sete dias;
4. sem explicação administrativa já registrada;
5. o sétimo dia **completo** transcorrido.

`LIFECYCLE_CHANNEL_DIVERGENCE_DAYS = 7` — constante única em núcleo puro, documentada, **jamais repetida em outro arquivo** e **sem `platform_flag` própria nesta fase**. Cálculo por data/hora consistente com clock injetável nos testes.

O valor é **parâmetro operacional inicial, não verdade comercial**: sete dias é *baseline* prudente enquanto não há histórico de estabilidade do Ren Sushi. Revisão futura exige spec própria com evidência, não ajuste no código.

Desconexão **abaixo** do limiar pode aparecer como informação no painel, mas **não** abre alerta lógico de divergência.

**Resolução, para o alerta não oscilar:** só por evidência persistida de canal `connected` novamente, ou por administrador que resolva/dispense com motivo. A action `test` manual atualiza o estado observado e a próxima avaliação do worker resolve a divergência.

**Nenhuma divergência gera ação automática.** Nenhuma altera `lifecycle_state`, nenhuma cancela instância, nenhuma bloqueia envio, e **nenhuma afirma que a Z-API continua cobrando** — todas pedem revisão. Todas geram linha no ledger.

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

## 11. Validação, segurança, rollout e rollback (Seção D — aprovada)

### 11.0 A prova de reconstrução do banco, e o que ela mudou

Antes de decidir onde os testes de integração rodam, a spec exigia provar se o histórico de migrations reconstrói o banco. **A prova foi executada.** Resultado, com o método de cada afirmação:

| Verificação | Resultado | Como foi obtido |
|---|---|---|
| Tabelas de produção criadas por migration | **48 de 48** | `information_schema.tables` do projeto real × `create table` extraído dos 112 arquivos. As 49 declaradas menos `admin_users`, dropada em migration |
| Tabela criada fora de migration (Studio/dashboard) | **Nenhuma** | mesmo cruzamento |
| Versões duplicadas ou faltando | **Nenhuma** — 112 arquivos, 112 linhas em `schema_migrations` | `list_migrations` × nomes de arquivo |
| Dados de produção embutidos em migration | **Nenhum** — zero UUID literal | varredura por literal UUID |
| **URL do projeto de produção embutida em migration** | **13 arquivos** | `grep` por `gbabxcrntkwgblgqsiit` |
| `create extension pg_net` | **Ausente**, embora 13 migrations usem `net.http_post` | `grep` |
| Vault (`vault.create_secret`, `vault.decrypted_secrets`) | Assumido presente **e semeado** | `grep` |

**A boa notícia é estrutural:** o schema é integralmente derivado de migrations. Não há a dívida clássica de objeto criado no Studio e nunca versionado.

**Correção de veredito (achada durante a implementação, 2026-08-01).** A tabela acima mede *o que o histórico contém*. Sobre *se ele roda*, a resposta já existia no repositório e esta prova não a alcançou: **o replay foi tentado em 2026-07-30 e falhou.**

> `42P13 — cannot change return type of existing function` — **54 migrations usam `create or replace function` para alterar retorno tabular contra apenas 4 que usam `drop function`.** Evidência em [docs/hotfix-acl/03-ENSAIO-ORDEM-REAL.md §1](../../hotfix-acl/03-ENSAIO-ORDEM-REAL.md), e a mesma constatação está no cabeçalho do job `acl-com-banco` e de [scripts/function-acl-allowlist.test.ts](../../../scripts/function-acl-allowlist.test.ts). **Supabase Branch não resolve** — ele também replaya do zero e estoura no mesmo ponto.

Portanto `EXECUTION_UNVERIFIED` estava **errado por otimismo**: não é que a execução não foi verificada, é que **ela já foi verificada e reprovou**, por uma causa que nada tem a ver com as URLs. São **dois bloqueios independentes**, e consertar um não destrava o outro.

**O segundo bloqueio, o das URLs, continua valendo e é mais sério do que "as migrations talvez não subam":**

```sql
project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
```

Os *wrappers* `trigger_*` de `pg_cron` **embutem a URL de produção**. Um banco local ou de staging reconstruído por este histórico, com `pg_cron` ativo, agenda jobs que fazem `POST` **nas Edge Functions de produção**. A reconstrução não é apenas incerta — **executá-la como está é perigoso**. Some-se a isso: `pg_net` é assumido pré-instalado, e o Vault é assumido semeado com `internal_api_key`, que num banco novo não existe.

**Veredito (corrigido):** `SCHEMA_DERIVED_FROM_MIGRATIONS / REPLAY_FAILS_42P13 / UNSAFE_AS_IS`.

O veredito anterior — `SCHEMA_REBUILD_LIKELY_OK / EXECUTION_UNVERIFIED / UNSAFE_AS_IS` — fica registrado como **errado no termo do meio**, e a correção está no bloco acima. A prova estática desta seção continua válida: ela é forte sobre *o que o histórico contém* (48 de 48 tabelas versionadas, zero dado de produção, treze URLs embutidas) e era silenciosa sobre *se ele roda* — silêncio que o ensaio de 2026-07-30 já tinha preenchido com um NO-GO.

Consequência prática: **nada muda no plano** (§11.2 permanece `ENVIRONMENT_BLOCKED` de qualquer forma, e produção segue fora de questão), mas o motivo passa a ser dois e a frente estrutural ganha um terceiro item obrigatório.

**Isto não é resolvido dentro da Fase 6b.** Fica registrado como frente estrutural separada, com seu próprio ciclo de spec:

> **`BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`** — **destravar o replay, que hoje estoura em `42P13` (54 `create or replace function` alterando retorno tabular contra 4 `drop function`)** · eliminar chamada acidental para produção durante reconstrução local · parametrizar *endpoints* de Edge Functions · controlar `pg_cron` em ambiente local · declarar a dependência de `pg_net` · declarar ou preparar o Vault · permitir execução real das migrations em ambiente descartável · impedir que job local chame produção.

O primeiro item é **pré-requisito dos demais**: enquanto o replay não completar, não existe banco descartável onde os outros possam ser testados. Ele também é o mais caro — corrigir exige revisar as 54 migrations que trocam retorno tabular sem `drop function` antes.

**As migrations já aplicadas não são alteradas silenciosamente.** A correção futura avaliará: migrations compensatórias · *wrappers* que leiam configuração segura · Vault ou *settings* por ambiente · desativação de cron durante *rebuild* · proteção contra URL de produção em ambiente não produtivo · teste estático no CI que rejeite nova URL de projeto *hardcoded* · estratégia compatível com o histórico já aplicado. Os treze arquivos ficam registrados aqui para a frente futura:

`022_reservation_source` · `029_outbox_cron` · `043_giftback_cron` · `045_reservation_automation_cron` · `048_waitlist_automation` · `storage_orphan_cleanup_cron` · `stripe_expire_payments_cron` · `billing_crons` · `billing_trial_auto` · `064_process_asaas_reconcile_cron` · `069_process_billing_notifications_cron` · `082_cron_asaas_invoice_reconcile` · `083_cron_whatsapp_enforcement`

**O que a 6b deve garantir é só isto: nenhuma migration nova repete o padrão.** Gate estático sobre os arquivos novos desta fase — nenhuma URL de projeto Supabase *hardcoded* · nenhum *endpoint* de produção · nenhum segredo · nenhum cron apontando para ambiente fixo.

### 11.1 Camada 1 — núcleos puros, executável hoje no CI

Zero dependência de banco, de rede e de provedor. Grupos por responsabilidade:

**A. Rolagem de calendário** — os dez casos enumerados em §6.4. Concorrência **não** pertence a este grupo.

**B. `resolveD1Reasons`** — retorno determinístico; códigos estáveis; sem duplicação; **nenhum motivo ⇒ lista vazia** (é o que torna o D-1 condicional, §10.5); problema resolvido entre D-7 e D-1 elimina o alerta; `GRACE_PERIOD` **não** vira cancelamento automático; `CANCELLATION_REQUESTED` gera motivo próprio; override expirando considera data civil correta; múltiplos motivos mantêm ordem definida.

**C. Receita e margem (§7.3)** — `SUBSCRIPTION_SOLE_INSTANCE`; `AMBIGUOUS_MULTI_INSTANCE`; `LIFETIME_OVERRIDE`; `NO_ENTITLEMENT`; **receita `NULL` ≠ receita zero**; percentual **não aplicável** quando a receita é zero; percentual **pendente** quando a receita é `NULL`; margem consolidada da organização sem duplicar receita.

**D. Dedupe (§10.4)** — `cycle_d7`, `cycle_d1`, `end_confirmation_required`, `date_review_required`, `divergence`, `economic_imbalance`; hash econômico determinístico; **ordem diferente das mesmas instâncias produz o mesmo hash**; mudança material de composição produz hash diferente; campo volátil não altera o hash.

**E. Divergências (§10.7)** — os cinco tipos canônicos, por tipo:

- **`CHANNEL_WITHOUT_INSTANCE`** — canal elegível sem instância correspondente **gera**; canal já associado **não** gera; canal desativado ou fora de escopo **não** gera; informação insuficiente **gera revisão, sem inferência automática**.
- **`PAYING_WITHOUT_CHANNEL`** — instância `ACTIVE` sem `channel_id` **gera**; `AWAITING_PROVISION` **não** é tratada da mesma forma; `ENDED` **não** gera este tipo; *backfill* explicitamente pendente segue a severidade definida.
- **`INSTANCE_REF_MISMATCH`** — referências diferentes **geram**; iguais **não**; valor ausente **não** vira *mismatch* automaticamente; **nenhuma correção automática** ocorre.
- **`LIFECYCLE_VS_CHANNEL_STATE`** — `ACTIVE` + desconectado há menos de sete dias **não** gera; sete dias completos **gera**; status desconhecido **não** gera; `connected` resolve; clock injetável e **limite exato** testados.
- **`ALIVE_AFTER_END`** — `ENDED` com sinal posterior **gera**; sem sinal posterior **não** gera; sinal anterior a `ended_at` **não** gera; **não** altera *lifecycle* automaticamente.

**Nenhum teste de `SILENT_CHANNEL`** — o tipo não existe (§10.7).

**F. Simulador Partner (§10.10)** — preço-alvo obrigatório; zero e negativo recusados; cenário não altera custo real; cálculo de economia; ponto de equilíbrio; nenhuma persistência; rótulo de simulação explícito.

### 11.2 Camada 1b — integração com banco, **nunca contra produção**

Prova o que teste unitário não alcança, porque **a regra vive no banco**. Foi exatamente o que o hotfix do Risco 7 demonstrou: a classificação estava certa, e a retenção não persistia porque o `UPDATE` violava um `CHECK`. Nenhum mock teria pego.

**Candidatos:** `UNIQUE (instance_id, cycle_start)` · no máximo um ciclo `OPEN` por instância · `UNIQUE (subject_type, subject_id, alert_type, dedupe_key)` do ledger · atomicidade da RPC de rolagem · duas rolagens simultâneas · `FORCE RLS` · `authenticated` sem leitura · `anon` sem leitura · `anon`/`authenticated` sem `EXECUTE` na RPC · `service_role` com `EXECUTE` · integridade cross-tenant · transições de lifecycle (§4) · *constraints* de custo, datas e status · requisitos de `enforcement_hold`, se alguma estrutura compartilhada for usada.

**Todo teste negativo carrega controle positivo** — sem ele, "nada aconteceu" passa por sucesso, e uma EF quebrada é aprovada como se fosse defesa funcionando:

| Negativo | Controle positivo obrigatório |
|---|---|
| `authenticated` não lê | `service_role` lê |
| `anon` não executa a RPC | `service_role` executa |
| segunda rolagem simultânea não cria ciclo | rolagem legítima cria |
| *subject* duplicado é rejeitado | combinação diferente é aceita |
| instância de outra organização é rejeitada | instância coerente é aceita |

Limpeza em `teardown`/`finally`, **mesmo com falha de assertion**.

**Ambiente, por ordem de preferência:** (1) Supabase local descartável reconstruído pelas migrations; (2) projeto Supabase separado de teste/staging; (3) banco temporário criado para o job; (4) roteiro manual em produção — só para evidência inalcançável nos anteriores.

**Consequência direta de §11.0:** a opção (1) está **bloqueada** enquanto a URL de produção estiver embutida nos *wrappers*, e a máquina de trabalho não tem CLI nem Docker. Portanto, nesta fase:

- os grupos de §11.1 rodam **normalmente no CI**;
- os testes de §11.2 nascem **escritos e marcados `ENVIRONMENT_BLOCKED`**, com o bloqueio nomeado — não são silenciados nem apagados, e **não fingem execução**;
- validação de migration e ACL roda em banco descartável ou ambiente isolado, quando existir;
- eles saem de `ENVIRONMENT_BLOCKED` quando a frente `BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT` entregar o ambiente, sem reabrir esta spec.

**O texto do `ENVIRONMENT_BLOCKED` é obrigatório e literal — "infra indisponível" não serve:**

> Rebuild não executado porque o ambiente local não possui Supabase CLI/Docker/psql e migrations com wrappers de `pg_cron` contêm URL de produção, tornando a execução local insegura sem isolamento prévio.
>
> **Emenda (§11.0, correção de veredito):** o rebuild também **não completaria se o ambiente existisse** — o replay foi tentado em 2026-07-30 e reprovou com `42P13 — cannot change return type of existing function` (54 `create or replace function` alterando retorno tabular contra 4 `drop function`). São dois bloqueios independentes; consertar as URLs não destrava o replay.

A primeira frase é o texto que o dono ditou e fica intacta. A emenda existe porque a frase "rebuild não executado" descreve esta máquina, e não o histórico do projeto — onde ele **foi** executado e falhou.

### 11.3 Proibição explícita: produção não é ambiente de teste

**Teste de integração com fixtures em produção não vira rotina da suíte.** O teste do Risco 7 foi intervenção pontual, de alto risco financeiro, explicitamente autorizada, acompanhada e limpa. **Ter funcionado não transforma produção em ambiente permanente de testes.**

Razões, registradas para que a decisão não seja reaberta por conveniência: falha de *cleanup* deixaria fixture administrativa; teste concorrente colidiria com worker real; `FORCE RLS`, cron, *triggers* e notificações produziriam efeito não previsto; id ou organização de teste apareceria no painel; alteração futura no código tornaria destrutivo um teste hoje seguro; o CI não deve possuir credencial de produção capaz de criar e remover dados; e **sucesso na limpeza não prova ausência de efeito colateral** em log, alerta, auditoria ou job concorrente.

**Exceção — validação pontual em produção.** Só com **todos** os critérios satisfeitos: não existir ambiente alternativo capaz de provar o comportamento; ser necessária para um GO operacional; haver autorização explícita **para aquela execução específica**; usar apenas organizações *sandbox* identificadas; **Ren Sushi e Moralles nunca como fixture**; *snapshot* prévio dos registros envolvidos; avaliação dos cron e workers concorrentes; registro dos ids das fixtures; *cleanup* determinístico; auditoria posterior; **nenhuma** chamada externa ao provedor; **nenhum** envio de e-mail ou mensagem; **nenhuma** alteração de billing real; **nenhuma** criação ou cancelamento de instância.

**Nunca acionada pelo CI, nunca automática em merge ou deploy.**

### 11.4 Camada 2 — leitura do fornecedor, ao vivo

Executável hoje contra o canal existente do Ren Sushi, **usando exclusivamente os caminhos que já existem**: `manage-channels` action `test` e `whatsapp-health`, acionados por humano. **Nenhuma integração externa nova é escrita nesta fase.**

**Precisão obrigatória de linguagem — não é "zero escrita" em termos absolutos.** A action `test` pode atualizar dados **locais** já previstos pelo fluxo (status, `last_error`, `last_tested_at`). O correto é:

- **zero escrita no fornecedor**; zero criação, alteração ou cancelamento na Z-API;
- leitura ativa do provedor pelo caminho existente;
- eventual atualização **local** dos campos já previstos pelo fluxo de teste;
- nenhuma implementação nova de integração externa.

**Registro obrigatório:** executor · data e hora · action utilizada · `provider_instance_ref` esperado · identificador legado lido, **mascarado** · status antes · status depois · veredito · campos locais alterados pelo teste · confirmação de ausência de escrita no provedor.

**Nunca registrar** token, *client token* ou URL contendo segredo.

**`INSTANCE_REF_MISMATCH` — regra de manuseio.** A comparação entre `provider_instance_ref` e o identificador dentro de `credentials` continua permitida **apenas** no caminho administrativo autorizado, e: não copiar o segredo nem o objeto `credentials` inteiro; extrair somente o identificador necessário; **não escrever de volta automaticamente**; **não escolher silenciosamente qual referência está correta**; divergência exige revisão humana; correção exige motivo, operador e auditoria; e a referência operacional nova **não substitui** o identificador legado da mensageria antes da 6a.

### 11.5 Camada 3 — escrita no fornecedor: `PROVIDER_WRITE_VALIDATION_NOT_EXECUTABLE_IN_PHASE_6B`

Não há *sandbox* de parceiro; o *trial* de dois dias vale só na primeira instância da conta, e a conta já tem instância; criar instância real custa dinheiro e é proibido antes de pagamento confirmado; cancelamento só se prova cancelando algo em uso.

**Declarado não executável nesta fase:** criar instância no provedor · contratar instância · observar cobrança real de instância nova · cancelar instância real · confirmar fim de acesso no provedor · validar *trial* de primeira instância · validar eventual preço Partner · validar alteração automática de vencimento no fornecedor.

Isso é **limitação conhecida**, registrada com o status acima. **Não marcar como `FAILED`** — falha sugere defeito a corrigir; aqui não há o que corrigir, há um ambiente que não existe.

Esta declaração é a correção direta do erro da Fase 5, onde o roteiro de *sandbox* foi escrito e só depois se descobriu inexecutável no provedor. **A limitação é declarada antes, não descoberta depois.** E o desenho já assume que o fornecedor não é observável: é por isso que o vencimento é fato corrigível com `cycle_source` (§6.2) e que a confirmação de encerramento é humana (§8.2).

### 11.6 Protocolo da primeira ocorrência real

A primeira criação e o primeiro cancelamento reais **são validações operacionais obrigatórias, com checklist e GO/NO-GO** — não operação comum.

**Criação:** autorização e pagamento confirmados · **Fase 6a concluída** · data e hora · operador · organização e unidade · provedor · custo informado · vencimento observado · data e âncora cadastradas · **previsão do sistema × resultado real** · divergências · correções · evidências sanitizadas · confirmação de que nenhum segredo entrou no documento.

**Cancelamento:** solicitação administrativa · motivo · `provider_access_until` esperado · data real de encerramento · cobrança final observada · comportamento do ciclo · abertura de `END_CONFIRMATION_REQUIRED` · confirmação humana no provedor · transição para `ENDED` · **previsão × ocorrido** · correções.

### 11.7 Segurança e RLS

`FORCE RLS` sem policies de acesso direto de tenant · acesso administrativo só por Edge Function · projeção por **lista explícita de colunas** · `organization_id` obrigatório nas três tabelas · validação cross-tenant server-side · `SECURITY DEFINER` · `search_path` explícito · revogação de `PUBLIC`, `anon` e `authenticated` · `grant` somente a `service_role` · **allowlist de ACL atualizada no mesmo PR**.

**Ajuste sobre `search_path`:** `set search_path = public` pode ser insuficiente se a função tocar extensão ou schema auxiliar. Conferir o padrão real do projeto e usar o **menor `search_path` explícito necessário**. `search_path` implícito é proibido.

A migration revoga **tanto `PUBLIC` quanto grants diretos** — é o defeito que originou o hotfix de ACL da [085](../../../supabase/migrations/20260730160000_085_harden_public_function_acl.sql). Função nova em `public` nasce executável por `anon` pelo grant implícito do `CREATE FUNCTION`.

**O que `secret-hunter` precisa provar** (o contrato negativo de §0.3 é verificável, não declaratório): `whatsapp_instances` sem coluna de token · `whatsapp_instance_cycles` sem segredo · `whatsapp_instance_alerts` sem e-mail duplicado · log sem `credentials` · payload de erro sanitizado · `provider_instance_ref` tratado como identificador operacional · nenhum arquivo novo acessando credenciais além do reaproveitamento administrativo aprovado em §11.4 · **o worker não importa cliente Z-API** · **o worker não faz `fetch` externo**.

### 11.8 Gates `saas-shield-br`

`migration-validator` · `rls-auditor` · `tenant-isolation-auditor` · `identity-access-auditor` · `secret-hunter` · `integration-reliability-auditor`.

**Resultados apresentados individualmente** — "gates verdes" não é relatório. *Finding* alto ou crítico é **NO-GO**. *Finding* médio exige correção **ou** aceite explícito com justificativa e *follow-up* nomeado.

### 11.9 Ordem exata de migration, deploy, validação, backfill e cron

O acoplamento por `event_type` (§10.6) determina a ordem: **dispatcher e templates primeiro, produtor depois.** Como `billing_notifications_dispatch` está OFF, não haverá envio — mas `unknown_event_type` ainda precisa ser evitado, porque marca a linha como `failed` e mata o aviso.

1. **Migrations** (`supabase db push` — nunca SQL colado no Studio);
2. **Validação de schema, grants e RLS** aplicados;
3. `process-billing-notifications` **com os seis templates novos**;
4. `manage-whatsapp-instances`;
5. `process-whatsapp-instance-cycles`;
6. **Validações de autorização** nas actions administrativas;
7. **Painel** `/platform/instancias-whatsapp`;
8. **Backfill do Ren Sushi** (§11.10);
9. **Conferência dos dados** cadastrados;
10. **Execução manual controlada do worker**;
11. **Inspeção do ledger e dos ciclos** gerados;
12. **Criação e agendamento do cron** (`10 12 * * *` UTC);
13. Observação diária;
14. Observação de um ciclo completo.

**Migration antes das Edge Functions**, sempre: coluna ainda inexistente vira 400 do PostgREST e derruba gate *fail-closed* — foi o que aconteceu com `manage-channels`. E **o cron só existe depois** que worker e dispatcher estão publicados e o worker já rodou uma vez sob observação humana.

**Gate antes do passo 8 (*backfill*):** nenhuma falha alta ou crítica nos auditores · worker ainda **sem cron** · actions administrativas validadas · nenhum acesso direto por `authenticated` · nenhuma chamada externa nova.

**Gate antes do passo 12 (cron):** *backfill* conferido · execução manual **idempotente** · nenhuma duplicação de ciclo ou alerta · nenhuma alteração de `billing_status` · nenhuma alteração de entitlement · nenhuma chamada ao provedor · telemetria sanitizada · *rollback* por desagendamento documentado.

**Checklist de redeploy (CLAUDE.md, mesmo PR):** núcleos puros novos → `process-whatsapp-instance-cycles` e `manage-whatsapp-instances`. Se algum consumir `billing-notify.ts`, entra na linha dele. Nenhum `_shared/` existente é alterado nesta fase; se virar necessário, a linha correspondente é atualizada no mesmo PR.

### 11.10 Backfill do Ren Sushi

Nasce assim, e **não é cadastrado logo após publicar o painel** — só depois de validados RLS, actions administrativas, *constraints*, worker sem registros, cron ainda inexistente, estado das flags e ausência de chamada externa:

- `lifecycle_state = ACTIVE`;
- `cycle_source = UNKNOWN` enquanto a data não for confirmada;
- `provider_due_on` **ausente**;
- alerta `DATE_REVIEW_REQUIRED` aberto;
- custo real informado, se conhecido;
- `revenue_source = LIFETIME_OVERRIDE`, `customer_revenue_cents = 0`;
- **margem negativa visível** — é o custo conhecido de uma decisão comercial (§10.8), não anomalia;
- nenhuma criação no provedor · nenhuma alteração no canal existente · nenhuma mudança de entitlement.

Só **depois** de confirmar data e âncora: `cycle_source = ADMIN_CONFIRMED`, ciclo `OPEN` coerente, custo congelado, e alertas de ciclo habilitados para avaliações futuras.

### 11.11 Rollout: por que não há flag própria

**Decisão: a Fase 6b não cria flag própria.** A fase não altera envio ao cliente, não altera `organizations.billing_status`, não altera entitlement, não chama o provedor automaticamente, não cria nem cancela instância — e o cron pode ser desagendado na hora. Criar flag agora aumentaria a quantidade de controles sem consumidor duradouro, **na mesma fase que remove três flags `zapi_auto_*` nascidas sem automação end-to-end** (§9).

**Freio operacional aprovado, em ordem:** desagendar `process-whatsapp-instance-cycles` → manter tabelas e registros intactos → impedir novas ações administrativas sensíveis, se o defeito estiver nelas → corrigir o código → redeploy → **reagendar somente após novo GO**.

**Duas proibições de flag indireta:**

- **Não usar `billing_notifications_dispatch` como flag da fase.** Ela controla apenas o envio de e-mail; ledger e painel funcionam com ela OFF.
- **Não condicionar cálculo ou persistência de ciclo a `whatsapp_service_enforcement`.** Aquela flag controla consequência operacional da 5b, não inventário nem custo da 6b.

Estado das flags ao fim da fase, inalterado: `whatsapp_service_enforcement` OFF · `whatsapp_implementation_flow` OFF · `whatsapp_subscription_checkout` OFF · `billing_notifications_dispatch` OFF · Asaas em *sandbox*.

### 11.12 Rollback

Desagendar o cron é o freio de primeira linha — efeito imediato, sem deploy. Além dele:

- desabilitar temporariamente ações sensíveis no painel por deploy, se o defeito estiver nelas;
- **preservar todas as linhas para auditoria**;
- **não apagar ciclos ou alertas para "voltar ao verde"**;
- **não alterar lifecycle diretamente por SQL**;
- não desfazer migrations destrutivamente em produção sem análise;
- tabelas aditivas ficam instaladas mesmo se a interface for retirada.

**Regra herdada do Risco 7: NO-GO não é corrigido "no dado" para manter o rollout verde.**

**Sobre as três flags `zapi_auto_*` (§9)** — antes de remover, reconfirmar: nenhum consumidor no código · nenhum cron ou RPC lendo os nomes · nenhum *dashboard* externo · nenhuma documentação operacional dependente · nenhuma consulta manual recorrente. *(Verificação atual: o `grep` encontra os nomes apenas na própria migration 061 e em documentação da fase — nenhum consumidor de código.)*

A migration de reversão **não pode depender apenas de comentário no rodapé**: registra os valores anteriores e entrega migration de restauração pronta, ou instrução versionada inequívoca.

### 11.13 O gate da 6a entra como teste

`NEW_REAL_INSTANCE_PROVISIONING_BLOCKED_UNTIL_PHASE_6A` (§2) precisa de teste que **prove** o bloqueio — não confiar em disciplina manual nem em aviso de interface. Mínimo:

| Deve **passar** | Deve **bloquear** |
|---|---|
| registro de instância existente / backfill | criação de instância real nova |
| update administrativo | `AWAITING_PROVISION` inicial |
| teste de conexão | contorno pelo frontend |
| rotação de segredo pelo fluxo legado, se já autorizada | contorno por chamada direta à EF |
| — | ambiguidade entre backfill e criação nova ⇒ **bloqueia** |

E ainda: **nenhuma flag de banco desativa silenciosamente a constante**; o erro retornado é explícito e **não expõe segredo**; e há **controle positivo** — uma ação realmente permitida precisa concluir, provando que o teste não está diante de uma EF quebrada.

---

## Estado da spec

Seções **A, B, C e D fechadas** pelo dono. A spec está completa para transição a `superpowers:writing-plans`.

Decisões finais consolidadas: `CHANNEL_WITHOUT_INSTANCE` permanece · `SILENT_CHANNEL` sai · a lista canônica tem **cinco** divergências · integração recorrente com banco permanece `ENVIRONMENT_BLOCKED` · produção não vira ambiente de testes · o *baseline* reproduzível é frente separada · o *rollout* segue a ordem aprovada com os dois gates · **nenhuma flag própria da 6b** · limiar de `LIFECYCLE_VS_CHANNEL_STATE` em sete dias · `billing_notifications_dispatch` OFF · `whatsapp_service_enforcement` OFF · **nenhuma escrita no provedor**.

O plano de implementação deve preservar integralmente as Seções A–D, dividir a execução em etapas pequenas e verificáveis, colocar migrations antes das EFs, templates antes do produtor, cron por último, marcar claramente os testes `ENVIRONMENT_BLOCKED` sem transformá-los em verde falso, incluir *rollback* e evidência por etapa, **não** ampliar escopo para corrigir as treze migrations antigas, abrir o *baseline* reproduzível como *follow-up* separado, e **não** tocar envio, credenciais, entitlement ou `billing_status`.

Pendências herdadas, fora do escopo desta fase e registradas para não se perderem:

- **`BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT`** (§11.0) — parametrizar `project_url` nos 13 *wrappers* de cron, declarar `pg_net`, semear Vault de teste. Enquanto não existir, os testes de §11.2 permanecem `ENVIRONMENT_BLOCKED`.
- **Fase 6a** — provisionamento real, criptografia de credenciais e liberação do gate de §2.

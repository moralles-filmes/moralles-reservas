# Fase 5b — Elo financeiro da renovação + enforcement por serviço

> Spec de design aprovada em 2026-07-27.
> Plano-mãe: [docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md § FASE 5](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md).
> Fase anterior: [FASE-5A-RESUMO.md](../../billing-asaas/FASE-5A-RESUMO.md) (mergeada em `main`, tag `billing-asaas/fase-5a`).
> Spec da 5a: [2026-07-25-billing-asaas-fase-5a-design.md](2026-07-25-billing-asaas-fase-5a-design.md).
> API verificada: [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md).

---

## 1. O achado que redefine a fase

A 5b nasceu como "suspender quem não paga os R$ 149". Ao mapear onde a fatura vencida da instância apareceria, o levantamento encontrou que **ela nunca aparece** — e que o mesmo vale para a mensalidade do sistema (R$ 449). Três elos ausentes, todos verificados no código:

| Elo | Estado atual | Efeito |
|---|---|---|
| `PAYMENT_CREATED` | classificado como informativo ([asaas-billing-events.ts:138](../../../supabase/functions/_shared/asaas-billing-events.ts)) | a cobrança da renovação nasce no Asaas e não vira linha em `billing_invoices` |
| `PAYMENT_OVERDUE` | só faz `UPDATE` de fatura existente ([asaas-billing-events-apply.ts:969](../../../supabase/functions/_shared/asaas-billing-events-apply.ts)) | sem linha correlacionada, é no-op por contrato |
| Correlação da renovação | escada é `externalReference` → `customer` → `checkoutSession` | a renovação do mês 2+ não carrega nenhum dos três; só carrega `subscription: "sub_…"`, para o qual **não existe degrau** |

E `process-billing-reconcile` é Stripe puro (`retrieveStripeSubscription` / `retrieveStripeInvoice`, filtros `.not("stripe_*_id","is",null)`) — não existe reconciliação de cobranças em aberto no Asaas.

**Consequência:** `process-billing-overdue`, `process-billing-reminders` e `process-billing-unblock` rodam diariamente sobre entrada vazia no mundo Asaas. A escada de dias e os gates de categoria construídos na 4b e na 5a estão corretos e testados; falta o que alimenta a fila. Nenhuma assinatura Asaas chegou ao segundo ciclo ainda, então nada disso apareceu como incidente.

Por isso a 5b entrega o motor inteiro, em três partes internas entregues e validadas juntas:

- **5b.1 — Elo financeiro:** correlação por assinatura, fatura da renovação, normalização financeira, reconciliação Asaas, freio da primeira varredura.
- **5b.2 — Enforcement por serviço:** os sete estados do serviço de WhatsApp, gate central de envio, gate do agente, gate de novo provisionamento, worker de inadimplência da instância, estacionamento de jobs, modo dry-run.
- **5b.3 — Regularização:** restauração pós-pagamento, revalidação dos jobs estacionados, avisos, superfície no cliente e no painel.

---

## 2. Escopo

### Dentro da 5b

1. Quarto degrau de correlação por `provider_subscription_id`, com escada determinística e ordem explícita.
2. Divergência de organização entre degraus como **falha**, não aviso.
3. `PAYMENT_CREATED` passa a criar a fatura interna em aberto (idempotente).
4. Camada de normalização financeira: nomes do Asaas não entram no núcleo puro.
5. Worker de reconciliação Asaas (bidirecional, idempotente).
6. `enforcement_hold` com motivo, autoria e liberação auditada.
7. Núcleo puro dos sete estados do serviço de WhatsApp, com o estado do sistema como gate pai.
8. Gate central de envio, gate do agente, gate de novo provisionamento.
9. Grandfathering com concessão, auditoria e revogação terminal.
10. Worker de inadimplência e restauração da instância de WhatsApp.
11. Estacionamento e revalidação de jobs.
12. Modo dry-run com a flag de enforcement desligada.
13. Avisos de cobrança específicos do WhatsApp e aviso ao administrador em ambiguidade.
14. Banner e estado do serviço na superfície do cliente; painel de faturas retidas.

### Fora da 5b

| Item | Fase |
|---|---|
| Provisionamento real na Z-API, QR code, status da instância, reconexão e reprovisionamento da mesma instância | 6 |
| Carteira de IA: saldo, débito, limite patrocinado | 7 |
| Recarga automática de IA | 8 |
| UI genérica de overrides das três features; worker de expiração de `TEMPORARY` | 9 |
| Fluxo explícito de reimplantação (segunda implantação para a mesma org) | pós-5b |
| Remoção do parâmetro legado `mode` em `create-billing-checkout` | follow-up independente |

**"Campanhas" não existe neste produto.** Não há fila de campanha e nunca houve — já registrado na spec da 5a. Os fluxos automáticos reais são cinco: `notification_outbox` (confirmação/cancelamento), lembretes D-0, pesquisas D+1, gatilhos de voucher e fila de espera. Onde a diretriz do controlador diz "campanhas", esta spec lê "os cinco fluxos automáticos".

---

## 3. Decisões aprovadas

1. **O elo financeiro e o enforcement são entregues juntos.** Testar enforcement com fatura criada à mão não prova que o primeiro ciclo real de renovação funciona.
2. **Correlação nunca por valor, data aproximada ou "assinatura mais recente".** Só identificadores do provedor.
3. **Ambiguidade é falha alta.** Sem escolha silenciosa, sem escrita em entitlements, sem escrita em `organizations.billing_status`, com aviso ao administrador e evento retido na fila.
4. **O estado do sistema é gate pai obrigatório.** Override de WhatsApp nunca mantém envio quando o sistema está operacionalmente suspenso.
5. **Ausência de direito não bloqueia envio nesta fase; ausência de direito bloqueia novo provisionamento.**
6. **A flag de enforcement não altera o estado calculado** — só a consequência operacional.
7. **`enforcement_hold` é excepcional, não a regra.** Fatura descoberta tarde por falha temporária preserva vencimento e tolerância reais.
8. **Suspensão do WhatsApp jamais escreve `organizations.billing_status`.** Invariante herdado da 5a, reafirmado aqui.

---

## 4. Estado do qual esta fase parte

| Fato | Consequência para a 5b |
|---|---|
| `billing_subscriptions.status` já aceita `unpaid`, e `ALLOWED_SUB_STATUSES` do núcleo é `{active, trialing, past_due}` ([entitlements-core.ts:86](../../../supabase/functions/_shared/entitlements-core.ts)) | suspender = `status='unpaid'`; o entitlement de `whatsapp` vira `false` **sem nenhuma alteração no núcleo** |
| `unpaid` não é `canceled` | a RPC `resolve_or_activate_subscription` continua encontrando a assinatura suspensa e não cria uma segunda |
| UNIQUE `(provider, provider_payment_id)` em `billing_invoices` e UNIQUE `(provider, provider_subscription_id)` em `billing_subscriptions` já existem ([063](../../../supabase/migrations/20260716130200_063_billing_provider_columns.sql)) | idempotência da ingestão e do degrau 2 são garantidas pelo banco, não por código |
| `sendWhatsApp` ([_shared/whatsapp-send.ts](../../../supabase/functions/_shared/whatsapp-send.ts)) é ponto único de todos os envios não-agente — 4 EFs, com os 5 fluxos automáticos atrás delas | um único gate cobre tudo que não é o agente |
| O agente usa `sendOutbound` direto em `webhook-whatsapp` (10 call sites) | precisa de gate próprio, na entrada, ao lado do `org_billing_blocked` que já existe |
| `entitlements.system.allowed` é `false` para organização legada com `billing_status='active'` e sem assinatura de sistema | **o gate pai NÃO pode usar `system.allowed`** — usa `organizations.billing_status`, que é a coluna autoritativa |
| `entitlements.whatsapp.allowed` é `false` para toda org sem assinatura nem override | **o gate de envio NÃO pode ser `!allowed`** — daí os sete estados |
| Deno não está instalado no ambiente de desenvolvimento | nada dentro de `supabase/functions/` roda em CI; toda lógica decisória vai para núcleo puro importado por vitest de `src/lib/*.test.ts` |
| Único cliente ativo é vitalício grátis (Ren Sushi, override LIFETIME de `system` e `whatsapp`); Moralles é a plataforma | nenhuma suspensão real acontece nesta fase; a validação é sandbox |

---

## 5. Parte 5b.1 — Elo financeiro

### 5.1 Escada de correlação

Ordem determinística. Cada degrau preenche **apenas os campos ainda não resolvidos** por um degrau superior:

| # | Fonte | Identificador | Resolve |
|---|---|---|---|
| 1 | fatura já conhecida | `provider_payment_id` | org, assinatura, plano, purpose |
| 2 | assinatura do provedor | `subscription` (`sub_…`) → `billing_subscriptions.provider_subscription_id` | org, assinatura, plano, categoria, `purpose='subscription'` |
| 3 | referência externa | `externalReference` → `org:<uuid>|plan:<uuid>|purpose:<x>` | org, plano, purpose |
| 4 | sessão de checkout | `checkoutSession` → `billing_checkout_sessions.provider_checkout_id` | org, plano, purpose |
| 5 | cliente do provedor | `customer` → `billing_customers.asaas_customer_id` | só org |

O degrau 2 é o que não existe hoje e é o que destrava a renovação. O degrau 5 desce para o fim (hoje é o segundo) porque resolve menos: manter a ordem atual faria um `customer` conhecido curto-circuitar o `checkoutSession`, que traz plano e purpose.

**A ausência de sessão de checkout não impede o processamento.** A renovação do mês 2+ é resolvida integralmente pelo degrau 2.

### 5.2 Divergência e ambiguidade

Núcleo puro novo — `supabase/functions/_shared/billing-correlation-core.ts`, zero imports, testado por vitest a partir de `src/lib/billing-correlation-core.test.ts`.

Recebe os candidatos que a camada de I/O conseguiu levantar e decide:

```ts
export type CorrelationSource =
  | "known_invoice" | "provider_subscription" | "external_reference"
  | "checkout_session" | "billing_customer";

export interface CorrelationCandidate {
  source: CorrelationSource;
  organizationId: string | null;
  subscriptionId: string | null;   // id interno de billing_subscriptions
  planId: string | null;
  purpose: string | null;
}

export type CorrelationOutcome =
  | { kind: "resolved"; organizationId: string; subscriptionId: string | null;
      planId: string | null; purpose: string | null; via: CorrelationSource[] }
  | { kind: "unresolved"; reason: "no_candidate" }
  | { kind: "conflict"; reason: "organization_divergence";
      sources: { source: CorrelationSource; organizationId: string }[] };
```

Regras:

- **Divergência de organização entre quaisquer dois candidatos → `conflict`.** O aplicador transforma isso em `failed`: o evento continua na fila e nada é escrito. Escrever no tenant errado é pior que atrasar um pagamento. Hoje esse caso apenas loga (`asaas_checkout_session_org_mismatch`, introduzido na 5a); a 5b promove a falha.
- **Divergência de plano ou de purpose → o degrau superior vence, com log `warn`.** Não é fatal: um plano pode ter sido trocado entre a criação da sessão e o pagamento.
- **Nenhum candidato com organização → `unresolved`.** O aplicador degrada para `failed`, e o reconcile tenta de novo.
- **Duas assinaturas não-canceladas da mesma categoria** continuam sendo erro alto da RPC `resolve_or_activate_subscription` (`ambiguous_subscription_category`), inalterado desde a 5a. O degrau 2 não pode ser ambíguo: a UNIQUE `(provider, provider_subscription_id)` garante no máximo uma linha.

Toda ambiguidade e toda divergência de organização **avisam o administrador** (§10.2).

### 5.3 Fatura da renovação

`PAYMENT_CREATED` sai de `INFORMATIONAL_EVENTS` e ganha efeito próprio: `upsert_open_invoice`.

Efeito:

1. Roda a escada de correlação.
2. Se não resolver a organização → `failed`, evento fica na fila.
3. `INSERT` em `billing_invoices` com `provider='asaas'`, `provider_payment_id`, `organization_id`, `billing_subscription_id`, `status='open'`, `amount_cents` (convertido de reais — `asaasValueToCents`), `due_date` (campo `dueDate` do payload), `payment_method`, `purpose`, `external_reference`, `ingestion_source='WEBHOOK'`.
4. `ON CONFLICT (provider, provider_payment_id) DO NOTHING` — o webhook e o reconcile podem encontrar o mesmo pagamento; o primeiro cria, os demais reutilizam.

Consequências deliberadas:

- A primeira cobrança de um checkout também passa a nascer como fatura `open`, e o `PAYMENT_RECEIVED` posterior a liquida pelo caminho que já existe. O `INSERT` de fatura que hoje mora dentro do `activate_subscription` ([apply:738](../../../supabase/functions/_shared/asaas-billing-events-apply.ts)) vira caminho de contingência, não o normal.
- Cobrança de implantação (R$ 750, `purpose='implementation'`) também vira fatura `open`. `isSystemInvoice` já devolve `false` para esse purpose, então ela nunca governa o acesso ao sistema.
- **A partir daí `process-billing-overdue` passa a ter entrada real.** É por isso que a ingestão fica atrás de flag própria (§9).

### 5.4 Normalização financeira

O núcleo puro não conhece nomes do Asaas. Núcleo novo — `supabase/functions/_shared/billing-financial-state-core.ts`, importando apenas o núcleo puro `billing-delinquency-core.ts` (constantes `GRACE_PERIOD_DAYS` / `BLOCK_AFTER_DAYS` e helpers de data em BRT). Nenhum dos dois toca Deno ou supabase-js.

```ts
export type FinancialState =
  | "NO_SUBSCRIPTION"      // não há assinatura da categoria
  | "PAID"                 // em dia
  | "IN_GRACE"             // vencida, dentro da tolerância
  | "OVERDUE_BEYOND_GRACE" // vencida além da tolerância → suspender
  | "CANCELED";            // assinatura cancelada

export interface FinancialStateInput {
  now: string;                       // ISO; injetável nos testes
  subscriptionStatus: string | null; // active|trialing|past_due|canceled|unpaid|paused|null
  canceledAt: string | null;
  /** Fatura em aberto mais antiga da assinatura, já filtrada por enforcement_hold=false. */
  oldestOpenInvoice: { dueDate: string; status: string } | null;
}

export interface FinancialStateResult {
  state: FinancialState;
  graceEndsAt: string | null;  // due_date + GRACE_PERIOD_DAYS, em BRT
  daysOverdue: number | null;
}
```

Regras:

- `canceledAt` preenchido ou `subscriptionStatus === 'canceled'` → `CANCELED`.
- Sem assinatura → `NO_SUBSCRIPTION`.
- Sem fatura em aberto → `PAID` (inclusive quando o status ainda é `past_due` mas a fatura já foi liquidada — pagamento posterior converge).
- Fatura em aberto com `daysOverdue < 1` → `PAID` (ainda não venceu).
- `1 ≤ daysOverdue < BLOCK_AFTER_DAYS` → `IN_GRACE`.
- `daysOverdue ≥ BLOCK_AFTER_DAYS` → `OVERDUE_BEYOND_GRACE`.

`graceEndsAt` é **derivado** de `due_date + GRACE_PERIOD_DAYS`, não armazenado. Coluna nova de fim de tolerância poderia divergir do `due_date` que a origina; derivar mantém uma verdade só.

Fatura com `enforcement_hold=true` é excluída pela camada de I/O antes de chegar ao núcleo — fatura retida não conta como atraso (§5.6).

### 5.5 Reconciliação Asaas

Worker novo: `process-asaas-invoice-reconcile`. Cron diário, `verify_jwt=false` no `config.toml`, autenticado por `x-internal-key` como todos os demais.

Endpoints já verificados em [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md): `GET /v3/subscriptions/{id}/payments` (§13, passo 3e) e `GET /v3/payments/{id}`. O cliente HTTP `_shared/asaas.ts` ganha `listAsaasSubscriptionPayments(subscriptionId)`; `getAsaasPayment` já existe.

Varredura bidirecional, por assinatura não-cancelada com `provider='asaas'`:

1. **Cobrança no Asaas sem fatura aqui** → cria (`ingestion_source='RECONCILE'` ou `'BACKFILL'`, ver §5.6).
2. **Fatura `open` aqui já `RECEIVED`/`CONFIRMED` lá** → liquida (`status='paid'`, `paid_at`). Cobre webhook perdido.
3. **Fatura `open` aqui vencida e ainda pendente lá** → nada a fazer; a escalada é do worker de inadimplência.
4. **Divergência de valor** entre a fatura interna e a cobrança do provedor → retém a fatura com motivo `VALUE_MISMATCH` e avisa o administrador.
5. **Assinatura duplicada ou ambígua** → erro alto, sem escolha, aviso ao administrador.

Restrições:

- **Nunca sobrescreve estado administrativo.** Fatura `void`, `uncollectible` ou com `enforcement_hold` só muda por ação humana.
- **`GET` é retry-safe; `POST` de criação não é.** O worker é somente leitura contra o Asaas — não cria cobrança nem assinatura. Regra já registrada na API verificada (§ "POST não é retry-safe").
- Idempotente por construção: toda escrita é `ON CONFLICT DO NOTHING` ou `UPDATE` condicional.

### 5.6 `enforcement_hold`

Retenção é **excepcional**. Fatura descoberta tarde por falha temporária de webhook preserva vencimento e tolerância reais — é justamente o caso que a reconciliação existe para consertar, e retê-la converteria o conserto em atraso.

Colunas novas em `billing_invoices`:

| Coluna | Tipo | Papel |
|---|---|---|
| `ingestion_source` | `text` CHECK `WEBHOOK\|RECONCILE\|BACKFILL\|MANUAL` | de onde a linha veio |
| `enforcement_hold` | `boolean not null default false` | fatura retida não escala nem suspende |
| `enforcement_hold_reason` | `text` CHECK (lista abaixo) | por que foi retida |
| `enforcement_held_at` | `timestamptz` | quando |
| `enforcement_released_at` | `timestamptz` | quando foi liberada |
| `enforcement_released_by` | `uuid` → `auth.users` | quem liberou |

Motivos: `INITIAL_BACKFILL`, `PRE_GO_LIVE_INVOICE`, `CORRELATION_AMBIGUITY`, `VALUE_MISMATCH`, `MANUAL_REVIEW`.

**Marcação automática — apenas nestes casos:**

- `ingestion_source='BACKFILL'` → `INITIAL_BACKFILL`.
- Cobrança cuja `due_date` é anterior ao go-live da ingestão → `PRE_GO_LIVE_INVOICE`.
- Correlação resolvida com divergência de plano/purpose registrada → `CORRELATION_AMBIGUITY`.
- Divergência de valor contra o provedor → `VALUE_MISMATCH`.

**Nunca automático:** fatura ingerida por `WEBHOOK` ou `RECONCILE`, correlacionada sem anomalia, com `due_date` posterior ao go-live — mesmo que já esteja vencida no momento em que foi encontrada.

**Nunca retém** fatura `paid`, `void`, `uncollectible` ou estornada. Hold é sobre atraso; fatura liquidada ou anulada não tem atraso a reter.

**Como o sistema sabe o go-live da ingestão:** flag `billing_invoice_ingestion_since` em `platform_flags`, cujo valor é a data ISO em que a ingestão foi ativada. Vazia = ingestão nunca ativada. A comparação é `due_date < billing_invoice_ingestion_since`, determinística e sem bookkeeping de "é a primeira rodada?".

`ingestion_source='BACKFILL'` é atribuído quando o reconcile cria uma fatura cuja cobrança no Asaas foi criada antes de `billing_invoice_ingestion_since`; caso contrário, `'RECONCILE'`.

**Liberação** é ação administrativa: `manage-billing` ganha a action `release_invoice_enforcement_hold`, que exige `platform_admin`, grava `enforcement_released_at`/`enforcement_released_by` e registra em `billing_events` para auditoria. Painel em `/platform/billing` lista as faturas retidas com motivo e data.

---

## 6. Parte 5b.2 — Enforcement por serviço

### 6.1 Os sete estados e o gate pai

Núcleo puro novo — `supabase/functions/_shared/whatsapp-service-state-core.ts`, zero imports além do núcleo financeiro puro, testado por vitest a partir de `src/lib/whatsapp-service-state-core.test.ts`.

```ts
export type WhatsAppServiceState =
  | "ACTIVE"
  | "GRACE_PERIOD"
  | "OVERRIDE_ACTIVE"
  | "LEGACY_GRANDFATHERED"
  | "NOT_ENTITLED"
  | "SUSPENDED_UNPAID"
  | "ADMIN_BLOCKED";
```

Prioridade interna, alinhada ao núcleo de entitlements que já existe:

```
ADMIN_BLOCKED
  > OVERRIDE_ACTIVE
  > assinatura de WhatsApp:  PAID → ACTIVE
                             IN_GRACE → GRACE_PERIOD
                             OVERDUE_BEYOND_GRACE → SUSPENDED_UNPAID
                             CANCELED → (cai para o próximo nível)
  > LEGACY_GRANDFATHERED
  > NOT_ENTITLED
```

`OVERRIDE_ACTIVE` acima de `SUSPENDED_UNPAID` é deliberado: override válido prevalece sobre inadimplência do WhatsApp. `ADMIN_BLOCKED` acima de tudo, igual ao núcleo de entitlements.

**O estado do sistema é gate pai obrigatório.** Um override de WhatsApp nunca mantém envio quando a assinatura principal está operacionalmente suspensa — o override cobre o custo da instância, não o direito de operar um sistema bloqueado.

```ts
/**
 * Fonte: organizations.billing_status — coluna autoritativa (CLAUDE.md).
 * NÃO usar entitlements.system.allowed: ele é `false` para organização legada
 * com billing_status='active' e sem assinatura de sistema, o que bloquearia
 * quem nunca deveria ser bloqueado.
 */
export function systemBlocksDependentServices(billingStatus: string): boolean {
  return billingStatus === "blocked"
      || billingStatus === "suspended"
      || billingStatus === "canceled";
}
```

Os três valores são exatamente os que o `BillingGuard` já trata como acesso negado no frontend e os que `create-reservation` e `webhook-whatsapp` já recusam no servidor. `grace_period` e `past_due` **não** bloqueiam: são estados de tolerância do próprio sistema.

Decisão final, exposta como uma função só para não deixar caller montar a conjunção errada:

```ts
export interface WhatsAppGateInput {
  systemBillingStatus: string;
  whatsappState: WhatsAppServiceState;
}

export interface WhatsAppGateDecision {
  state: WhatsAppServiceState;
  systemBlocked: boolean;
  sendingBlocked: boolean;
  newProvisioningBlocked: boolean;
  /** Motivo machine-readable para log e telemetria. */
  reason: string;
}

export function decideWhatsAppGate(i: WhatsAppGateInput): WhatsAppGateDecision;
```

### 6.2 Envio e novo provisionamento são perguntas diferentes

| Estado | Envio | Nova instância |
|---|:---:|:---:|
| `ACTIVE` | ✅ | ✅ |
| `OVERRIDE_ACTIVE` | ✅ | ✅ |
| `GRACE_PERIOD` | ✅ | ❌ |
| `LEGACY_GRANDFATHERED` | ✅ | ❌ |
| `NOT_ENTITLED` | ✅ | ❌ |
| `SUSPENDED_UNPAID` | ❌ | ❌ |
| `ADMIN_BLOCKED` | ❌ | ❌ |

E, sobrepondo tudo: `systemBlocked === true` bloqueia **as duas colunas**, qualquer que seja o estado do WhatsApp.

- `blocksSending` = `SUSPENDED_UNPAID` ou `ADMIN_BLOCKED`.
- `blocksNewProvisioning` = os dois acima, mais `GRACE_PERIOD`, `LEGACY_GRANDFATHERED` e `NOT_ENTITLED`.

`GRACE_PERIOD` preserva a instância existente mas não gera custo externo novo. `LEGACY_GRANDFATHERED` preserva o uso existente mas não é "WhatsApp grátis para sempre": não expande serviço, não provisiona outro número, não cria instância nova.

**Fronteira explícita desta fase:** "nova instância" na 5b significa **criar canal de WhatsApp para uma unidade que ainda não tem nenhum**. Substituir o canal de uma unidade que já tem — o caminho (a) de rotação do [runbook de credenciais](../../RUNBOOK-ROTACAO-CREDENCIAIS.md#2-z-api--secret-de-webhook-por-canal) — **não** é bloqueado, senão o gate impediria a rotação de secret de um cliente legado. Reconexão e reprovisionamento da mesma instância, incluindo "não recriar silenciosamente uma instância cancelada", são detalhados na Fase 6, onde existe o ciclo de vida real da instância na Z-API para consultar.

### 6.3 Ciclo de vida do grandfathering

Colunas novas em `organizations`:

| Coluna | Papel |
|---|---|
| `whatsapp_legacy_grandfathered` | `boolean not null default false` — organização nova nasce sem |
| `whatsapp_grandfathered_at` | quando foi concedido |
| `whatsapp_grandfathered_source` | `text` CHECK `MIGRATION_5B\|ADMIN` — por qual migration ou ação |
| `whatsapp_grandfather_revoked_at` | quando foi revogado |
| `whatsapp_grandfather_revoked_reason` | `text` CHECK `FIRST_PAID_SUBSCRIPTION\|ADMIN_MIGRATION\|REPLACED_BY_OVERRIDE\|ADMIN_REVOCATION` |
| `whatsapp_grandfather_revoked_by` | `uuid` → `auth.users`, nulo quando a revogação é automática |

O núcleo lê **um booleano derivado**: `grandfathered = whatsapp_legacy_grandfathered AND whatsapp_grandfather_revoked_at IS NULL`.

**Concessão (migration):** apenas organizações com **evidência objetiva** — pelo menos uma unidade com canal em `whatsapp_channels` com `status='connected'` no momento da aplicação. Sem heurística de data, sem "provavelmente usa". A migration emite no rodapé a query de relatório dos registros afetados, e o resumo da fase registra o resultado.

**Revogação — terminal, nas quatro situações:**

1. Primeira assinatura paga de WhatsApp ativada → `FIRST_PAID_SUBSCRIPTION`, gravada pela RPC `resolve_or_activate_subscription` no mesmo ato da ativação.
2. Concessão de override formal de `whatsapp` → `REPLACED_BY_OVERRIDE`, gravada por `_shared/entitlement-overrides.ts`, que já é o writer único da tabela de overrides.
3. Migração confirmada pelo administrador → `ADMIN_MIGRATION`.
4. Revogação administrativa → `ADMIN_REVOCATION`.

**Após revogado, nunca volta.** Cancelar a assinatura ou revogar o override depois **não** restaura `LEGACY_GRANDFATHERED`: a organização passa a `NOT_ENTITLED`. É o que impede o ciclo "assino, cancelo, volto a ser legado" de virar WhatsApp grátis permanente. Reconceder exige ação administrativa explícita, que limpa `revoked_at` e regrava `source='ADMIN'` — auditada como qualquer concessão.

### 6.4 Gate central de envio

Em `sendWhatsApp` ([_shared/whatsapp-send.ts](../../../supabase/functions/_shared/whatsapp-send.ts)), antes de resolver o canal:

1. `unit_id` (ou o `unit_id` do canal) → `organization_id`.
2. Resolve `decideWhatsAppGate`.
3. `sendingBlocked && enforcementEnabled` → retorna `{ ok:false, error:"whatsapp_service_suspended" }` sem tocar no provedor.

O helper de resolução — `_shared/whatsapp-service-gate.ts` — carrega o estado com cache por invocação (mesmo padrão do `unitCache` dos workers, zerado a cada invocação para que mudança na UI reflita na execução seguinte).

O erro novo entra em `friendlyWhatsAppError` no frontend com texto próprio, distinto de `whatsapp_not_configured`: "configure o canal" e "serviço suspenso por falta de pagamento" são problemas diferentes e ações diferentes.

`send-manual-message` também passa pelo gate — mensagem manual do operador é envio de WhatsApp e gera custo na Z-API igual às demais.

### 6.5 Gate do agente

Em `webhook-whatsapp`, imediatamente após o check de `org_billing_blocked` que já existe:

- `sendingBlocked && enforcementEnabled` → `finish("whatsapp_service_suspended")`, sem resposta ao cliente final.
- **Silêncio, não mensagem.** O cliente do restaurante é terceiro inocente; avisá-lo de que o restaurante não pagou é dano de reputação. É o mesmo tratamento que `org_billing_blocked` já dá.
- A mensagem inbound continua sendo registrada na conversa: o operador vê o que chegou quando o serviço voltar.
- Zero token de IA consumido — o gate roda antes do `runAgentLoop`.

Outcome novo em `webhook_executions`: `whatsapp_service_suspended`.

### 6.6 Gate de novo provisionamento

`manage-channels`, action `create`: se a unidade **não tem nenhum canal** e `newProvisioningBlocked`, recusa com 403 e mensagem explicando o estado (`GRACE_PERIOD` e `LEGACY_GRANDFATHERED` recebem textos diferentes de `NOT_ENTITLED`). Substituição de canal em unidade que já tem canal não é bloqueada (§6.2).

Diferente dos gates de envio, **este gate não depende de `whatsapp_service_enforcement`**: ele impede um custo externo novo de nascer, e não interrompe nada que já esteja funcionando. Nesta fase ele é a única consequência que vale com a flag desligada.

### 6.7 Worker de inadimplência e restauração da instância

Worker novo: `process-whatsapp-enforcement`. Cron diário, `verify_jwt=false`, `x-internal-key`.

Faz os dois sentidos, para não deixar a restauração dependendo só do webhook:

**Suspensão** — para cada organização com assinatura `WHATSAPP_SUBSCRIPTION` não-cancelada:

1. Resolve o estado financeiro pelo núcleo (§5.4), ignorando faturas com `enforcement_hold`.
2. `OVERDUE_BEYOND_GRACE` e sem override ativo de `whatsapp` → `status='unpaid'`, `suspended_at=now()`.
3. Enfileira `whatsapp_suspended` em `billing_notifications`.
4. **Nunca** escreve `organizations.billing_status`. **Nunca** escreve em `organization_entitlement_overrides` — webhook e worker financeiro não mexem em override, invariante do CLAUDE.md.
5. Com override ativo → não suspende, e registra em log que o custo está patrocinado pela plataforma.

**Restauração** — assinatura `unpaid` cujo estado financeiro voltou a `PAID`:

1. `status='active'`, `restored_at=now()`, `suspended_at=null`.
2. Enfileira `whatsapp_restored`.

Com a flag OFF, o worker calcula tudo e **não escreve nada** — só emite a telemetria de dry-run (§6.9).

**Lembretes** ficam em `process-billing-reminders`, que hoje já ignora faturas não-sistema. Passa a tratá-las com os event types próprios (§10.1), mantendo os offsets D0/D+1/D+3/D+5 do núcleo — um lugar só para a escada de dias.

### 6.8 Estacionamento e revalidação de jobs

Dos cinco fluxos automáticos, **só `notification_outbox` tem fila com tentativas**. Lembretes D-0, pesquisas D+1, vouchers e fila de espera consultam reservas diretamente: suspensos, simplesmente pulam a unidade; e não voltam atrasados depois, porque a data que os justificava já passou.

**No `process-notification-outbox`:** o worker reivindica linhas marcando `status='processing'` antes de saber se pode enviar. Depois de reivindicar, agrupa por `unit_id`, resolve o gate uma vez por unidade e, para as suspensas:

- devolve as linhas para `status='pending'`;
- empurra `next_attempt_at = now() + 1 hora`;
- **não incrementa `attempts`**;
- grava `last_error='whatsapp_service_suspended'`.

Sem incremento, o teto de 5 tentativas não é consumido pela suspensão e o job não vira `dead` por não ter sido enviado enquanto o cliente estava suspenso.

**Nos outros quatro workers:** o gate é consultado uma vez por unidade, no topo do laço. Unidade suspensa é pulada **sem gravar linha em `notifications_sent`** — uma linha `failed` ali bloquearia o reenvio depois da restauração pelo UNIQUE `(reservation_id, kind)`.

**Revalidação na saída** — antes de enviar qualquer job que ficou parado, o outbox confere:

- a reserva ainda existe;
- não está `cancelled`;
- o horário ainda está no futuro;
- não existe envio equivalente em `notifications_sent`;
- o conteúdo continua fazendo sentido para a data.

Falhou qualquer uma → `status='done'` com `last_error='expired_after_suspension'`, registrando o motivo. **Não se reenvia tudo automaticamente:** confirmação de reserva que já aconteceu é ruído para o cliente e custo para o lojista.

### 6.9 Modo dry-run

A flag `whatsapp_service_enforcement` **não altera o estado calculado**. O núcleo sempre calcula o estado real; a flag decide se há consequência:

```
bloqueado = enforcementEnabled && (systemBlocked || blocksSending(state))
```

Com a flag **OFF**:

- não bloqueia envio, não bloqueia o agente;
- não estaciona job, não interrompe Z-API nem chamada de IA;
- **registra o que teria acontecido**: log estruturado `evt:"whatsapp_enforcement_dryrun"` com organização, unidade, estado calculado, se teria bloqueado e por quê;
- o estado calculado aparece em `get_service_status` e no painel, então o dry-run é observável sem tabela nova.

O gate de novo provisionamento (§6.6) é a exceção declarada: vale sempre.

---

## 7. Parte 5b.3 — Regularização

Após confirmação real de pagamento — webhook, ou reconciliação como defesa dupla:

**Comum aos dois serviços:** fatura atualizada, assinatura atualizada, tolerância encerrada, `restored_at` gravado, aviso de regularização enfileirado, e reprocessamento **apenas** do que ainda é válido.

**Sistema:** restaura o acesso operacional da organização e recalcula os entitlements dependentes. Caminho já existente (`process-billing-unblock` + webhook), que a 5b não altera além de passar a receber faturas de verdade.

**WhatsApp:**

- restaura o entitlement pela via da assinatura (`status='active'`);
- **consulta o estado existente da integração; não presume nada.** Se há canal conectado, o serviço volta na hora. Se não há, o cliente vê que precisa configurar — a 5b não provisiona;
- **não cria instância nova, não presume provisionamento da Z-API** — isso é Fase 6;
- reativa filas e workers internos (as linhas estacionadas voltam a ser elegíveis na próxima passagem, em até 1 hora);
- revalida os jobs estacionados antes de enviar (§6.8).

**Pagamento cruzado não regulariza o outro serviço.** Pagar a instância não desbloqueia o sistema; pagar o sistema não restaura a instância suspensa. Garantido pelo `billing-category.ts` da 5a, agora exercitado de verdade.

**Superfície no cliente:**

- `get_service_status` em `manage-whatsapp-implementations` devolve o estado do serviço, `graceEndsAt` e `suspendedAt`. Continua respeitando `readFailed`: não afirma estado ao cliente sobre leitura que falhou.
- Card de WhatsApp em [Cobranca.tsx](../../../src/pages/gestao/Cobranca.tsx) mostra o estado e a data.
- Banner em Gestão → Automação e em Gestão → Conversas quando `SUSPENDED_UNPAID` — é onde o efeito é sentido. **Sem banner global e sem bloqueio de rota:** painel, agenda, reservas, clientes, relatórios, e-mails e a página de cobrança continuam funcionando.

---

## 8. Migrations

| # | Conteúdo |
|---|---|
| 077 | `billing_invoices`: `ingestion_source`, `enforcement_hold`, `enforcement_hold_reason`, `enforcement_held_at`, `enforcement_released_at`, `enforcement_released_by`; índice parcial para faturas retidas |
| 078 | `billing_subscriptions`: `suspended_at`, `restored_at` |
| 079 | `organizations`: as seis colunas de grandfathering (§6.3) + backfill com evidência objetiva + query de relatório no rodapé |
| 080 | `platform_flags`: `billing_invoice_ingestion` (`false`), `billing_invoice_ingestion_since` (vazia) |
| 081 | RPC `get_platform_admin_emails()` (`SECURITY DEFINER`, só `service_role`) para o destinatário dos avisos administrativos |

Todas idempotentes, aditivas, com rollback no rodapé, aplicadas por `supabase db push`. `resolve_or_activate_subscription` é substituída (`create or replace`) na 079 para gravar a revogação `FIRST_PAID_SUBSCRIPTION` no mesmo ato da ativação.

---

## 9. Flags e ordem de ativação

| Flag | Papel | Estado ao fim da fase |
|---|---|---|
| `whatsapp_implementation_flow` | vitrine e checkout da implantação (5a) | OFF |
| `whatsapp_subscription_checkout` | checkout mensal de R$ 149 (5a) | OFF |
| `billing_invoice_ingestion` | criação e correlação automática de faturas (5b.1) | OFF |
| `billing_invoice_ingestion_since` | data de go-live da ingestão | vazia |
| `whatsapp_service_enforcement` | consequência operacional da inadimplência (5b.2) | OFF |

`billing_invoice_ingestion` e `whatsapp_service_enforcement` são **separadas de propósito**: uma controla a entrada de dados, a outra as consequências. Isso permite pôr o elo financeiro em produção, observar, e só depois permitir suspensões.

**Ordem segura de ativação:**

1. Deploy de banco e código, as duas flags OFF.
2. Validar no sandbox: renovação do sistema, renovação do WhatsApp, correlação por assinatura, criação de fatura, deduplicação, reconciliação.
3. `billing_invoice_ingestion = ON` (gravando `billing_invoice_ingestion_since`), enforcement ainda OFF.
4. Observar: faturas criadas, assinaturas correlacionadas, ambiguidades, duplicidades, pagamentos desconhecidos, e a telemetria de dry-run.
5. Corrigir inconsistências e liberar os holds que forem legítimos.
6. `whatsapp_service_enforcement = ON`.

**Gate de go-live:** `whatsapp_subscription_checkout` não vai a ON em produção antes de correlação por assinatura, renovação sem sessão de checkout, reconciliação, enforcement por serviço, regularização e o roteiro de sandbox estarem concluídos e verificados.

---

## 10. Notificações

### 10.1 Cliente

Event types novos em `billing_notifications`, com template próprio em `process-billing-notifications`:

`whatsapp_payment_pending` (D0) · `whatsapp_overdue_d1` · `whatsapp_overdue_d3` · `whatsapp_overdue_d5` · `whatsapp_suspended` · `whatsapp_restored`

Texto separado do sistema porque a consequência é outra: "seu acesso será suspenso" está errado para uma fatura que só desliga o WhatsApp. Dedupe pelo UNIQUE `(organization_id, event_type, invoice_id)` que já existe; produtor novo trata `23505` como no-op; destinatário por `resolveBillingRecipient`, escopado por organização.

Organização com override ativo de `whatsapp` **não recebe cobrança nem aviso da mensalidade da instância** e não vê a mensalidade como obrigação atual — o custo está patrocinado pela plataforma, e a tela registra isso.

### 10.2 Administrador

Event type `admin_correlation_ambiguity`, destinatário resolvido pela RPC `get_platform_admin_emails()` — não por `resolveBillingRecipient`, que é escopado por organização. Disparado em: divergência de organização entre degraus, ambiguidade de assinatura por categoria, divergência de valor contra o provedor, e fatura retida automaticamente.

---

## 11. Testes

Núcleo puro em vitest (`src/lib/*.test.ts`) para tudo que for decisão; sandbox para o que exigir o Asaas de verdade. Deno não está instalado, então nada em `supabase/functions/` roda em CI — é o que justifica extrair três núcleos puros nesta fase.

**Elo financeiro**

1. Renovação do sistema correlacionada por `provider_subscription_id`.
2. Renovação do WhatsApp correlacionada por `provider_subscription_id`.
3. Renovação sem sessão de checkout é processada normalmente.
4. Webhook e reconcile processando o mesmo pagamento não criam duas faturas.
5. Evento duplicado não cria fatura duplicada, não reinicia tolerância, não avisa duas vezes, não suspende nem restaura duas vezes.
6. Evento fora de ordem converge para o estado correto.
7. Duas assinaturas não-canceladas da mesma categoria geram falha alta, sem escrita.
8. Divergência de organização entre degraus derruba o evento sem escrever nada.
9. Cobrança do WhatsApp nunca altera `organizations.billing_status`.
10. Cobrança do sistema altera `billing_status` corretamente.
11. Fatura `BACKFILL` vencida recebe hold.
12. Fatura normal encontrada pelo reconcile **não** recebe hold apenas por ter sido encontrada depois do vencimento.
13. Fatura paga, `void` ou estornada nunca entra em hold por atraso.
14. Liberação de hold registra administrador, data e motivo.

**Estados e gates**

15. Sistema suspenso bloqueia WhatsApp **mesmo com override ativo**.
16. Override ativo prevalece apenas sobre inadimplência do WhatsApp.
17. D+5 continua dentro da tolerância; D+6 suspende o serviço correto.
18. `GRACE_PERIOD` permite envio e bloqueia nova instância.
19. `LEGACY_GRANDFATHERED` permite uso existente e bloqueia nova instância.
20. `NOT_ENTITLED` não bloqueia envio nesta fase e bloqueia nova instância.
21. Organização legada que ativa assinatura paga perde o grandfathering.
22. Cancelar a assinatura depois **não** restaura o grandfathering.
23. Flag de enforcement OFF calcula `SUSPENDED_UNPAID` e **não** bloqueia.
24. Sistema vencido bloqueia a organização; WhatsApp vencido bloqueia só WhatsApp.

**Regularização e jobs**

25. Pagamento do sistema não regulariza WhatsApp; pagamento do WhatsApp não regulariza o sistema.
26. Regularização restaura apenas o serviço correspondente.
27. Jobs estacionados não gastam tentativas.
28. Jobs vencidos não são enviados depois da restauração.
29. Falha de notificação não impede a atualização financeira.
30. Falha do Asaas na reconciliação não corrompe estado interno.
31. Nenhuma compra mensal de WhatsApp é liberada antes do enforcement estar ativo.

---

## 12. Riscos e limites conhecidos

1. **Ligar `billing_invoice_ingestion` dá entrada real ao worker de inadimplência do sistema, que hoje roda sobre vazio.** É o efeito colateral mais consequente da fase. Mitigado pela flag, pelo `enforcement_hold` de faturas pré-go-live e pelo fato de o único cliente ativo ter override vitalício de sistema — que `process-billing-overdue` já respeita.
2. **O gate de envio é o ponto único de todos os envios não-agente.** Um bug ali silencia o produto inteiro. Mitigado pelos sete estados (ausência não bloqueia), pela flag e pelo dry-run observável antes de ligar.
3. **`LEGACY_GRANDFATHERED` é dívida deliberada.** A fase reconhece o uso existente sem cobrar por ele. Transformar WhatsApp em pago-por-padrão é decisão comercial que exige revogar o grandfathering organização por organização, com o relatório da migration 079 como ponto de partida.
4. **Substituição de canal não é bloqueada para organização legada** (§6.2), porque o caminho de rotação de secret do runbook depende dela. Uma organização legada pode, na prática, trocar o número da unidade que já tem canal. Fechar isso exige o ciclo de vida real da instância, que é Fase 6.
5. **Reter fatura por `enforcement_hold` a esconde da inadimplência.** Hold esquecido é cliente que nunca é cobrado. O painel de faturas retidas existe para que isso não fique invisível.
6. **`entitlements.system.allowed` continua `false` para organização legada** — a spec evita esse campo no gate pai, mas ele segue sendo uma armadilha para código futuro. Vira invariante no CLAUDE.md ao fim da fase.
7. **Nada disso é validado em produção nesta fase.** O go-live do Asaas segue diferido para a última fase do projeto, por decisão do controlador; a validação é sandbox.

---

## 13. Rollback

- **Parar a ingestão sem perder evento:** `billing_invoice_ingestion = false`. Webhook segue recebendo e registrando em `billing_events`; o reconcile reprocessa depois.
- **Parar as consequências mantendo a observação:** `whatsapp_service_enforcement = false`. Estados continuam sendo calculados e logados; nada bloqueia, nada estaciona.
- **Reverter uma suspensão pontual:** `billing_subscriptions.status='active'` + `restored_at`, ou override administrativo de `whatsapp` (que prevalece por prioridade).
- **Migrations são aditivas — ficam.** O rollback específico de cada uma está no rodapé do próprio `.sql`.
- **A promoção da divergência de organização para falha** é a única mudança que pode reter eventos que antes passavam. Reverter é trocar o `failWith` por log, mas isso reabre a escrita em tenant errado — não fazer sem decisão explícita.

# Fase 4b (enxuta) — Inadimplência: acesso desliga + notificações reais — Design

> **Contexto:** continuação da migração billing Stripe→Asaas. A "Fase 4" do plano-mestre
> ([docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md))
> foi fatiada por exercitabilidade. A **4a** entregou a metade *"entra dinheiro → acesso liga"*
> (contratar → pagar → assinatura ativa → org com acesso), validada em sandbox.
> A **4b** é a metade oposta: *"o dinheiro NÃO entra → o acesso desliga e o cliente é avisado"*.
>
> **Base:** branch `billing-asaas/fase-4b`, a partir de `d8081aa` (main pós-merge da 4a).
>
> **Fatiamento aprovado (2026-07-19):** *4b enxuta* — só o ciclo de inadimplência + notificações.
> Enforcement de entitlements por-feature, completar o reconcile, correlação de renovação por
> `provider_subscription_id` e e-mails de trial ficam para uma **4c/fases seguintes**.

---

## 🔴 Base de clientes real — invariante que atravessa todas as fases

Hoje existe **1 cliente ativo: Ren Sushi, vitalício grátis** (`LIFETIME` em system+whatsapp+ai);
Moralles é a própria plataforma (também LIFETIME). Não há receita recorrente nem cliente pagante.
"Seu Japa Teste" (`seu-japa`, `billing_status='past_due'`, sem overrides) é org de teste.

Consequência para a 4b: **nenhum fluxo de inadimplência pode alcançar uma org com override vitalício.**
O guard de atraso e o dispatcher de notificação respeitam o override `system` **antes** de escalar/enviar.
O pior caso de um bug de billing hoje é reputacional (cliente vitalício ver bloqueio/cobrança), não financeiro.

---

## Escopo

### Entra na 4b
1. **Detecção de atraso** (`process-billing-overdue`): `grace_period` durante D+1…D+5, `blocked` em D+6.
2. **Lembretes** (`process-billing-reminders`): cadência D+1/D+3/D+5, com correção do **vazamento cross-tenant**.
3. **Dispatcher de e-mail real** (`process-billing-notifications`, novo): consome a fila `billing_notifications`
   `pending` → Resend via `_shared/email.ts`; gated por flag `billing_notifications_dispatch`.
4. **Regularização**: pagamento recebido de org atrasada → restaura acesso + e-mail "regularizado".
5. **Respeito ao override vitalício** (`organization_entitlement_overrides`) em overdue e reminders.
6. **Templates** (6): `payment_pending`, `overdue_d1`, `overdue_d3`, `overdue_d5`, `suspended`, `regularized`.

### NÃO entra (4c / fases seguintes)
- Enforcement de entitlements por-feature (flag `entitlements_enforced`) — hoje o `billing_status` nível-org
  já é autoritativo pro `BillingGuard` e guards server-side; suficiente pra suspender a assinatura do sistema.
- Completar o reconcile (consulta de `PENDING` antigos na API, alerta admin, action de reprocesso manual).
- Correlação de renovação por `provider_subscription_id` (cobrança do mês 2+ não carrega `checkoutSession`).
- E-mails de trial (iniciando/terminando/encerrado) — não há trial de cliente real; gatilho é `trial_ends_at`, não invoice.
- Suspensão **por serviço** (WhatsApp vs sistema) — é Fase 5, exige o modelo per-service.

---

## Arquitetura

Três produtores enfileiram linhas em `billing_notifications` (`status='pending'`); **um** consumidor
(`process-billing-notifications`) envia. Idempotência é **DB-enforced** por UNIQUE, então todo insert é
`on conflict do nothing` e nenhum re-run duplica — respeitando o princípio *insert-on-state-change, não
insert-por-execução* (gate de go-live da Fase 11).

```
process-billing-reminders  ─┐  (lembretes por offset de due_date: payment_pending/overdue_d1/d3/d5)
process-billing-overdue    ─┤─→ billing_notifications (pending) ──→ process-billing-notifications ──→ Resend
applyAsaasEvent (restore)  ─┘  (regularized na volta pra active)        (flag billing_notifications_dispatch)
```

- **Detecção de atraso é date-scan** sobre `billing_invoices` (`status='open'` + `due_date` passada) — a rede
  de segurança, independente de webhook. O `PAYMENT_OVERDUE` do Asaas pode complementar marcando a invoice,
  mas o worker não depende dele.
- `applyAsaasEvent` (`_shared/asaas-billing-events-apply.ts`) já é a fonte única de "efeito de pagamento";
  a 4b só **adiciona** a notificação de regularização quando o pagamento tira a org de um estado de atraso.

---

## Máquina de estados (nível-org, `organizations.billing_status`)

`due_date = D0`. Enquanto a invoice fica `open` e vencida (e a org **não** tem override system ativo):

| Janela | `billing_status` alvo | Acesso | Efeito colateral |
|---|---|---|---|
| D+1 … D+5 | `grace_period` | **liberado** (tolerância) | lembretes D+1/D+3/D+5 |
| D+6 em diante | `blocked` (+ `blocked_at`, `blocked_reason`) | **bloqueado** → `BillingGuard` redireciona pra `/g/:slug/cobranca` | e-mail `suspended` |
| pagamento recebido (qualquer momento) | `active` (+ `restored_at`) | liberado | e-mail `regularized` |

**Decisão 1 — terminal = `blocked` (reuso), não `suspended` novo.** `BillingGuard` e `Cobranca.tsx` já tratam
`blocked` (whitelist de `/g/:slug/cobranca`), e as colunas `blocked_at`/`blocked_reason` já existem. Criar um
status `suspended` org-level agora seria superfície de UI/copy sem ganho funcional. O `suspended` **por serviço**
é problema da Fase 5. Constantes: `GRACE_PERIOD_DAYS = 5`, `BLOCK_AFTER_DAYS = 6`.

O worker **nunca** rebaixa `manual_override`, `canceled`, nem uma org com override system vitalício.
Transição só ocorre se o status atual difere do alvo (idempotente).

**Decisão 5 — day-math em BRT.** Hoje os workers usam `new Date().toISOString().slice(0,10)` (UTC). Comparação
de dia perto da meia-noite BRT erra por 1 dia (Deno roda em UTC). A 4b move o cálculo de "hoje"/offsets pra BRT
via util puro estilo `getTodayBrtParts` (testável em vitest a partir de `src/`).

---

## Migration (aditiva, idempotente)

Arquivo novo `YYYYMMDDHHMMSS_068_billing_notifications_cycle.sql`:

- `alter table billing_notifications add column if not exists invoice_id uuid references billing_invoices(id) on delete set null;`
- `create unique index if not exists billing_notifications_org_type_invoice_uidx on billing_notifications (organization_id, event_type, invoice_id) where invoice_id is not null;`
  - **`invoice_id` é o handle de ciclo.** Uma nova mensalidade nasce numa nova `billing_invoice`, então o mesmo
    `event_type` volta a disparar no ciclo seguinte, mas **uma vez por ciclo**. Linhas antigas (sem `invoice_id`)
    não conflitam (índice parcial).
- `create index if not exists billing_notifications_status_idx on billing_notifications (status) where status = 'pending';`
  (o dispatcher varre só `pending`).
- `organizations` += `restored_at` (não existe hoje): `add column if not exists restored_at timestamptz;`
  (carimbado na regularização). `blocked_at`/`blocked_reason` **já existem** ([billing_module.sql:17](../../../supabase/migrations/20260528000000_billing_module.sql#L17)) e seguem usados no bloqueio.

Tudo em `begin;`/`commit;`. Sem backfill destrutivo. `billing_notifications` segue FORCE RLS sem policies
(acesso só via service_role/EF) — o índice novo não muda isso.

---

## Componentes

### 1. `process-billing-overdue/index.ts` (adaptar)

**Files:** Modify `supabase/functions/process-billing-overdue/index.ts`.

- `GRACE_PERIOD_DAYS = 5`, `BLOCK_AFTER_DAYS = 6`. Ladder passa a `grace_period` (D+1…D+5) → `blocked` (D+6).
- **Skip de override vitalício (Decisão 6):** antes de escalar, além do legado `billing_access_overrides`
  (`override_type='grant_access'`, `active`), pular se existe `organization_entitlement_overrides` ativo
  para a org com `feature='system'`, `enabled=true`, `revoked_at is null`, `(ends_at is null or ends_at > now())`.
- **Notificação de suspensão (insert-on-state-change):** quando a transição é para `blocked`, enfileirar
  `billing_notifications` `{event_type:'suspended', channel:'email', status:'pending', invoice_id, recipient}`
  com `on conflict do nothing`. `recipient` resolvido pelo mesmo helper org-scoped (ver §2).
- **BRT day-math (Decisão 5).**
- Continua respeitando `manual_override`/`canceled`.

### 2. `process-billing-reminders/index.ts` (adaptar + FIX do blocker)

**Files:** Modify `supabase/functions/process-billing-reminders/index.ts`.

- `REMINDER_OFFSETS` (Decisão 2):
  `{days:0, type:'payment_pending'}`, `{days:1,'overdue_d1'}`, `{days:3,'overdue_d3'}`, `{days:5,'overdue_d5'}`.
  (`suspended` sai do date-scan — é emitido pelo overdue na transição. `regularized` é event-driven.)
- **FIX DO VAZAMENTO CROSS-TENANT** ([:76-85](../../../supabase/functions/process-billing-reminders/index.ts#L76-L85)):
  o fallback de owner hoje é `unit_members where role='owner' order by created_at limit 1` — **sem filtro de org**,
  pega o owner mais antigo da plataforma inteira. Corrigir para escopar por org:
  ```sql
  select um.email
  from unit_members um
  join units u on u.id = um.unit_id
  where u.organization_id = :orgId and um.role = 'owner'
  order by um.created_at
  limit 1
  ```
  Extrair num helper `resolveBillingRecipient(orgId)` (retorna `billing_email` da org, ou o owner **da própria org**,
  ou `null`) — reusado pelo overdue (§1) e pelo dispatcher. `null` → skip (nunca manda pra destinatário errado).
- **Dedupe DB-enforced:** trocar o SELECT-then-insert soft por `insert ... on conflict do nothing` usando o
  UNIQUE novo `(organization_id, event_type, invoice_id)`. Todo insert carrega `invoice_id = inv.id`.
- **Mesmo skip de override vitalício** (§1) — não enfileira lembrete pra org LIFETIME.
- **BRT day-math (Decisão 5).**

### 3. `process-billing-notifications/index.ts` (NOVO worker)

**Files:** Create `supabase/functions/process-billing-notifications/index.ts`; add entry to `supabase/config.toml`.

- Cron pg_cron `*/5 * * * *`; wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post`
  com `x-internal-key` (padrão dos outros workers). `verify_jwt = false` explícito em `config.toml` (CLI ≥2.95).
- **Gate `billing_notifications_dispatch`** (flag já seedada OFF na Fase 1, lida via `_shared/platform-flags.ts`,
  fail-closed): OFF → retorna cedo sem enviar (a fila acumula em `pending`, seguro).
- Loop (lote ~20): lê `billing_notifications status='pending'` (ordena por `sent_at`/`created_at`); para cada:
  renderiza assunto+corpo por `event_type` (constantes `TEMPLATE_BY_EVENT` no worker), busca os dados da invoice
  (`amount_cents`, `hosted_invoice_url`/link de pagamento, `due_date`) e o nome da org; envia via
  `_shared/email.ts` (Resend, `RESEND_API_KEY`/`RESEND_FROM_EMAIL`); grava `status='sent'` (sucesso) ou
  `status='failed'` + `error` (falha). **Nunca** usa o canal WhatsApp da própria org.
- **Decisão 4 — in-app = o próprio registro** `billing_notifications`. Nenhuma UI cliente-facing nova nesta fase
  (o e-mail é o canal principal e o `BillingGuard` já comunica o bloqueio). Fica de follow-up.

### 4. `_shared/asaas-billing-events-apply.ts` (regularização)

**Files:** Modify `supabase/functions/_shared/asaas-billing-events-apply.ts`.

- `applyAsaasEvent` já seta `billing_status='active'` no pagamento confirmado/recebido. **Adicionar:** se o
  status **anterior** da org era `grace_period` / `blocked` / `past_due`, carimbar `restored_at = now()` e
  enfileirar `billing_notifications` `{event_type:'regularized', status:'pending', invoice_id, recipient}`
  (`on conflict do nothing`).
- **Redeploy (checklist CLAUDE.md):** mexer nesse `_shared` exige redeploy de `asaas-webhook`,
  `process-asaas-reconcile` e `manage-billing`.

### 5. Templates (`TEMPLATE_BY_EVENT`)

PT-BR, no worker dispatcher. Cada um recebe `{orgName, amountBrl, paymentUrl, dueDate}`:

| `event_type` | Assunto (resumo) | Corpo (resumo) |
|---|---|---|
| `payment_pending` | "Sua mensalidade vence hoje" | valor + link de pagamento |
| `overdue_d1` | "Pagamento em atraso" | 1 dia de atraso + link |
| `overdue_d3` | "Pagamento em atraso (3 dias)" | reforço + aviso de suspensão próxima |
| `overdue_d5` | "Último aviso antes da suspensão" | suspensão amanhã se não pagar + link |
| `suspended` | "Acesso suspenso por falta de pagamento" | como regularizar + link |
| `regularized` | "Pagamento confirmado — acesso liberado" | confirmação, sem link |

---

## Testes

**Unit (vitest, lógica pura extraída para `src/` ou `_shared` importável):**
- Máquina de estados: dado `daysOverdue`, retorna `grace_period` (1–5), `blocked` (≥6); respeita override/`manual_override`.
- Day-math BRT: "hoje" e offsets corretos perto da meia-noite BRT (fixar timestamps, sem `Date.now()` cru nos testes).
- Dedupe idempotente: dois inserts do mesmo `(org, event_type, invoice_id)` → 1 linha (simular via lógica/on-conflict).
- `resolveBillingRecipient`: com `billing_email` → usa; sem → owner **da própria org**; org sem owner → `null`;
  **nunca** retorna owner de outra org (regressão do blocker).

**Sandbox ao vivo (org "Seu Japa Teste", `past_due`, sem overrides):**
- Backfill uma `billing_invoice` Asaas (`status='open'`) e setar `billing_email` = uma caixa de teste **real**
  (ex.: a do próprio admin) — Resend em sandbox envia de verdade.
- Manipular `due_date` para exercitar: D+1 → `grace_period` + `overdue_d1` enfileirado; D+5 → `overdue_d5`;
  D+6 → `blocked` + `suspended`; ligar `billing_notifications_dispatch` → dispatcher envia; simular pagamento
  (`PAYMENT_RECEIVED`) → `active` + `restored_at` + `regularized`.
- **Confirmar o fix do vazamento:** com `billing_email` nulo numa org, o e-mail vai pro owner **daquela** org,
  nunca pro owner mais antigo de outra.

**Cenários da spec-mãe cobertos** (mapa em [01-PLANO §"Mapa dos 30 cenários"](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md)):
13–15 (inadimplência org-level / tolerância / regularização) nesta fase; **16–17 (por-serviço) ficam na Fase 5.**

---

## Flags, config.toml, redeploy, rollback

- **Flag:** `billing_notifications_dispatch` (já existe, OFF). Ligar só quando o dispatcher estiver validado.
- **config.toml:** entrada `verify_jwt=false` para `process-billing-notifications` **no mesmo PR** do worker.
- **pg_cron:** migration idempotente agenda `process-billing-notifications` (`*/5 * * * *`) via wrapper Vault.
- **Redeploy:** `process-billing-overdue`, `process-billing-reminders`, `process-billing-notifications` (novo);
  e por causa do `_shared/asaas-billing-events-apply.ts`: `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`.
- **Rollback:** `billing_notifications_dispatch` OFF (nada é enviado; fila só acumula) + reverter os workers pelo
  commit anterior (constantes de timeline voltam a 3/4). Migration é aditiva — fica.

---

## Decisões-padrão (aprovadas 2026-07-19)

1. **Terminal = `blocked`** (reuso), não `suspended` novo — `suspended` por-serviço é Fase 5.
2. **Cadência** `payment_pending(D0)` + `overdue_d1/d3/d5` + `suspended(D+6, state-change)` + `regularized(evento)`; sem D-3.
3. **Dedupe** via coluna `invoice_id` + UNIQUE `(org, event_type, invoice_id)`, `on conflict do nothing`.
4. **In-app = só o registro** `billing_notifications`; UI cliente-facing deferida.
5. **Day-math em BRT** nos workers.
6. **Overdue e reminders pulam LIFETIME** `organization_entitlement_overrides` (feature `system`).
7. **Fix do blocker** = fallback de owner **escopado por org** (mantém o fallback, sem o vazamento).

## Riscos residuais / follow-ups (4c+)

- **Renovação mês 2+** sem `checkoutSession` — correlação por `provider_subscription_id` (antes do 1º ciclo real ~30d;
  hoje sem relógio porque tudo é sandbox e o único cliente é vitalício).
- **Reconcile incompleto** (consulta de `PENDING`, alerta admin, reprocesso manual) — rede de segurança do webhook;
  vira bloqueante junto com o gate de go-live da Fase 11 (subir cadência do reconcile + dedupe estágio-2).
- **Enforcement de entitlements por-feature** — necessário pra Fase 5 (suspensão por-serviço).
- **UI in-app de avisos de cobrança** — o registro existe; falta a superfície cliente-facing.

# Fase 5b — Elo financeiro da renovação + enforcement por serviço — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a cobrança recorrente do Asaas gerar fatura interna correlacionada e, sobre ela, suspender e restaurar o serviço de WhatsApp por inadimplência sem jamais tocar o acesso ao sistema.

**Architecture:** Três núcleos puros novos (correlação, estado financeiro, estado do serviço de WhatsApp) concentram toda a decisão e são testados por vitest; as Edge Functions e os workers só fazem I/O e chamam os núcleos. A ingestão de faturas e o enforcement ficam atrás de flags separadas, para que o elo financeiro possa ir a produção e ser observado antes de qualquer suspensão.

**Tech Stack:** Supabase (Postgres + RLS, Edge Functions Deno, pg_cron), React 18 + Vite + TanStack Query, Vitest, Asaas API v3.

**Spec:** [docs/superpowers/specs/2026-07-27-billing-asaas-fase-5b-design.md](../specs/2026-07-27-billing-asaas-fase-5b-design.md) — leitura obrigatória antes da Task 1.

## Global Constraints

- **`organizations.billing_status` só pode ser escrita por fatura/assinatura de categoria `SYSTEM_SUBSCRIPTION`.** Nenhum código desta fase escreve nessa coluna. Invariante da Fase 5a.
- **Webhook e worker financeiro NUNCA escrevem em `organization_entitlement_overrides`.** Só ação administrativa. Invariante do CLAUDE.md.
- **Nenhuma operação manual preenche `billing_invoice_id`/`provider_checkout_id` com id inventado do Asaas.** Há CHECK no banco; a regra para código novo é não tentar.
- **Correlação nunca por valor, data aproximada ou "assinatura mais recente".** Só identificadores do provedor.
- **Ambiguidade é falha alta:** sem escolha silenciosa, sem escrita, evento fica na fila, administrador avisado.
- **O gate pai do WhatsApp lê `organizations.billing_status`, NUNCA `entitlements.system.allowed`** — esse campo é `false` para organização legada com `billing_status='active'`.
- **Migrations são idempotentes e aplicadas só por `supabase db push`.** Nunca colar SQL no Studio.
- **`verify_jwt = false` explícito no `supabase/config.toml` para todo worker `process-*`** antes do deploy.
- **Toda mudança em `supabase/functions/_shared/` exige atualizar o checklist de redeploy do `CLAUDE.md` no mesmo PR.**
- **Deno não está instalado.** `npm run typecheck` (`tsc -b --noEmit`) e `npm test` não alcançam `supabase/functions/`. Toda lógica decisória vai para núcleo puro importado por vitest de `src/lib/`.
- **`npm run typecheck` é `tsc -b --noEmit`. NUNCA `tsc --noEmit` sem `-b`.**
- Baseline no início da fase: `npm test` **265/265**, `npm run typecheck` **0 erros**, `npm run lint` 0 erros / 22 warnings pré-existentes.
- **Nunca `git add .` / `git add -A`.** Sempre caminho explícito, após revisar `git diff --cached`.
- Comentário de código em português, como o resto do repositório.

---

## Estrutura de arquivos

**Núcleos puros novos** (zero dependências de Deno/supabase-js; só podem importar outro núcleo puro):

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/billing-correlation-core.ts` | Dada uma lista de candidatos de correlação, decide vencedor, detecta divergência de organização |
| `supabase/functions/_shared/billing-financial-state-core.ts` | Traduz status do provedor + fatura em aberto para estado financeiro interno |
| `supabase/functions/_shared/whatsapp-service-state-core.ts` | Sete estados do serviço + gate pai do sistema + as duas perguntas (envio, novo provisionamento) |

**Helper de I/O novo:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/whatsapp-service-gate.ts` | Carrega do banco o que o núcleo precisa, com cache por invocação |

**Workers novos:**

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/process-asaas-invoice-reconcile/index.ts` | Reconciliação bidirecional de cobranças com o Asaas |
| `supabase/functions/process-whatsapp-enforcement/index.ts` | Suspende e restaura a assinatura de WhatsApp |

**Migrations:** `077` (colunas de hold em `billing_invoices`), `078` (`suspended_at`/`restored_at` em `billing_subscriptions`), `079` (grandfathering em `organizations` + RPC), `080` (flags).

**Modificados:** `_shared/asaas-billing-events.ts`, `_shared/asaas-billing-events-apply.ts`, `_shared/asaas.ts`, `_shared/whatsapp-send.ts`, `webhook-whatsapp/index.ts`, `manage-channels/index.ts`, `manage-billing/index.ts`, `manage-whatsapp-implementations/index.ts`, `process-notification-outbox/index.ts`, `process-billing-overdue/index.ts`, `process-billing-reminders/index.ts`, `process-billing-notifications/index.ts`, os quatro workers de envio automático, `supabase/config.toml`, e a superfície React de cobrança/automação.

---

## Correção da spec descoberta ao planejar

A spec §8 previa a migration `081` com a RPC `get_platform_admin_emails()`. **Ela não é necessária:** `resolvePlatformAdminRecipients(supabase)` já existe em [_shared/billing-notify.ts:101](../../../supabase/functions/_shared/billing-notify.ts) e faz exatamente isso (lê `platform_admins`, resolve e-mail pelo Auth Admin, pula usuário banido, para no primeiro utilizável). As tasks usam o helper existente. Não criar a migration 081.

---

## Task 1: Migration 077 — colunas de retenção em `billing_invoices`

**Files:**
- Create: `supabase/migrations/20260727100000_077_billing_invoice_enforcement_hold.sql`

**Interfaces:**
- Produces: colunas `ingestion_source`, `enforcement_hold`, `enforcement_hold_reason`, `enforcement_held_at`, `enforcement_released_at`, `enforcement_released_by` em `billing_invoices`; índice parcial `billing_invoices_enforcement_hold_idx`.

- [ ] **Step 1: Escrever a migration**

```sql
-- Retenção de fatura para revisão administrativa (Fase 5b).
--
-- POR QUE EXISTE: ao ligar `billing_invoice_ingestion` pela primeira vez, a
-- reconciliação pode encontrar cobrança antiga já vencida há mais de cinco
-- dias. Sem freio, ela entraria direto na escada de inadimplência e suspenderia
-- alguém na primeira varredura, por dívida que nunca foi cobrada de verdade.
--
-- RETENÇÃO É EXCEPCIONAL, NÃO A REGRA. Fatura encontrada tarde por falha
-- temporária de webhook preserva vencimento e tolerância reais — é justamente
-- o caso que a reconciliação existe para consertar, e retê-la converteria o
-- conserto em atraso. Só retém: backfill inicial, cobrança anterior ao go-live
-- da ingestão, ambiguidade de correlação, divergência de valor, e revisão
-- manual pedida por um humano.

begin;

alter table billing_invoices
  add column if not exists ingestion_source text,
  add column if not exists enforcement_hold boolean not null default false,
  add column if not exists enforcement_hold_reason text,
  add column if not exists enforcement_held_at timestamptz,
  add column if not exists enforcement_released_at timestamptz,
  add column if not exists enforcement_released_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_ingestion_source_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_ingestion_source_chk
      check (ingestion_source is null or ingestion_source in
             ('WEBHOOK', 'RECONCILE', 'BACKFILL', 'MANUAL'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_hold_reason_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_hold_reason_chk
      check (enforcement_hold_reason is null or enforcement_hold_reason in
             ('INITIAL_BACKFILL', 'PRE_GO_LIVE_INVOICE', 'CORRELATION_AMBIGUITY',
              'VALUE_MISMATCH', 'MANUAL_REVIEW'));
  end if;

  -- Retida obriga motivo e data. Sem isto, uma fatura some da inadimplência
  -- sem nada explicando por quê, e vira cliente que nunca é cobrado.
  if not exists (
    select 1 from pg_constraint where conname = 'billing_invoices_hold_requires_reason_chk'
  ) then
    alter table billing_invoices
      add constraint billing_invoices_hold_requires_reason_chk
      check (
        enforcement_hold = false
        or (enforcement_hold_reason is not null and enforcement_held_at is not null)
      );
  end if;
end $$;

create index if not exists billing_invoices_enforcement_hold_idx
  on billing_invoices (organization_id, enforcement_held_at desc)
  where enforcement_hold = true;

comment on column billing_invoices.enforcement_hold is
  'Fatura retida para revisão administrativa: nenhum worker de inadimplência a considera. Ligada automaticamente só em backfill, cobrança pré-go-live da ingestão, ambiguidade de correlação e divergência de valor. Fatura paid/void/uncollectible nunca entra em hold por atraso.';

comment on column billing_invoices.ingestion_source is
  'De onde a linha veio: WEBHOOK (PAYMENT_CREATED/RECEIVED), RECONCILE (varredura periódica), BACKFILL (varredura sobre cobrança anterior ao go-live da ingestão), MANUAL (fatura criada pelo painel).';

commit;

-- =====================================================================
-- Validação pós-migration (esperado: 6 linhas, e 0 faturas retidas)
-- =====================================================================
--   select column_name from information_schema.columns
--    where table_name = 'billing_invoices'
--      and column_name like 'enforcement%' or column_name = 'ingestion_source';
--
--   select count(*) from billing_invoices where enforcement_hold;
--
-- Rollback:
--   drop index if exists billing_invoices_enforcement_hold_idx;
--   alter table billing_invoices
--     drop constraint if exists billing_invoices_hold_requires_reason_chk,
--     drop constraint if exists billing_invoices_hold_reason_chk,
--     drop constraint if exists billing_invoices_ingestion_source_chk,
--     drop column if exists enforcement_released_by,
--     drop column if exists enforcement_released_at,
--     drop column if exists enforcement_held_at,
--     drop column if exists enforcement_hold_reason,
--     drop column if exists enforcement_hold,
--     drop column if exists ingestion_source;
```

- [ ] **Step 2: Conferir que a migration é idempotente lendo-a de novo**

Toda instrução usa `if not exists` / `add column if not exists`. Rodar duas vezes não pode falhar. **Não aplicar com `db push` nesta task** — o push do lote inteiro é do dono, no fechamento da fase.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727100000_077_billing_invoice_enforcement_hold.sql
git commit -m "feat(billing): colunas de retencao de fatura para revisao administrativa"
```

---

## Task 2: Migration 078 — `suspended_at` / `restored_at` em `billing_subscriptions`

**Files:**
- Create: `supabase/migrations/20260727100100_078_billing_subscription_service_timestamps.sql`

**Interfaces:**
- Produces: colunas `suspended_at` e `restored_at` em `billing_subscriptions`, usadas pela Task 17 (worker de enforcement) e pela Task 20 (superfície do cliente).

- [ ] **Step 1: Escrever a migration**

```sql
-- Marcos de suspensão e restauração por assinatura (Fase 5b).
--
-- A suspensão do serviço de WhatsApp é `billing_subscriptions.status='unpaid'`:
-- `ALLOWED_SUB_STATUSES` do núcleo de entitlements é {active, trialing,
-- past_due}, então `unpaid` já derruba o entitlement de `whatsapp` sem nenhuma
-- alteração no núcleo. `unpaid` também não é `canceled`, então a RPC
-- `resolve_or_activate_subscription` continua encontrando a linha suspensa e
-- não cria uma segunda assinatura.
--
-- O status sozinho não diz QUANDO. Estas duas colunas dão o marco para a tela
-- do cliente ("suspenso desde"), para a auditoria e para o teste de que
-- restaurar duas vezes não reescreve a data.

begin;

alter table billing_subscriptions
  add column if not exists suspended_at timestamptz,
  add column if not exists restored_at timestamptz;

comment on column billing_subscriptions.suspended_at is
  'Quando o serviço desta assinatura foi suspenso por inadimplência. Limpo na restauração. Vale para qualquer categoria; hoje só a de WhatsApp é suspensa por worker.';

comment on column billing_subscriptions.restored_at is
  'Quando o serviço voltou após pagamento confirmado. Preservado entre ciclos — é o último retorno, não um contador.';

commit;

-- Validação (esperado: 2 linhas):
--   select column_name from information_schema.columns
--    where table_name = 'billing_subscriptions'
--      and column_name in ('suspended_at', 'restored_at');
--
-- Rollback:
--   alter table billing_subscriptions
--     drop column if exists restored_at,
--     drop column if exists suspended_at;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260727100100_078_billing_subscription_service_timestamps.sql
git commit -m "feat(billing): marcos de suspensao e restauracao por assinatura"
```

---

## Task 3: Migration 079 — grandfathering de WhatsApp e revogação na RPC

**Files:**
- Create: `supabase/migrations/20260727100200_079_whatsapp_legacy_grandfathering.sql`

**Interfaces:**
- Consumes: colunas `suspended_at`/`restored_at` da Task 2 (a RPC as escreve).
- Produces: colunas de grandfathering em `organizations`; `resolve_or_activate_subscription` passa a revogar o grandfathering e a gravar `restored_at`.

**Contexto que o implementador precisa:** a versão atual da RPC está em [supabase/migrations/20260726100200_073_billing_subscription_category.sql](../../../supabase/migrations/20260726100200_073_billing_subscription_category.sql). Esta task a substitui por `create or replace` **preservando integralmente** o corpo existente (advisory lock por categoria, checagem de ambiguidade, reconciliação de `billing_plan_id` e de `provider`/`provider_subscription_id`, retorno `jsonb` com `action`/`plan_changed`/`provider_changed`), acrescentando apenas o que está descrito abaixo. Copiar o corpo do arquivo 073 e editar — não reescrever de memória.

- [ ] **Step 1: Escrever a parte das colunas**

```sql
-- Grandfathering do WhatsApp para clientes anteriores à cobrança (Fase 5b).
--
-- POR QUE EXISTE: `entitlements.whatsapp.allowed` é `false` para TODA
-- organização sem assinatura de WhatsApp nem override. Ligar o gate de envio
-- por ausência de direito silenciaria, na hora, todo cliente que já usa
-- WhatsApp e nunca comprou a instância. Transformar WhatsApp em pago-por-padrão
-- é decisão comercial, não consequência de ligar uma flag de inadimplência.
--
-- MAS NÃO É "WHATSAPP GRÁTIS PARA SEMPRE": o estado LEGACY_GRANDFATHERED
-- permite o uso existente e bloqueia novo provisionamento; e a revogação é
-- TERMINAL — cancelar a assinatura ou revogar o override depois NÃO restaura o
-- grandfathering, senão "assino, cancelo, volto a ser legado" viraria isenção
-- permanente.

begin;

alter table organizations
  add column if not exists whatsapp_legacy_grandfathered boolean not null default false,
  add column if not exists whatsapp_grandfathered_at timestamptz,
  add column if not exists whatsapp_grandfathered_source text,
  add column if not exists whatsapp_grandfather_revoked_at timestamptz,
  add column if not exists whatsapp_grandfather_revoked_reason text,
  add column if not exists whatsapp_grandfather_revoked_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_source_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_source_chk
      check (whatsapp_grandfathered_source is null
             or whatsapp_grandfathered_source in ('MIGRATION_5B', 'ADMIN'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_revoke_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_revoke_chk
      check (whatsapp_grandfather_revoked_reason is null
             or whatsapp_grandfather_revoked_reason in
                ('FIRST_PAID_SUBSCRIPTION', 'ADMIN_MIGRATION',
                 'REPLACED_BY_OVERRIDE', 'ADMIN_REVOCATION'));
  end if;

  -- Revogado obriga motivo e data: revogação sem rastro é indistinguível de
  -- nunca ter sido concedido.
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_wa_grandfather_revoked_pair_chk'
  ) then
    alter table organizations
      add constraint organizations_wa_grandfather_revoked_pair_chk
      check ((whatsapp_grandfather_revoked_at is null
              and whatsapp_grandfather_revoked_reason is null)
             or (whatsapp_grandfather_revoked_at is not null
                 and whatsapp_grandfather_revoked_reason is not null));
  end if;
end $$;

comment on column organizations.whatsapp_legacy_grandfathered is
  'Organização que já usava WhatsApp antes da cobrança da instância. Concede o estado LEGACY_GRANDFATHERED: mantém o envio existente, bloqueia novo provisionamento. O estado efetivo é `whatsapp_legacy_grandfathered AND whatsapp_grandfather_revoked_at IS NULL` — revogação é terminal e não volta sozinha.';

-- Concessão por EVIDÊNCIA OBJETIVA: organização com pelo menos uma unidade com
-- canal de WhatsApp `connected` agora. Sem heurística de data, sem "provavelmente
-- usa". Idempotente: só marca quem ainda não foi marcado nem revogado.
update organizations o
   set whatsapp_legacy_grandfathered = true,
       whatsapp_grandfathered_at = now(),
       whatsapp_grandfathered_source = 'MIGRATION_5B'
 where o.whatsapp_legacy_grandfathered = false
   and o.whatsapp_grandfather_revoked_at is null
   and exists (
     select 1
       from whatsapp_channels c
       join units u on u.id = c.unit_id
      where u.organization_id = o.id
        and c.status = 'connected'
   );

commit;
```

- [ ] **Step 2: Acrescentar a substituição da RPC no mesmo arquivo**

Copiar o `create or replace function resolve_or_activate_subscription(...)` do arquivo 073 **na íntegra** e aplicar exatamente estas três mudanças:

1. No bloco `if v_count = 1`, logo depois do `update ... set status = 'active' ... where id = v_sub_id and status <> 'active';`, acrescentar:

```sql
    -- Restauração: a assinatura que estava suspensa por inadimplência volta
    -- agora. Condicional pelo `suspended_at is not null` — reprocessar um
    -- pagamento antigo de uma assinatura que nunca foi suspensa não pode
    -- inventar um `restored_at`.
    update billing_subscriptions
       set restored_at = now(), suspended_at = null, updated_at = now()
     where id = v_sub_id and suspended_at is not null;
```

2. Antes de cada um dos dois `return jsonb_build_object(...)` (o do ramo `reused` e o do ramo `created`), acrescentar:

```sql
  -- Primeira assinatura paga de WhatsApp encerra o grandfathering, de forma
  -- TERMINAL. Cancelar depois não restaura — quem quiser reconceder faz ação
  -- administrativa explícita.
  if v_category = 'WHATSAPP_SUBSCRIPTION' then
    update organizations
       set whatsapp_grandfather_revoked_at = now(),
           whatsapp_grandfather_revoked_reason = 'FIRST_PAID_SUBSCRIPTION'
     where id = p_org
       and whatsapp_legacy_grandfathered = true
       and whatsapp_grandfather_revoked_at is null;
  end if;
```

3. Atualizar o `comment on function` mencionando os dois efeitos novos, e **repetir os `revoke`/`grant`** (um `create or replace` não os perde, mas repeti-los deixa a migration autossuficiente se for aplicada em banco novo).

- [ ] **Step 3: Acrescentar validação e rollback no rodapé**

```sql
-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. RELATÓRIO das organizações concedidas (guardar o resultado no resumo da
--    fase — é o ponto de partida da migração comercial futura):
--   select o.id, o.name, o.whatsapp_grandfathered_at,
--          count(distinct c.id) as canais_conectados
--     from organizations o
--     join units u on u.organization_id = o.id
--     join whatsapp_channels c on c.unit_id = u.id and c.status = 'connected'
--    where o.whatsapp_legacy_grandfathered
--    group by 1, 2, 3
--    order by 2;
--
-- 2. Nenhuma organização SEM canal conectado foi marcada (esperado: 0 linhas):
--   select o.id from organizations o
--    where o.whatsapp_legacy_grandfathered
--      and not exists (select 1 from whatsapp_channels c
--                      join units u on u.id = c.unit_id
--                     where u.organization_id = o.id and c.status = 'connected');
--
-- 3. A RPC continua com os grants corretos (esperado: só service_role):
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'resolve_or_activate_subscription';
--
-- Rollback:
--   Reaplicar a RPC do arquivo 073 e:
--   alter table organizations
--     drop constraint if exists organizations_wa_grandfather_revoked_pair_chk,
--     drop constraint if exists organizations_wa_grandfather_revoke_chk,
--     drop constraint if exists organizations_wa_grandfather_source_chk,
--     drop column if exists whatsapp_grandfather_revoked_by,
--     drop column if exists whatsapp_grandfather_revoked_reason,
--     drop column if exists whatsapp_grandfather_revoked_at,
--     drop column if exists whatsapp_grandfathered_source,
--     drop column if exists whatsapp_grandfathered_at,
--     drop column if exists whatsapp_legacy_grandfathered;
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260727100200_079_whatsapp_legacy_grandfathering.sql
git commit -m "feat(billing): grandfathering de WhatsApp com revogacao terminal"
```

---

## Task 4: Migration 080 — flags da fase

**Files:**
- Create: `supabase/migrations/20260727100300_080_platform_flags_billing_5b.sql`

**Interfaces:**
- Produces: chaves `billing_invoice_ingestion`, `billing_invoice_ingestion_since` em `platform_flags`. Lidas pelas Tasks 9, 11 e 12.

- [ ] **Step 1: Escrever a migration**

```sql
-- Flags da Fase 5b. Todas OFF; ligar é decisão explícita, na ordem do runbook.
--
-- SEPARADAS DE PROPÓSITO de `whatsapp_service_enforcement` (criada na 075):
-- esta controla a ENTRADA de dados (criação e correlação automática de
-- faturas), aquela controla as CONSEQUÊNCIAS operacionais da inadimplência.
-- Uma flag só obrigaria a ligar as duas juntas — e o ponto do desenho é pôr o
-- elo financeiro em produção, observar, e só depois permitir suspensões.
--
-- `billing_invoice_ingestion_since` NÃO é booleana: guarda a data ISO em que a
-- ingestão foi ligada. É ela que define "cobrança anterior ao go-live da
-- ingestão", que é o único critério automático de retenção por antiguidade.
-- Vazia = ingestão nunca ativada.

begin;

insert into platform_flags (key, value, description) values
  ('billing_invoice_ingestion', 'false',
   'Cria e correlaciona faturas internas automaticamente a partir das cobrancas do Asaas (PAYMENT_CREATED e reconciliacao). OFF ate a validacao em sandbox da Fase 5b.'),
  ('billing_invoice_ingestion_since', '""',
   'Data ISO (YYYY-MM-DD) em que billing_invoice_ingestion foi ligada. Cobranca com due_date anterior a esta data e retida com motivo PRE_GO_LIVE_INVOICE. Vazia = nunca ativada.')
on conflict (key) do nothing;

commit;

-- Validação (esperado: 4 linhas — as 2 novas e as 2 de WhatsApp da 075):
--   select key, value from platform_flags
--    where key in ('billing_invoice_ingestion', 'billing_invoice_ingestion_since',
--                  'whatsapp_subscription_checkout', 'whatsapp_service_enforcement');
--
-- Rollback:
--   delete from platform_flags
--    where key in ('billing_invoice_ingestion', 'billing_invoice_ingestion_since');
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260727100300_080_platform_flags_billing_5b.sql
git commit -m "feat(billing): flags de ingestao de fatura da fase 5b"
```

---

## Task 5: Núcleo puro da correlação

**Files:**
- Create: `supabase/functions/_shared/billing-correlation-core.ts`
- Test: `src/lib/billing-correlation-core.test.ts`

**Interfaces:**
- Produces: `type CorrelationSource`, `interface CorrelationCandidate`, `type CorrelationOutcome`, `function resolveCorrelation(candidates: CorrelationCandidate[]): CorrelationOutcome`, `const CORRELATION_RANK: Record<CorrelationSource, number>`. Consumido pela Task 8.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/billing-correlation-core.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveCorrelation,
  type CorrelationCandidate,
} from "../../supabase/functions/_shared/billing-correlation-core";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PLAN = "33333333-3333-3333-3333-333333333333";
const SUB = "44444444-4444-4444-4444-444444444444";

function c(p: Partial<CorrelationCandidate> & { source: CorrelationCandidate["source"] }): CorrelationCandidate {
  return {
    organizationId: null, subscriptionId: null, planId: null, purpose: null, ...p,
  };
}

describe("resolveCorrelation", () => {
  it("sem candidato com organização devolve unresolved", () => {
    expect(resolveCorrelation([]).kind).toBe("unresolved");
    expect(resolveCorrelation([c({ source: "billing_customer" })]).kind).toBe("unresolved");
  });

  it("resolve a renovação apenas pela assinatura do provedor", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, planId: PLAN, purpose: "subscription" }),
    ]);
    expect(out).toMatchObject({
      kind: "resolved", organizationId: ORG_A, subscriptionId: SUB,
      planId: PLAN, purpose: "subscription",
    });
  });

  it("degrau superior vence e o inferior só completa campo faltante", () => {
    const out = resolveCorrelation([
      c({ source: "checkout_session", organizationId: ORG_A, planId: "outro-plano", purpose: "implementation" }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB, purpose: "subscription" }),
    ]);
    // provider_subscription (rank 2) vence checkout_session (rank 4) em purpose;
    // planId vem do checkout porque a assinatura não trouxe.
    expect(out).toMatchObject({ kind: "resolved", purpose: "subscription", planId: "outro-plano", subscriptionId: SUB });
  });

  it("divergência de organização entre degraus é conflito, não escolha", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "checkout_session", organizationId: ORG_B }),
    ]);
    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.reason).toBe("organization_divergence");
      expect(out.sources.map((s) => s.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    }
  });

  it("candidato sem organização nunca gera conflito", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A }),
      c({ source: "billing_customer" }),
    ]);
    expect(out.kind).toBe("resolved");
  });

  it("registra em `via` todos os degraus que contribuíram", () => {
    const out = resolveCorrelation([
      c({ source: "external_reference", organizationId: ORG_A, planId: PLAN }),
      c({ source: "provider_subscription", organizationId: ORG_A, subscriptionId: SUB }),
    ]);
    if (out.kind !== "resolved") throw new Error("esperado resolved");
    expect(out.via).toEqual(["provider_subscription", "external_reference"]);
  });

  it("divergência de plano não é fatal — o degrau superior vence", () => {
    const out = resolveCorrelation([
      c({ source: "provider_subscription", organizationId: ORG_A, planId: "plano-da-assinatura" }),
      c({ source: "external_reference", organizationId: ORG_A, planId: "plano-do-checkout" }),
    ]);
    expect(out).toMatchObject({ kind: "resolved", planId: "plano-da-assinatura" });
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npm test -- billing-correlation-core`
Expected: FAIL — o módulo não existe.

- [ ] **Step 3: Escrever o núcleo**

```ts
// supabase/functions/_shared/billing-correlation-core.ts
/**
 * Núcleo PURO da correlação de um evento financeiro do Asaas com a
 * organização, a assinatura e o plano dele.
 *
 * ZERO dependências (sem Deno, sem supabase-js) — importável pelas Edge
 * Functions e pelo vitest do frontend (src/lib/billing-correlation-core.test.ts),
 * que é o único lugar onde isto roda em CI (Deno não está instalado).
 *
 * A CAMADA DE I/O levanta os candidatos (cada um é uma consulta ao banco); este
 * módulo só decide. Nenhuma correlação por valor, data aproximada ou
 * "assinatura mais recente" — só identificadores do provedor.
 *
 * REDEPLOY: consumido por asaas-billing-events-apply.ts; ver o checklist do
 * CLAUDE.md para a lista de Edge Functions que precisam voltar juntas.
 */

export type CorrelationSource =
  | "known_invoice"
  | "provider_subscription"
  | "external_reference"
  | "checkout_session"
  | "billing_customer";

/**
 * Ordem da escada. Menor número vence. A ordem é por QUANTO cada fonte resolve
 * com certeza, não por conveniência:
 *  1. fatura já conhecida — a linha já existe aqui, tem tudo;
 *  2. assinatura do provedor — é o ÚNICO elo que a renovação do mês 2+ carrega;
 *  3. referência externa — presente na cobrança direta, ausente no checkout;
 *  4. sessão de checkout — traz org, plano e propósito da 1ª cobrança;
 *  5. cliente do provedor — resolve só a organização, e no checkout hospedado
 *     o pagador gera um cliente NOVO, então nem sempre resolve.
 */
export const CORRELATION_RANK: Record<CorrelationSource, number> = {
  known_invoice: 1,
  provider_subscription: 2,
  external_reference: 3,
  checkout_session: 4,
  billing_customer: 5,
};

export interface CorrelationCandidate {
  source: CorrelationSource;
  organizationId: string | null;
  /** id interno de billing_subscriptions, não o `sub_…` do provedor. */
  subscriptionId: string | null;
  planId: string | null;
  purpose: string | null;
}

export type CorrelationOutcome =
  | {
      kind: "resolved";
      organizationId: string;
      subscriptionId: string | null;
      planId: string | null;
      purpose: string | null;
      /** Degraus que contribuíram com algum campo, do mais forte ao mais fraco. */
      via: CorrelationSource[];
      /** Degraus que discordaram em plano/purpose. Não é fatal; é para log. */
      softDivergence: CorrelationSource[];
    }
  | { kind: "unresolved"; reason: "no_candidate" }
  | {
      kind: "conflict";
      reason: "organization_divergence";
      sources: { source: CorrelationSource; organizationId: string }[];
    };

export function resolveCorrelation(candidates: CorrelationCandidate[]): CorrelationOutcome {
  const ordered = [...candidates].sort(
    (a, b) => CORRELATION_RANK[a.source] - CORRELATION_RANK[b.source],
  );

  // Divergência de ORGANIZAÇÃO é fatal e é checada ANTES de qualquer outra
  // coisa: escrever no tenant errado é pior que atrasar um pagamento. Candidato
  // sem organização não participa — ele não discorda, ele não sabe.
  const withOrg = ordered.filter(
    (x): x is CorrelationCandidate & { organizationId: string } => !!x.organizationId,
  );
  const distinctOrgs = new Set(withOrg.map((x) => x.organizationId));
  if (distinctOrgs.size > 1) {
    return {
      kind: "conflict",
      reason: "organization_divergence",
      sources: withOrg.map((x) => ({ source: x.source, organizationId: x.organizationId })),
    };
  }

  if (withOrg.length === 0) {
    return { kind: "unresolved", reason: "no_candidate" };
  }

  const organizationId = withOrg[0].organizationId;
  let subscriptionId: string | null = null;
  let planId: string | null = null;
  let purpose: string | null = null;
  const via: CorrelationSource[] = [];
  const softDivergence: CorrelationSource[] = [];

  for (const cand of ordered) {
    let contributed = cand.organizationId === organizationId;

    if (cand.subscriptionId) {
      if (subscriptionId === null) {
        subscriptionId = cand.subscriptionId;
        contributed = true;
      } else if (subscriptionId !== cand.subscriptionId) {
        softDivergence.push(cand.source);
      }
    }
    if (cand.planId) {
      if (planId === null) {
        planId = cand.planId;
        contributed = true;
      } else if (planId !== cand.planId) {
        softDivergence.push(cand.source);
      }
    }
    if (cand.purpose) {
      if (purpose === null) {
        purpose = cand.purpose;
        contributed = true;
      } else if (purpose !== cand.purpose) {
        softDivergence.push(cand.source);
      }
    }

    if (contributed && !via.includes(cand.source)) via.push(cand.source);
  }

  return { kind: "resolved", organizationId, subscriptionId, planId, purpose, via, softDivergence };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npm test -- billing-correlation-core`
Expected: PASS, 7 testes.

- [ ] **Step 5: Rodar typecheck**

Run: `npm run typecheck`
Expected: 0 erros.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/billing-correlation-core.ts src/lib/billing-correlation-core.test.ts
git commit -m "feat(billing): nucleo puro da escada de correlacao de eventos Asaas"
```

---

## Task 6: Núcleo puro do estado financeiro

**Files:**
- Create: `supabase/functions/_shared/billing-financial-state-core.ts`
- Test: `src/lib/billing-financial-state-core.test.ts`

**Interfaces:**
- Consumes: `GRACE_PERIOD_DAYS`, `BLOCK_AFTER_DAYS`, `todayBrt`, `addDaysToDate`, `daysOverdue` de `_shared/billing-delinquency-core.ts` (núcleo puro já existente).
- Produces: `type FinancialState`, `interface FinancialStateInput`, `interface FinancialStateResult`, `function normalizeFinancialState(i: FinancialStateInput): FinancialStateResult`. Consumido pelas Tasks 7, 12 e 17.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/billing-financial-state-core.test.ts
import { describe, it, expect } from "vitest";
import { normalizeFinancialState } from "../../supabase/functions/_shared/billing-financial-state-core";

// 2026-07-27T15:00:00Z = 12:00 BRT do dia 27.
const NOW = "2026-07-27T15:00:00Z";

describe("normalizeFinancialState", () => {
  it("sem assinatura devolve NO_SUBSCRIPTION", () => {
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: null, canceledAt: null, oldestOpenInvoice: null }).state,
    ).toBe("NO_SUBSCRIPTION");
  });

  it("assinatura cancelada devolve CANCELED mesmo com fatura em aberto", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "canceled", canceledAt: "2026-07-01T00:00:00Z",
        oldestOpenInvoice: { dueDate: "2026-07-01", status: "open" },
      }).state,
    ).toBe("CANCELED");
  });

  it("sem fatura em aberto está em dia, mesmo com status past_due", () => {
    // Pagamento posterior converge: a fatura foi liquidada, o status ainda não
    // tinha sido reconciliado.
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: "past_due", canceledAt: null, oldestOpenInvoice: null }).state,
    ).toBe("PAID");
  });

  it("fatura que ainda não venceu está em dia", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "active", canceledAt: null,
        oldestOpenInvoice: { dueDate: "2026-07-30", status: "open" },
      }).state,
    ).toBe("PAID");
  });

  it("D+1 até D+5 é tolerância", () => {
    for (const [due, dias] of [["2026-07-26", 1], ["2026-07-22", 5]] as const) {
      const r = normalizeFinancialState({
        now: NOW, subscriptionStatus: "past_due", canceledAt: null,
        oldestOpenInvoice: { dueDate: due, status: "open" },
      });
      expect(r.state).toBe("IN_GRACE");
      expect(r.daysOverdue).toBe(dias);
    }
  });

  it("D+6 passa da tolerância", () => {
    const r = normalizeFinancialState({
      now: NOW, subscriptionStatus: "past_due", canceledAt: null,
      oldestOpenInvoice: { dueDate: "2026-07-21", status: "open" },
    });
    expect(r.state).toBe("OVERDUE_BEYOND_GRACE");
    expect(r.daysOverdue).toBe(6);
  });

  it("graceEndsAt é due_date + 5 dias e existe só quando há fatura vencida", () => {
    expect(
      normalizeFinancialState({
        now: NOW, subscriptionStatus: "past_due", canceledAt: null,
        oldestOpenInvoice: { dueDate: "2026-07-26", status: "open" },
      }).graceEndsAt,
    ).toBe("2026-07-31");
    expect(
      normalizeFinancialState({ now: NOW, subscriptionStatus: "active", canceledAt: null, oldestOpenInvoice: null }).graceEndsAt,
    ).toBeNull();
  });

  it("fatura paga ou anulada não conta como atraso", () => {
    for (const status of ["paid", "void", "uncollectible"]) {
      expect(
        normalizeFinancialState({
          now: NOW, subscriptionStatus: "past_due", canceledAt: null,
          oldestOpenInvoice: { dueDate: "2026-07-01", status },
        }).state,
      ).toBe("PAID");
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npm test -- billing-financial-state-core`
Expected: FAIL — o módulo não existe.

- [ ] **Step 3: Escrever o núcleo**

```ts
// supabase/functions/_shared/billing-financial-state-core.ts
/**
 * Núcleo PURO que traduz o mundo do provedor em estado financeiro interno.
 *
 * POR QUE EXISTE: `active`, `past_due`, `unpaid`, `RECEIVED`, `CONFIRMED`,
 * `OVERDUE` são vocabulário do Asaas e do Stripe. Deixar esses nomes vazarem
 * para o núcleo de decisão amarra a regra de negócio ao provedor da vez — e a
 * migração Stripe→Asaas em curso é a prova de que ele muda.
 *
 * Importa APENAS outro núcleo puro (billing-delinquency-core.ts), de onde vêm a
 * escada de dias e as contas de data em BRT. Nenhum import de Deno ou
 * supabase-js: isto roda em vitest, que é o único CI que alcança esta lógica.
 */

import {
  BLOCK_AFTER_DAYS,
  GRACE_PERIOD_DAYS,
  addDaysToDate,
  daysOverdue,
  todayBrt,
} from "./billing-delinquency-core.ts";

export type FinancialState =
  /** Não existe assinatura da categoria para esta organização. */
  | "NO_SUBSCRIPTION"
  /** Em dia: sem fatura vencida em aberto. */
  | "PAID"
  /** Vencida, dentro da tolerância (D+1..D+5). */
  | "IN_GRACE"
  /** Vencida além da tolerância (D+6 em diante) — suspender. */
  | "OVERDUE_BEYOND_GRACE"
  /** Assinatura cancelada. */
  | "CANCELED";

export interface FinancialStateInput {
  /** ISO. Injetável nos testes; a camada de I/O passa `new Date().toISOString()`. */
  now: string;
  /** billing_subscriptions.status, ou null quando não há assinatura. */
  subscriptionStatus: string | null;
  canceledAt: string | null;
  /**
   * Fatura em aberto mais ANTIGA da assinatura. A camada de I/O já exclui as
   * que estão com `enforcement_hold` — fatura retida para revisão não conta
   * como atraso, por definição.
   */
  oldestOpenInvoice: { dueDate: string; status: string } | null;
}

export interface FinancialStateResult {
  state: FinancialState;
  /** due_date + GRACE_PERIOD_DAYS. Derivado, nunca armazenado. */
  graceEndsAt: string | null;
  daysOverdue: number | null;
}

/** Status de fatura que representam dívida viva. Os demais não geram atraso. */
const OPEN_INVOICE_STATUSES = new Set(["open", "draft"]);

export function normalizeFinancialState(i: FinancialStateInput): FinancialStateResult {
  const none: FinancialStateResult = { state: "PAID", graceEndsAt: null, daysOverdue: null };

  if (i.canceledAt || i.subscriptionStatus === "canceled") {
    return { state: "CANCELED", graceEndsAt: null, daysOverdue: null };
  }
  if (!i.subscriptionStatus) {
    return { state: "NO_SUBSCRIPTION", graceEndsAt: null, daysOverdue: null };
  }

  const inv = i.oldestOpenInvoice;
  if (!inv || !OPEN_INVOICE_STATUSES.has(inv.status)) return none;

  const today = todayBrt(new Date(i.now).getTime());
  const overdue = daysOverdue(inv.dueDate, today);
  const graceEndsAt = addDaysToDate(inv.dueDate, GRACE_PERIOD_DAYS);

  if (overdue < 1) return none;
  if (overdue >= BLOCK_AFTER_DAYS) {
    return { state: "OVERDUE_BEYOND_GRACE", graceEndsAt, daysOverdue: overdue };
  }
  return { state: "IN_GRACE", graceEndsAt, daysOverdue: overdue };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npm test -- billing-financial-state-core`
Expected: PASS, 8 testes.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/billing-financial-state-core.ts src/lib/billing-financial-state-core.test.ts
git commit -m "feat(billing): nucleo puro de normalizacao do estado financeiro"
```

---

## Task 7: Núcleo puro dos sete estados do serviço de WhatsApp

**Files:**
- Create: `supabase/functions/_shared/whatsapp-service-state-core.ts`
- Test: `src/lib/whatsapp-service-state-core.test.ts`

**Interfaces:**
- Consumes: `FinancialState` de `_shared/billing-financial-state-core.ts` (Task 6).
- Produces: `type WhatsAppServiceState`, `interface WhatsAppGateInput`, `interface WhatsAppGateDecision`, `function systemBlocksDependentServices(billingStatus: string): boolean`, `function resolveWhatsAppServiceState(i: WhatsAppGateInput): WhatsAppServiceState`, `function decideWhatsAppGate(i: WhatsAppGateInput): WhatsAppGateDecision`. Consumido pelas Tasks 13–17 e 20.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/whatsapp-service-state-core.test.ts
import { describe, it, expect } from "vitest";
import {
  decideWhatsAppGate,
  systemBlocksDependentServices,
  type WhatsAppGateInput,
} from "../../supabase/functions/_shared/whatsapp-service-state-core";

function gate(p: Partial<WhatsAppGateInput> = {}) {
  return decideWhatsAppGate({
    systemBillingStatus: "active",
    financialState: "NO_SUBSCRIPTION",
    hasActiveWhatsAppOverride: false,
    hasWhatsAppAdminBlock: false,
    isLegacyGrandfathered: false,
    ...p,
  });
}

describe("systemBlocksDependentServices", () => {
  it("bloqueia nos três estados de acesso negado", () => {
    for (const s of ["blocked", "suspended", "canceled"]) {
      expect(systemBlocksDependentServices(s)).toBe(true);
    }
  });

  it("não bloqueia nos estados de tolerância nem no normal", () => {
    for (const s of ["active", "trialing", "grace_period", "past_due", "pending_payment", "manual_override"]) {
      expect(systemBlocksDependentServices(s)).toBe(false);
    }
  });
});

describe("decideWhatsAppGate — estados", () => {
  it("bloqueio administrativo vence tudo, inclusive override", () => {
    const d = gate({ hasWhatsAppAdminBlock: true, hasActiveWhatsAppOverride: true, financialState: "PAID" });
    expect(d.state).toBe("ADMIN_BLOCKED");
    expect(d.sendingBlocked).toBe(true);
  });

  it("override prevalece sobre inadimplência do WhatsApp", () => {
    const d = gate({ hasActiveWhatsAppOverride: true, financialState: "OVERDUE_BEYOND_GRACE" });
    expect(d.state).toBe("OVERRIDE_ACTIVE");
    expect(d.sendingBlocked).toBe(false);
    expect(d.newProvisioningBlocked).toBe(false);
  });

  it("assinatura em dia é ACTIVE; em tolerância é GRACE_PERIOD; além dela é SUSPENDED_UNPAID", () => {
    expect(gate({ financialState: "PAID" }).state).toBe("ACTIVE");
    expect(gate({ financialState: "IN_GRACE" }).state).toBe("GRACE_PERIOD");
    expect(gate({ financialState: "OVERDUE_BEYOND_GRACE" }).state).toBe("SUSPENDED_UNPAID");
  });

  it("assinatura cancelada cai para o nível seguinte", () => {
    expect(gate({ financialState: "CANCELED", isLegacyGrandfathered: true }).state).toBe("LEGACY_GRANDFATHERED");
    expect(gate({ financialState: "CANCELED", isLegacyGrandfathered: false }).state).toBe("NOT_ENTITLED");
  });

  it("sem nada é NOT_ENTITLED", () => {
    expect(gate().state).toBe("NOT_ENTITLED");
  });
});

describe("decideWhatsAppGate — as duas perguntas", () => {
  it("só SUSPENDED_UNPAID e ADMIN_BLOCKED bloqueiam envio", () => {
    expect(gate({ financialState: "PAID" }).sendingBlocked).toBe(false);
    expect(gate({ financialState: "IN_GRACE" }).sendingBlocked).toBe(false);
    expect(gate({ isLegacyGrandfathered: true }).sendingBlocked).toBe(false);
    expect(gate().sendingBlocked).toBe(false); // NOT_ENTITLED
    expect(gate({ financialState: "OVERDUE_BEYOND_GRACE" }).sendingBlocked).toBe(true);
    expect(gate({ hasWhatsAppAdminBlock: true }).sendingBlocked).toBe(true);
  });

  it("só ACTIVE e OVERRIDE_ACTIVE permitem instância nova", () => {
    expect(gate({ financialState: "PAID" }).newProvisioningBlocked).toBe(false);
    expect(gate({ hasActiveWhatsAppOverride: true }).newProvisioningBlocked).toBe(false);
    expect(gate({ financialState: "IN_GRACE" }).newProvisioningBlocked).toBe(true);
    expect(gate({ isLegacyGrandfathered: true }).newProvisioningBlocked).toBe(true);
    expect(gate().newProvisioningBlocked).toBe(true);
  });
});

describe("decideWhatsAppGate — gate pai do sistema", () => {
  it("sistema suspenso bloqueia WhatsApp MESMO com override ativo", () => {
    const d = gate({ systemBillingStatus: "blocked", hasActiveWhatsAppOverride: true, financialState: "PAID" });
    expect(d.state).toBe("OVERRIDE_ACTIVE"); // o estado do WhatsApp não muda...
    expect(d.systemBlocked).toBe(true);      // ...mas o gate pai fecha
    expect(d.sendingBlocked).toBe(true);
    expect(d.newProvisioningBlocked).toBe(true);
    expect(d.reason).toBe("system_blocked");
  });

  it("sistema em tolerância não bloqueia o WhatsApp", () => {
    expect(gate({ systemBillingStatus: "grace_period", financialState: "PAID" }).sendingBlocked).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npm test -- whatsapp-service-state-core`
Expected: FAIL — o módulo não existe.

- [ ] **Step 3: Escrever o núcleo**

```ts
// supabase/functions/_shared/whatsapp-service-state-core.ts
/**
 * Núcleo PURO do estado do serviço de WhatsApp de uma organização.
 *
 * POR QUE NÃO É UM BOOLEANO: `entitlements.whatsapp.allowed` é `false` tanto
 * para quem foi suspenso por não pagar quanto para quem nunca comprou a
 * instância — e as duas situações exigem tratamentos opostos. Ligar o gate de
 * envio por `!allowed` silenciaria, na hora, todo cliente que já usa WhatsApp e
 * nunca contratou. Os sete estados existem para essa distinção não se perder.
 *
 * Importa apenas outro núcleo puro (billing-financial-state-core.ts).
 */

import type { FinancialState } from "./billing-financial-state-core.ts";

export type WhatsAppServiceState =
  | "ACTIVE"
  | "GRACE_PERIOD"
  | "OVERRIDE_ACTIVE"
  | "LEGACY_GRANDFATHERED"
  | "NOT_ENTITLED"
  | "SUSPENDED_UNPAID"
  | "ADMIN_BLOCKED";

export interface WhatsAppGateInput {
  /** organizations.billing_status — coluna autoritativa. */
  systemBillingStatus: string;
  /** Estado financeiro da assinatura WHATSAPP_SUBSCRIPTION (Task 6). */
  financialState: FinancialState;
  /** Override de `whatsapp` com enabled=true, válido agora. */
  hasActiveWhatsAppOverride: boolean;
  /** Override de `whatsapp` com enabled=false, válido agora. */
  hasWhatsAppAdminBlock: boolean;
  /** `whatsapp_legacy_grandfathered AND whatsapp_grandfather_revoked_at IS NULL`. */
  isLegacyGrandfathered: boolean;
}

export interface WhatsAppGateDecision {
  state: WhatsAppServiceState;
  systemBlocked: boolean;
  sendingBlocked: boolean;
  newProvisioningBlocked: boolean;
  /** Motivo machine-readable, para log e telemetria de dry-run. */
  reason: string;
}

/**
 * O acesso ao sistema é gate PAI: um override de WhatsApp cobre o custo da
 * instância, não o direito de operar um sistema bloqueado.
 *
 * Lê `organizations.billing_status` DE PROPÓSITO, e não
 * `entitlements.system.allowed`: aquele campo é `false` para organização legada
 * com `billing_status='active'` e sem assinatura de sistema, o que bloquearia
 * exatamente quem nunca deveria ser bloqueado. Os três valores abaixo são os
 * mesmos que o BillingGuard já trata como acesso negado no frontend e que
 * create-reservation e webhook-whatsapp já recusam no servidor. `grace_period`
 * e `past_due` NÃO entram: são tolerância, não bloqueio.
 */
export function systemBlocksDependentServices(billingStatus: string): boolean {
  return billingStatus === "blocked" || billingStatus === "suspended" || billingStatus === "canceled";
}

/** Só o estado do WhatsApp, sem o gate pai. Exportado para log e para a UI. */
export function resolveWhatsAppServiceState(i: WhatsAppGateInput): WhatsAppServiceState {
  if (i.hasWhatsAppAdminBlock) return "ADMIN_BLOCKED";
  if (i.hasActiveWhatsAppOverride) return "OVERRIDE_ACTIVE";

  switch (i.financialState) {
    case "PAID":
      return "ACTIVE";
    case "IN_GRACE":
      return "GRACE_PERIOD";
    case "OVERDUE_BEYOND_GRACE":
      return "SUSPENDED_UNPAID";
    case "CANCELED":
    case "NO_SUBSCRIPTION":
      break;
  }

  return i.isLegacyGrandfathered ? "LEGACY_GRANDFATHERED" : "NOT_ENTITLED";
}

/** Estados que interrompem envio já existente. */
const BLOCKS_SENDING: ReadonlySet<WhatsAppServiceState> = new Set(["SUSPENDED_UNPAID", "ADMIN_BLOCKED"]);

/** Estados que autorizam gerar custo externo NOVO. */
const ALLOWS_NEW_PROVISIONING: ReadonlySet<WhatsAppServiceState> = new Set(["ACTIVE", "OVERRIDE_ACTIVE"]);

/**
 * Decisão completa. Uma função só, e não dois predicados soltos, porque o gate
 * pai precisa entrar nas DUAS respostas — deixar o caller montar a conjunção é
 * deixá-lo esquecer metade dela.
 */
export function decideWhatsAppGate(i: WhatsAppGateInput): WhatsAppGateDecision {
  const state = resolveWhatsAppServiceState(i);
  const systemBlocked = systemBlocksDependentServices(i.systemBillingStatus);

  const sendingBlocked = systemBlocked || BLOCKS_SENDING.has(state);
  const newProvisioningBlocked = systemBlocked || !ALLOWS_NEW_PROVISIONING.has(state);

  const reason = systemBlocked ? "system_blocked" : `whatsapp_${state.toLowerCase()}`;

  return { state, systemBlocked, sendingBlocked, newProvisioningBlocked, reason };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npm test -- whatsapp-service-state-core`
Expected: PASS, 11 testes.

- [ ] **Step 5: Rodar a suíte inteira e o typecheck**

Run: `npm test && npm run typecheck`
Expected: 265 + 26 novos = **291 testes passando**, 0 erros de tipo.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/whatsapp-service-state-core.ts src/lib/whatsapp-service-state-core.test.ts
git commit -m "feat(billing): nucleo puro dos sete estados do servico de WhatsApp"
```

---

## Task 8: Escada de correlação no aplicador de eventos

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events-apply.ts`

**Interfaces:**
- Consumes: `resolveCorrelation`, `CorrelationCandidate` de `_shared/billing-correlation-core.ts` (Task 5).
- Produces: dentro de `applyAsaasEvent`, as variáveis `organizationId`, `planId`, `purpose` e a nova `resolvedSubscriptionId` passam a vir de `resolveCorrelation`. Nenhuma assinatura pública muda.

**Contexto obrigatório:** ler `applyAsaasEvent` inteira em [supabase/functions/_shared/asaas-billing-events-apply.ts](../../../supabase/functions/_shared/asaas-billing-events-apply.ts) antes de editar. O trecho a substituir vai do bloco que lê `res.data.externalReference` até o fim do bloco de reidratação por `checkoutSession`. **Preservar tudo o mais intacto**, em especial: o guard `typeof subRef === "string"` que grava `providerSubscriptionId` (§13.6 — cobrança avulsa OMITE o campo, não manda `null`), a validação de `res.data.value` com `asaasValueToCents`, e o comentário que explica por que a reidratação não é gateada por `!organizationId`.

- [ ] **Step 1: Importar o núcleo**

```ts
import {
  resolveCorrelation,
  type CorrelationCandidate,
} from "./billing-correlation-core.ts";
```

- [ ] **Step 2: Acumular candidatos em vez de atribuir direto**

Onde hoje há atribuições espalhadas (`organizationId = organizationId ?? parsed.orgId`, `organizationId = cust?.organization_id ?? null`, o bloco do `checkoutSession`), trocar por: cada consulta empurra um candidato no array e **não** escreve nas variáveis. As consultas em si (as chamadas `supabase.from(...)`) ficam como estão, inclusive o tratamento de `error` que já devolve `failWith` — erro de leitura continua sendo falha alta.

Declarar, junto de `organizationId`/`planId`/`purpose`, a variável nova que a assinatura resolvida vai ocupar:

```ts
// id INTERNO de billing_subscriptions (não o `sub_…` do provedor, que continua
// em `providerSubscriptionId`). Alimenta o `billing_subscription_id` da fatura
// criada no efeito `upsert_open_invoice`.
let resolvedSubscriptionId: string | null = null;
```

```ts
const candidates: CorrelationCandidate[] = [];

// Degrau 1 — a fatura já conhecida deste pagamento (carregada no passo 1 da
// função). Traz tudo e é a fonte mais forte.
if (invoice) {
  candidates.push({
    source: "known_invoice",
    organizationId: invoice.organization_id,
    subscriptionId: invoice.billing_subscription_id,
    planId: null,
    purpose: null,
  });
}

// Degrau 2 — assinatura do provedor. É o ÚNICO elo que a renovação do mês 2+
// carrega: ela nasce da assinatura, sem externalReference (o Asaas não propaga
// — §13.8), sem checkoutSession, e com um `customer` que pode ser o que o
// pagador criou na página hospedada. Sem este degrau, nenhuma renovação é
// processada.
if (providerSubscriptionId) {
  const { data: sub, error: subErr } = await supabase
    .from("billing_subscriptions")
    .select("id, organization_id, billing_plan_id")
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle();
  if (subErr) {
    return failWith(
      row.organization_id,
      "unknown",
      "select_subscription_by_provider_id",
      subErr,
      "Falha ao correlacionar a assinatura do evento — ver logs.",
    );
  }
  if (sub) {
    candidates.push({
      source: "provider_subscription",
      organizationId: sub.organization_id as string,
      subscriptionId: sub.id as string,
      planId: sub.billing_plan_id as string,
      // Cobrança nascida de assinatura é sempre mensalidade. O `purpose` do
      // checkout original não sobrevive à renovação, e sem isto o evento cairia
      // no default `other` e não ativaria ninguém.
      purpose: "subscription",
    });
  } else {
    // Assinatura desconhecida: não é erro de leitura, é cobrança de uma
    // assinatura que este banco não conhece. Loga e segue para os degraus
    // seguintes — o reconcile pode resolver depois.
    jsonLog("warn", {
      evt: "asaas_unknown_provider_subscription",
      billing_event_id: row.id,
      provider_subscription_id: providerSubscriptionId,
    });
  }
}
```

Os degraus 3, 4 e 5 (`external_reference`, `checkout_session`, `billing_customer`) usam as mesmas consultas que já existem hoje; cada uma passa a empurrar seu candidato com a `source` correspondente, em vez de atribuir às variáveis.

- [ ] **Step 3: Decidir com o núcleo e tratar o conflito**

```ts
const correlation = resolveCorrelation(candidates);

if (correlation.kind === "conflict") {
  // Divergência de ORGANIZAÇÃO entre degraus. Até a Fase 5a isto apenas
  // logava (`asaas_checkout_session_org_mismatch`); agora derruba o evento.
  // Escrever no tenant errado é pior que atrasar um pagamento: o evento fica
  // na fila, o reconcile retenta, e um humano resolve.
  await notifyAdminCorrelationAmbiguity(supabase, {
    billingEventId: row.id,
    detail: correlation.sources.map((s) => `${s.source}=${s.organizationId}`).join(" / "),
  });
  return failWith(
    row.organization_id,
    effectKind,
    "organization_divergence",
    correlation.sources.map((s) => `${s.source}:${s.organizationId}`).join(","),
    "Evento correlacionado a organizações divergentes — requer conferência.",
  );
}

if (correlation.kind === "resolved") {
  organizationId = correlation.organizationId;
  resolvedSubscriptionId = correlation.subscriptionId;
  planId = correlation.planId;
  if (correlation.purpose) purpose = correlation.purpose as AsaasPurpose;

  if (correlation.softDivergence.length > 0) {
    // Plano ou propósito discordando entre degraus NÃO é fatal — o degrau
    // superior vence. Mas é anomalia que precisa aparecer: um plano trocado
    // entre a criação da sessão e o pagamento é legítimo; dois planos
    // aleatoriamente diferentes não são.
    jsonLog("warn", {
      evt: "asaas_correlation_soft_divergence",
      billing_event_id: row.id,
      sources: correlation.softDivergence,
      resolved_plan: planId,
      resolved_purpose: purpose,
    });
  }
}
```

- [ ] **Step 4: Escrever o aviso ao administrador**

Acrescentar, junto das demais funções auxiliares do arquivo:

```ts
/**
 * Avisa a Moralles (não o cliente) de que um evento precisa de conferência
 * humana. Best-effort: NUNCA derruba o resultado financeiro que a chamou —
 * mesma filosofia de `confirmImplementationPayment`.
 *
 * Usa `resolvePlatformAdminRecipients`, e não `resolveBillingRecipient`, que é
 * org-scoped de propósito: aqui o destinatário é a própria plataforma.
 * `invoiceId: null` NÃO é deduplicado pelo índice parcial — daí o `evt` no log
 * ser a fonte de verdade sobre quantas vezes isto aconteceu.
 */
async function notifyAdminCorrelationAmbiguity(
  supabase: SupabaseClient,
  args: { billingEventId: string; detail: string },
): Promise<void> {
  try {
    jsonLog("error", {
      evt: "asaas_correlation_ambiguity",
      billing_event_id: args.billingEventId,
      detail: args.detail,
    });
    const recipients = await resolvePlatformAdminRecipients(supabase);
    if (recipients.length === 0) return;
    await enqueueBillingNotification(supabase, {
      organizationId: null,
      eventType: "admin_correlation_ambiguity",
      invoiceId: null,
      recipient: recipients[0],
    });
  } catch (err) {
    jsonLog("warn", { evt: "asaas_correlation_ambiguity_notify_failed", err: String(err) });
  }
}
```

**Atenção:** `enqueueBillingNotification` tipa `organizationId: string`. Ampliar a assinatura para `string | null` em [_shared/billing-notify.ts](../../../supabase/functions/_shared/billing-notify.ts) e confirmar que `billing_notifications.organization_id` aceita `null`; se a coluna for `not null`, passar a organização do evento (`row.organization_id`) e registrar no log que o aviso é interno.

- [ ] **Step 5: Verificar sintaxe (Deno não está instalado)**

Run: `npx esbuild supabase/functions/_shared/asaas-billing-events-apply.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null`
Expected: sem erro de sintaxe. Revisar manualmente que nenhuma variável ficou órfã depois da troca das atribuições.

- [ ] **Step 6: Rodar a suíte e o typecheck**

Run: `npm test && npm run typecheck`
Expected: 291 passando, 0 erros. (Este arquivo não é alcançado por nenhum dos dois — a verificação é a regressão dos demais.)

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events-apply.ts supabase/functions/_shared/billing-notify.ts
git commit -m "feat(billing): escada de correlacao com degrau de assinatura do provedor"
```

---

## Task 9: `PAYMENT_CREATED` cria a fatura em aberto

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events.ts`
- Modify: `supabase/functions/_shared/asaas-billing-events-apply.ts`
- Test: `src/lib/asaas-billing-events.test.ts` (arquivo existente — acrescentar bloco)

**Interfaces:**
- Consumes: escada de correlação da Task 8; flag `billing_invoice_ingestion` da Task 4; colunas da Task 1.
- Produces: `AsaasEffectKind` ganha `"upsert_open_invoice"`; `decideEventEffect` devolve esse efeito para `PAYMENT_CREATED`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar ao final de `src/lib/asaas-billing-events.test.ts`:

```ts
describe("decideEventEffect — PAYMENT_CREATED (Fase 5b)", () => {
  it("cria fatura em aberto quando ainda não há linha correlacionada", () => {
    const e = decideEventEffect({ eventType: "PAYMENT_CREATED", invoiceStatus: null });
    expect(e.kind).toBe("upsert_open_invoice");
  });

  it("é no-op quando a fatura já existe em estado terminal", () => {
    for (const status of ["paid", "void"]) {
      expect(decideEventEffect({ eventType: "PAYMENT_CREATED", invoiceStatus: status }).kind).toBe("noop");
    }
  });

  it("é no-op quando a fatura já existe em aberto — nada a criar", () => {
    expect(decideEventEffect({ eventType: "PAYMENT_CREATED", invoiceStatus: "open" }).kind).toBe("noop");
  });

  it("PAYMENT_UPDATED continua informativo", () => {
    expect(decideEventEffect({ eventType: "PAYMENT_UPDATED", invoiceStatus: null }).kind).toBe("noop");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test -- asaas-billing-events`
Expected: FAIL — hoje `PAYMENT_CREATED` devolve `noop` com razão "é informativo".

- [ ] **Step 3: Alterar o núcleo puro**

Em `_shared/asaas-billing-events.ts`:

1. Acrescentar `"upsert_open_invoice"` à união `AsaasEffectKind` (a mesma que já tem `"mark_invoice_overdue"`).
2. Remover `"PAYMENT_CREATED"` do set `INFORMATIONAL_EVENTS`.
3. Em `decideEventEffect`, **antes** do bloco de `INFORMATIONAL_EVENTS`, acrescentar:

```ts
  if (eventType === "PAYMENT_CREATED") {
    // Já existe linha para esta cobrança: nada a criar. Vale tanto para a
    // fatura em aberto (webhook duplicado, reconcile passou antes) quanto para
    // a terminal (evento tardio sobre cobrança já liquidada).
    if (invoiceStatus) {
      return { kind: "noop", reason: `Invoice já em '${invoiceStatus}' — cobrança já registrada.` };
    }
    // ESTE é o elo que faltava: sem ele a cobrança da renovação nunca vira
    // fatura interna, o PAYMENT_OVERDUE seguinte não acha linha para marcar, e
    // process-billing-overdue roda sobre entrada vazia para sempre.
    return { kind: "upsert_open_invoice", reason: "Cobrança criada no provedor — registrar fatura em aberto." };
  }
```

4. Atualizar o JSDoc de `decideEventEffect` acrescentando a obrigação 4: *"`upsert_open_invoice` só escreve quando a flag `billing_invoice_ingestion` está ligada; com ela desligada o consumidor trata como `noop` e o evento sai `processed`."*

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test -- asaas-billing-events`
Expected: PASS.

- [ ] **Step 5: Implementar o efeito no aplicador**

Em `applyAsaasEvent`, acrescentar o `case` ao switch de efeitos:

```ts
case "upsert_open_invoice": {
  // Gate de flag: com a ingestão desligada, o evento é reconhecido e sai
  // `processed` sem escrever. Ligar a ingestão dá entrada real ao
  // process-billing-overdue — inclusive para a mensalidade do SISTEMA, que
  // hoje roda sobre vazio. É por isso que tem flag própria, separada do
  // enforcement.
  const ingestionOn = await isFlagEnabled("billing_invoice_ingestion");
  if (!ingestionOn) {
    jsonLog("info", { evt: "asaas_invoice_ingestion_disabled", billing_event_id: row.id });
    break;
  }
  if (!organizationId) {
    return failWith(
      null, effectKind, "upsert_open_invoice_no_org",
      `cobrança ${paymentId} sem organização correlacionável`,
      "Cobrança sem organização identificável — ver logs.",
    );
  }
  if (!paymentId) {
    return failWith(
      organizationId, effectKind, "upsert_open_invoice_no_payment_id",
      `evento ${row.event_type} sem 'payment.id'`,
      "Evento de cobrança sem identificador — ver logs.",
    );
  }

  // `dueDate` vem do payload do getPayment. CONFERIR O ESCOPO: hoje `res` é
  // declarado dentro do bloco que busca o pagamento, então provavelmente é
  // preciso guardar `paymentDueDate` numa variável ao lado de `paidValueCents`
  // (que já é extraída do mesmo payload) em vez de referenciar `res` aqui.
  // Repetir o padrão de validação de `paidValueCents`: campo ausente é anomalia
  // de payload e loga, não passa em silêncio.
  if (!paymentDueDate) {
    return failWith(
      organizationId, effectKind, "upsert_open_invoice_no_due_date",
      `cobrança ${paymentId} sem dueDate`,
      "Cobrança sem data de vencimento — ver logs.",
    );
  }

  const hold = await decideIngestionHold({ dueDate: paymentDueDate, source: "WEBHOOK" });

  const { error: insErr } = await supabase.from("billing_invoices").insert({
    organization_id: organizationId,
    billing_subscription_id: resolvedSubscriptionId,
    provider: "asaas",
    provider_payment_id: paymentId,
    status: "open",
    amount_cents: paidValueCents ?? 0,
    payment_method: paymentMethod,
    due_date: paymentDueDate,
    purpose,
    external_reference: externalReferenceRaw,
    ingestion_source: "WEBHOOK",
    enforcement_hold: hold.hold,
    enforcement_hold_reason: hold.reason,
    enforcement_held_at: hold.hold ? new Date().toISOString() : null,
  });
  // 23505 = a UNIQUE (provider, provider_payment_id) pegou: webhook e reconcile
  // encontraram o mesmo pagamento. É o caminho feliz da idempotência, não erro.
  if (insErr && insErr.code !== "23505") {
    return failWith(
      organizationId, effectKind, "insert_open_invoice", insErr,
      "Falha ao registrar a cobrança — ver logs.",
    );
  }
  break;
}
```

- [ ] **Step 6: Escrever o helper de retenção no mesmo arquivo**

```ts
/**
 * Decide se a fatura entra retida. RETENÇÃO É EXCEPCIONAL: fatura encontrada
 * tarde por falha temporária de webhook preserva vencimento e tolerância reais
 * — retê-la converteria em atraso justamente o conserto que a reconciliação
 * existe para fazer.
 *
 * Só dois motivos automáticos aqui: backfill declarado pelo caller, e cobrança
 * anterior ao go-live da ingestão. `VALUE_MISMATCH` e `CORRELATION_AMBIGUITY`
 * são retenções de OUTROS pontos do fluxo, não desta função.
 */
async function decideIngestionHold(
  args: { dueDate: string; source: "WEBHOOK" | "RECONCILE" | "BACKFILL" },
): Promise<{ hold: boolean; reason: string | null }> {
  if (args.source === "BACKFILL") return { hold: true, reason: "INITIAL_BACKFILL" };

  const since = await getFlagString("billing_invoice_ingestion_since", "");
  if (since && args.dueDate < since) {
    return { hold: true, reason: "PRE_GO_LIVE_INVOICE" };
  }
  return { hold: false, reason: null };
}
```

`isFlagEnabled(key)` e `getFlagString(key, fallback)` já existem em [_shared/platform-flags.ts](../../../supabase/functions/_shared/platform-flags.ts) e **não recebem o cliente Supabase** — conferir as assinaturas lá antes de chamar. Ajustar a chamada no `case` acima para `decideIngestionHold({ dueDate, source: "WEBHOOK" })`.

- [ ] **Step 7: Verificar sintaxe, rodar suíte e commitar**

```bash
npx esbuild supabase/functions/_shared/asaas-billing-events-apply.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
npm test && npm run typecheck
git add supabase/functions/_shared/asaas-billing-events.ts supabase/functions/_shared/asaas-billing-events-apply.ts supabase/functions/_shared/platform-flags.ts src/lib/asaas-billing-events.test.ts
git commit -m "feat(billing): PAYMENT_CREATED registra fatura em aberto sob flag"
```

---

## Task 10: `listAsaasSubscriptionPayments` no cliente HTTP

**Files:**
- Modify: `supabase/functions/_shared/asaas.ts`

**Interfaces:**
- Produces: `listAsaasSubscriptionPayments(subscriptionId: string, opts?: { budgetMs?: number }): Promise<{ ok: boolean; data?: AsaasPaymentSummary[]; error?: string }>` e `interface AsaasPaymentSummary`. Consumido pela Task 11.

**Endpoint verificado:** `GET /v3/subscriptions/{id}/payments`, confirmado ao vivo no passo 3e de [03-ASAAS-API-VERIFICADO.md](../../billing-asaas/03-ASAAS-API-VERIFICADO.md). **Não implementar de memória** — conferir o documento antes de escrever.

- [ ] **Step 1: Acrescentar a função**

```ts
export interface AsaasPaymentSummary {
  id: string;
  status: string;
  /** Em REAIS — converter com asaasValueToCents antes de comparar com amount_cents. */
  value: number;
  dueDate: string;
  billingType: string | null;
  subscription: string | null;
  externalReference: string | null;
}

/**
 * Cobranças de uma assinatura. SÓ LEITURA: este cliente nunca cria cobrança na
 * reconciliação — `POST` não é retry-safe (§ "POST não é retry-safe" da API
 * verificada), e um retry cego geraria cobrança duplicada para o cliente.
 *
 * Pagina com `offset`/`limit`, como os demais list do Asaas, até `hasMore`
 * ficar falso. Sem paginação, uma assinatura antiga devolve só a primeira
 * página e a reconciliação silenciosamente "não encontra" cobranças que
 * existem.
 */
export async function listAsaasSubscriptionPayments(
  subscriptionId: string,
  opts?: AsaasRequestOptions,
): Promise<{ ok: boolean; data?: AsaasPaymentSummary[]; error?: string }> {
  const all: AsaasPaymentSummary[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const res = await asaasRequest(
      "GET",
      `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=${limit}&offset=${offset}`,
      undefined,
      opts,
    );
    if (!res.ok) return { ok: false, error: res.error };

    const body = res.data as { data?: AsaasPaymentSummary[]; hasMore?: boolean } | undefined;
    all.push(...(body?.data ?? []));
    if (!body?.hasMore) break;
    offset += limit;
  }

  return { ok: true, data: all };
}
```

**Ajustar a chamada de `asaasRequest` à assinatura real** que estiver no arquivo (conferir `asaasRequest` em [_shared/asaas.ts:255](../../../supabase/functions/_shared/asaas.ts) e imitar exatamente como `getAsaasSubscription` a chama).

- [ ] **Step 2: Verificar sintaxe e commitar**

```bash
npx esbuild supabase/functions/_shared/asaas.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/_shared/asaas.ts
git commit -m "feat(billing): listagem paginada das cobrancas de uma assinatura Asaas"
```

---

## Task 11: Worker `process-asaas-invoice-reconcile`

**Files:**
- Create: `supabase/functions/process-asaas-invoice-reconcile/index.ts`
- Create: `supabase/migrations/20260727100400_082_cron_asaas_invoice_reconcile.sql`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `listAsaasSubscriptionPayments` (Task 10), `isFlagEnabled`/`getFlagValue`, `resolvePlatformAdminRecipients`, `enqueueBillingNotification`, `asaasValueToCents`.
- Produces: worker HTTP autenticado por `x-internal-key`; job de cron `process-asaas-invoice-reconcile` às 08:00 UTC.

- [ ] **Step 1: Escrever o worker**

Estrutura obrigatória (seguir o formato de [process-billing-overdue/index.ts](../../../supabase/functions/process-billing-overdue/index.ts): `requireInternalAuth`, `genRequestId`, `jsonLog` com `reqId`, resposta JSON com contadores):

```ts
// Worker: reconcilia cobranças do Asaas com billing_invoices, nos dois sentidos.
// Roda diariamente via pg_cron.
//
// SÓ LEITURA contra o Asaas. Nunca cria cobrança nem assinatura: `POST` não é
// retry-safe e um retry cego duplicaria cobrança para o cliente.
//
// NUNCA sobrescreve estado administrativo: fatura `void`, `uncollectible` ou
// com `enforcement_hold` só muda por ação humana.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { isFlagEnabled, getFlagString } from "../_shared/platform-flags.ts";
import { listAsaasSubscriptionPayments } from "../_shared/asaas.ts";
import { asaasValueToCents } from "../_shared/asaas-core.ts";
import { resolvePlatformAdminRecipients, enqueueBillingNotification } from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/** Status do Asaas que significam dinheiro recebido. */
const SETTLED = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
```

Corpo do handler, depois de `requireInternalAuth`:

```ts
  // Gate de flag: com a ingestão desligada o worker não toca em nada. É a mesma
  // flag do PAYMENT_CREATED de propósito — as duas pontas da ingestão ligam
  // juntas, senão o webhook cria fatura e a reconciliação não confere, ou o
  // contrário.
  if (!(await isFlagEnabled("billing_invoice_ingestion"))) {
    return new Response(JSON.stringify({ skipped: "ingestion_disabled" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  const since = await getFlagString("billing_invoice_ingestion_since", "");
  const stats = {
    subscriptions_scanned: 0, payments_seen: 0, invoices_created: 0,
    invoices_settled: 0, invoices_held: 0, asaas_failures: 0,
  };

  const { data: subs, error: subsErr } = await supabase
    .from("billing_subscriptions")
    .select("id, organization_id, provider_subscription_id")
    .eq("provider", "asaas")
    .neq("status", "canceled")
    .not("provider_subscription_id", "is", null);
  if (subsErr) {
    jsonLog("error", { reqId, evt: "asaas_reconcile_subs_read_failed", err: subsErr.message });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }

  for (const sub of subs ?? []) {
    stats.subscriptions_scanned++;

    const res = await listAsaasSubscriptionPayments(sub.provider_subscription_id as string);
    if (!res.ok) {
      // Falha do Asaas NÃO pode corromper estado interno nem abortar a varredura
      // inteira: uma assinatura ilegível não é motivo para as outras não serem
      // conferidas. O worker roda amanhã de novo.
      stats.asaas_failures++;
      jsonLog("warn", {
        reqId, evt: "asaas_reconcile_list_failed",
        sub: sub.id, err: res.error,
      });
      continue;
    }

    for (const pay of res.data ?? []) {
      stats.payments_seen++;
      const cents = asaasValueToCents(pay.value);
      const settled = SETTLED.has(pay.status);

      const { data: inv, error: invErr } = await supabase
        .from("billing_invoices")
        .select("id, status, amount_cents, enforcement_hold")
        .eq("provider", "asaas")
        .eq("provider_payment_id", pay.id)
        .maybeSingle();
      if (invErr) {
        jsonLog("warn", { reqId, evt: "asaas_reconcile_invoice_read_failed", payment: pay.id, err: invErr.message });
        continue;
      }

      // (a) Cobrança que existe lá e não existe aqui — o buraco que a
      // reconciliação existe para tapar (webhook perdido, ingestão ligada
      // depois da cobrança nascer).
      if (!inv) {
        const isBackfill = !!since && pay.dueDate < since;
        const { error: insErr } = await supabase.from("billing_invoices").insert({
          organization_id: sub.organization_id,
          billing_subscription_id: sub.id,
          provider: "asaas",
          provider_payment_id: pay.id,
          status: settled ? "paid" : "open",
          paid_at: settled ? new Date().toISOString() : null,
          amount_cents: cents,
          due_date: pay.dueDate,
          external_reference: pay.externalReference,
          purpose: "subscription",
          ingestion_source: isBackfill ? "BACKFILL" : "RECONCILE",
          // RETENÇÃO É EXCEPCIONAL: só o backfill. Cobrança encontrada tarde
          // por webhook perdido preserva vencimento e tolerância reais —
          // retê-la converteria em atraso o conserto que este worker faz.
          // E fatura já liquidada nunca entra em hold por atraso.
          enforcement_hold: isBackfill && !settled,
          enforcement_hold_reason: isBackfill && !settled ? "INITIAL_BACKFILL" : null,
          enforcement_held_at: isBackfill && !settled ? new Date().toISOString() : null,
        });
        if (insErr && insErr.code !== "23505") {
          jsonLog("warn", { reqId, evt: "asaas_reconcile_insert_failed", payment: pay.id, err: insErr.message });
          continue;
        }
        stats.invoices_created++;
        if (isBackfill && !settled) stats.invoices_held++;
        continue;
      }

      // (b) Paga lá, aberta aqui — webhook de pagamento perdido. UPDATE
      // condicional: nunca sobrescreve `void`/`uncollectible`, que são estado
      // administrativo e só mudam por ação humana.
      if (settled && inv.status === "open") {
        const { data: upd } = await supabase
          .from("billing_invoices")
          .update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("id", inv.id)
          .eq("status", "open")
          .select("id");
        if (upd?.length) stats.invoices_settled++;
      }

      // (c) Valor divergente — anomalia que precisa de humano. Retém apenas
      // fatura em aberto; e nunca retém quem já está retida (não reescrever
      // motivo nem data de uma retenção anterior).
      if (cents !== inv.amount_cents && inv.status === "open" && !inv.enforcement_hold) {
        await supabase
          .from("billing_invoices")
          .update({
            enforcement_hold: true,
            enforcement_hold_reason: "VALUE_MISMATCH",
            enforcement_held_at: new Date().toISOString(),
          })
          .eq("id", inv.id)
          .eq("enforcement_hold", false);
        stats.invoices_held++;
        jsonLog("error", {
          reqId, evt: "asaas_reconcile_value_mismatch",
          invoice: inv.id, local_cents: inv.amount_cents, provider_cents: cents,
        });
        const recipients = await resolvePlatformAdminRecipients(supabase);
        if (recipients.length > 0) {
          await enqueueBillingNotification(supabase, {
            organizationId: sub.organization_id as string,
            eventType: "admin_correlation_ambiguity",
            invoiceId: inv.id,
            recipient: recipients[0],
          });
        }
      }
    }
  }

  jsonLog("info", { reqId, evt: "asaas_invoice_reconcile_done", ...stats });
  return new Response(JSON.stringify({ success: true, ...stats }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
```

**Assinatura ambígua** (mais de uma linha viva da mesma categoria para a organização) não é detectada aqui: a varredura é por linha de `billing_subscriptions`, não por organização, então duas linhas viram duas iterações independentes. Quem detecta e avisa é o worker da Task 17, que varre por organização.

- [ ] **Step 2: Registrar no `config.toml`**

```toml
[functions.process-asaas-invoice-reconcile]
verify_jwt = false
```

**Obrigatório antes do deploy.** A CLI ≥2.95 usa `true` por padrão; sem a entrada explícita o gateway responde 401 antes do `requireInternalAuth` e o cron silencia — `pg_net` é fire-and-forget e ninguém recebe o erro.

- [ ] **Step 3: Escrever a migration do cron**

Copiar o padrão do wrapper `SECURITY DEFINER` + `vault` + `pg_net.http_post` usado pelos jobs existentes (procurar por `process-billing-reconcile` nas migrations e imitar), agendando `0 8 * * *`. Horário escolhido para não colidir com `process-asaas-reconcile` (07:00) nem com `process-billing-overdue` (10:00).

- [ ] **Step 4: Verificar sintaxe e commitar**

```bash
npx esbuild supabase/functions/process-asaas-invoice-reconcile/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/process-asaas-invoice-reconcile/index.ts supabase/config.toml supabase/migrations/20260727100400_082_cron_asaas_invoice_reconcile.sql
git commit -m "feat(billing): worker de reconciliacao de cobrancas do Asaas"
```

---

## Task 12: `process-billing-overdue` respeita a retenção

**Files:**
- Modify: `supabase/functions/process-billing-overdue/index.ts:33-37`

**Interfaces:**
- Consumes: coluna `enforcement_hold` da Task 1.

- [ ] **Step 1: Acrescentar o filtro na consulta**

```ts
    const { data: overdueInvoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date, billing_subscription_id, external_reference, purpose")
      .eq("status", "open")
      // Fatura retida para revisão administrativa NÃO conta como atraso — é o
      // freio que impede a primeira varredura da ingestão de suspender alguém
      // por dívida antiga que nunca foi cobrada de verdade.
      .eq("enforcement_hold", false)
      .lt("due_date", today);
```

- [ ] **Step 2: Aplicar o mesmo filtro em `process-billing-reminders`**

Localizar a consulta equivalente de faturas vencidas em [supabase/functions/process-billing-reminders/index.ts](../../../supabase/functions/process-billing-reminders/index.ts) e acrescentar `.eq("enforcement_hold", false)`. Fatura retida não gera lembrete: cobrar por e-mail o que o sistema decidiu não escalar é pior que não cobrar.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/process-billing-overdue/index.ts supabase/functions/process-billing-reminders/index.ts
git commit -m "fix(billing): inadimplencia ignora fatura retida para revisao"
```

---

## Task 13: Helper de I/O do gate de WhatsApp

**Files:**
- Create: `supabase/functions/_shared/whatsapp-service-gate.ts`

**Interfaces:**
- Consumes: `decideWhatsAppGate`, `WhatsAppGateDecision` (Task 7); `normalizeFinancialState` (Task 6); `isFlagEnabled` de `_shared/platform-flags.ts`.
- Produces:
  - `interface ServiceGateResult extends WhatsAppGateDecision { enforcementEnabled: boolean; enforced: { sending: boolean; newProvisioning: boolean }; readFailed: boolean }`

> **Superseded pela Task 16 — não implementar `enforced.newProvisioning` a partir desta task.** Pôr provisionamento dentro de `enforced` o submete a `whatsapp_service_enforcement`, e a flag termina a fase OFF: o efeito seria bloquear toda criação de canal, inclusive a legítima. A Task 16 separa a elegibilidade de provisionamento num campo próprio (`provisioning`), calculado sem a flag. O restante desta task (leituras, `readFailed`, cache, `enforced.sending`) segue valendo.
  - `resolveWhatsAppGateByOrg(supabase, organizationId): Promise<ServiceGateResult>`
  - `resolveWhatsAppGateByUnit(supabase, unitId): Promise<ServiceGateResult | null>` — **`null`** quando a unidade não resolve para uma organização; todo caller usa `gate?.enforced.sending`, e `null` significa "não sei" e portanto **não bloqueia**
  - `clearWhatsAppGateCache(): void`
  Consumido pelas Tasks 14–17, 19 e 20.

- [ ] **Step 1: Escrever o helper**

```ts
// supabase/functions/_shared/whatsapp-service-gate.ts
/**
 * Camada de I/O do gate de serviço de WhatsApp: carrega do banco o que o núcleo
 * puro precisa e devolve a decisão já combinada com a flag de enforcement.
 *
 * DOIS CAMPOS, NÃO UM: `sendingBlocked` é o estado REAL (o núcleo sempre
 * calcula), `enforced.sending` é a CONSEQUÊNCIA (só verdadeira com a flag
 * ligada). O caller que bloqueia usa `enforced`; o caller que loga ou mostra
 * estado usa o campo real. Colapsar os dois num booleano só apagaria o modo
 * dry-run, que é justamente como esta fase vai a produção primeiro.
 *
 * CACHE POR INVOCAÇÃO: `unitCache`/`orgCache` são zerados no início de cada
 * invocação pelo caller (`clearWhatsAppGateCache()`), mesmo padrão do
 * `unitCache` dos workers — sem isso, um isolate quente serviria estado velho
 * depois de o cliente pagar.
 *
 * REDEPLOY: consumido por send-whatsapp, send-confirmation, send-cancellation,
 * send-manual-message, webhook-whatsapp, manage-channels,
 * manage-whatsapp-implementations, process-whatsapp-enforcement,
 * process-notification-outbox, process-reservation-reminders,
 * process-satisfaction-surveys, process-voucher-triggers,
 * process-waitlist-entered e process-waitlist-feedback. Atualizar o checklist
 * do CLAUDE.md.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { isFlagEnabled } from "./platform-flags.ts";
import { normalizeFinancialState } from "./billing-financial-state-core.ts";
import { decideWhatsAppGate, type WhatsAppGateDecision } from "./whatsapp-service-state-core.ts";

const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";

export interface ServiceGateResult extends WhatsAppGateDecision {
  organizationId: string;
  enforcementEnabled: boolean;
  /** Consequência operacional: estado real E flag ligada. */
  enforced: { sending: boolean; newProvisioning: boolean };
  /**
   * true quando alguma das leituras falhou e a decisão foi montada com defaults
   * de quem não leu. Caller que BLOQUEIA pode ignorar (o default é permitir, e
   * permitir é o lado seguro aqui); caller que AFIRMA o estado pro cliente tem
   * que checar antes de responder 200 — mesmo contrato de
   * `OrgEntitlementsResult.readFailed`.
   */
  readFailed: boolean;
}

const orgCache = new Map<string, ServiceGateResult>();
const unitToOrg = new Map<string, string>();

export function clearWhatsAppGateCache(): void {
  orgCache.clear();
  unitToOrg.clear();
}

export async function resolveWhatsAppGateByOrg(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ServiceGateResult> {
  const cached = orgCache.get(organizationId);
  if (cached) return cached;

  const nowIso = new Date().toISOString();

  const [orgRes, overridesRes, subRes, flagOn] = await Promise.all([
    supabase
      .from("organizations")
      .select("billing_status, whatsapp_legacy_grandfathered, whatsapp_grandfather_revoked_at")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("organization_entitlement_overrides")
      .select("enabled, starts_at, ends_at")
      .eq("organization_id", organizationId)
      .eq("feature", "whatsapp")
      .is("revoked_at", null)
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`),
    supabase
      .from("billing_subscriptions")
      .select("id, status, canceled_at, billing_plans!inner(category)")
      .eq("organization_id", organizationId)
      .eq("billing_plans.category", WHATSAPP_CATEGORY)
      .neq("status", "canceled")
      .maybeSingle(),
    isFlagEnabled("whatsapp_service_enforcement"),
  ]);

  const readFailed = !!(orgRes.error || overridesRes.error || subRes.error);
  if (readFailed) {
    jsonLog("warn", {
      evt: "whatsapp_gate_read_failed",
      org: organizationId,
      orgErr: orgRes.error?.message ?? null,
      overridesErr: overridesRes.error?.message ?? null,
      subErr: subRes.error?.message ?? null,
    });
  }

  const overrides = (overridesRes.data ?? []) as { enabled: boolean }[];
  const sub = subRes.data as { id: string; status: string; canceled_at: string | null } | null;

  // Fatura em aberto mais antiga da assinatura, JÁ EXCLUINDO as retidas —
  // fatura em revisão administrativa não conta como atraso, por definição.
  let oldestOpenInvoice: { dueDate: string; status: string } | null = null;
  if (sub) {
    const { data: inv } = await supabase
      .from("billing_invoices")
      .select("due_date, status")
      .eq("billing_subscription_id", sub.id)
      .eq("status", "open")
      .eq("enforcement_hold", false)
      .not("due_date", "is", null)
      .order("due_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (inv?.due_date) {
      oldestOpenInvoice = { dueDate: inv.due_date as string, status: inv.status as string };
    }
  }

  const financial = normalizeFinancialState({
    now: nowIso,
    subscriptionStatus: sub?.status ?? null,
    canceledAt: sub?.canceled_at ?? null,
    oldestOpenInvoice,
  });

  const decision = decideWhatsAppGate({
    // Default 'active' quando a leitura falhou: o lado seguro aqui é PERMITIR.
    // Um erro transitório de banco não pode silenciar o WhatsApp do cliente.
    systemBillingStatus: (orgRes.data?.billing_status as string | undefined) ?? "active",
    financialState: financial.state,
    hasActiveWhatsAppOverride: overrides.some((o) => o.enabled),
    hasWhatsAppAdminBlock: overrides.some((o) => !o.enabled),
    isLegacyGrandfathered:
      orgRes.data?.whatsapp_legacy_grandfathered === true &&
      orgRes.data?.whatsapp_grandfather_revoked_at === null,
  });

  const result: ServiceGateResult = {
    ...decision,
    organizationId,
    enforcementEnabled: flagOn,
    enforced: {
      sending: flagOn && decision.sendingBlocked,
      newProvisioning: flagOn && decision.newProvisioningBlocked,
    },
    readFailed,
  };

  // Telemetria de dry-run: com a flag desligada, registra o que TERIA
  // acontecido. É a única fonte de métrica antes de ligar o enforcement.
  if (!flagOn && decision.sendingBlocked) {
    jsonLog("info", {
      evt: "whatsapp_enforcement_dryrun",
      org: organizationId,
      state: decision.state,
      would_block_sending: true,
      reason: decision.reason,
    });
  }

  orgCache.set(organizationId, result);
  return result;
}

export async function resolveWhatsAppGateByUnit(
  supabase: SupabaseClient,
  unitId: string,
): Promise<ServiceGateResult | null> {
  let orgId = unitToOrg.get(unitId);
  if (!orgId) {
    const { data, error } = await supabase
      .from("units")
      .select("organization_id")
      .eq("id", unitId)
      .maybeSingle();
    if (error || !data?.organization_id) {
      jsonLog("warn", { evt: "whatsapp_gate_unit_unresolved", unit_id: unitId, err: error?.message ?? "not_found" });
      return null;
    }
    orgId = data.organization_id as string;
    unitToOrg.set(unitId, orgId);
  }
  return await resolveWhatsAppGateByOrg(supabase, orgId);
}
```

**Nota sobre a assinatura ambígua:** o `.maybeSingle()` em `billing_subscriptions` devolve `PGRST116` se houver duas assinaturas vivas de WhatsApp. Isso é o comportamento certo — ambiguidade não é resolvida em silêncio — e cai no `subRes.error`, que marca `readFailed` e permite (lado seguro). O worker da Task 17 trata a ambiguidade como falha alta com aviso ao administrador.

- [ ] **Step 2: Verificar sintaxe e commitar**

```bash
npx esbuild supabase/functions/_shared/whatsapp-service-gate.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/_shared/whatsapp-service-gate.ts
git commit -m "feat(billing): helper de I/O do gate de servico de WhatsApp"
```

---

## Task 14: Gate central de envio

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-send.ts`
- Modify: `src/hooks/useWaitlist.ts:17-30` (a função `friendlyWhatsAppError`)

**Interfaces:**
- Consumes: `resolveWhatsAppGateByUnit` (Task 13).
- Produces: `sendWhatsApp` passa a poder devolver `{ ok:false, error:"whatsapp_service_suspended" }`.

**Por que aqui:** `sendWhatsApp` é ponto único de todos os envios que não são do agente — quatro Edge Functions (`send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`) e, atrás delas, os cinco fluxos automáticos. Um gate só cobre tudo.

- [ ] **Step 1: Acrescentar o gate no topo de `sendWhatsApp`**

Antes de qualquer resolução de canal:

```ts
  // Gate de serviço. Precisa de unit_id; quando só veio channel_id, resolve a
  // unit pelo canal primeiro (a consulta do canal já acontece logo abaixo, mas
  // o gate tem que vir ANTES de tocar no provedor — depois já custou dinheiro).
  let gateUnitId = channelIdOrUnitId?.unit_id ?? null;
  if (!gateUnitId && channelIdOrUnitId?.channel_id) {
    const { data: ch } = await supabase
      .from("whatsapp_channels")
      .select("unit_id")
      .eq("id", channelIdOrUnitId.channel_id)
      .maybeSingle();
    gateUnitId = (ch?.unit_id as string | undefined) ?? null;
  }

  if (gateUnitId) {
    const gate = await resolveWhatsAppGateByUnit(supabase, gateUnitId);
    if (gate?.enforced.sending) {
      jsonLog("warn", {
        evt: "send_whatsapp_service_suspended",
        unit_id: gateUnitId,
        org: gate.organizationId,
        state: gate.state,
        reason: gate.reason,
      });
      return { ok: false, error: "whatsapp_service_suspended" };
    }
  }
```

**Mensagem manual do operador passa pelo mesmo gate** — é envio de WhatsApp e gera custo na Z-API igual aos automáticos.

- [ ] **Step 2: Traduzir o erro no frontend**

Em `friendlyWhatsAppError` (hoje uma função local em [src/hooks/useWaitlist.ts:17](../../../src/hooks/useWaitlist.ts)), acrescentar o caso:

```ts
    case "whatsapp_service_suspended":
      return "Envio de WhatsApp suspenso por falta de pagamento da mensalidade da automação. Regularize em Cobrança para voltar a enviar.";
```

Texto **distinto** de `whatsapp_not_configured`: "configure o canal" e "serviço suspenso" são problemas diferentes e ações diferentes. Se outros arquivos tiverem cópia da função, mover para `src/lib/utils.ts` e importar dos dois lugares — duas cópias divergindo é como um dos erros deixa de ser traduzido.

- [ ] **Step 3: Rodar typecheck e lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 erros; warnings iguais à baseline (22).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/whatsapp-send.ts src/hooks/useWaitlist.ts
git commit -m "feat(billing): gate central de envio de WhatsApp por suspensao"
```

---

## Task 15: Gate do agente no `webhook-whatsapp`

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts:1483-1492`

**Interfaces:**
- Consumes: `resolveWhatsAppGateByOrg`, `clearWhatsAppGateCache` (Task 13).

**Contexto:** o check de billing da organização já existe nessas linhas (`billing_status in ('blocked','suspended')` → `finish("org_billing_blocked")`). O gate novo entra **imediatamente depois**, com o mesmo tratamento.

- [ ] **Step 1: Zerar o cache no início da invocação**

Logo no começo do handler, junto das demais inicializações por invocação, chamar `clearWhatsAppGateCache()`. Sem isso, um isolate quente serve estado velho depois de o cliente pagar.

- [ ] **Step 2: Acrescentar o gate**

```ts
      // Suspensão do SERVIÇO de WhatsApp (mensalidade da instância), separada
      // do bloqueio do sistema logo acima. Roda ANTES do runAgentLoop: zero
      // token de IA consumido.
      const waGate = await resolveWhatsAppGateByOrg(supabase, organizationId);
      if (waGate.enforced.sending) {
        jsonLog("warn", {
          requestId, evt: "webhook_whatsapp_service_suspended",
          unitId, organizationId, state: waGate.state, reason: waGate.reason,
        });
        await finish("whatsapp_service_suspended");
        return;
      }
```

**SILÊNCIO, não mensagem.** O cliente do restaurante é terceiro inocente; avisá-lo de que o restaurante não pagou é dano de reputação do lojista. É o mesmo tratamento que `org_billing_blocked` já dá.

**Correção de premissa (decisão do dono, pós-revisão):** a versão anterior deste passo afirmava que "a mensagem inbound continua sendo registrada na conversa pelo fluxo normal". **É falso** neste ponto de inserção — o upsert de cliente, o `getOrCreateConversation` e o `appendToConversation` ficam todos **depois** deste `return`, e `processed_messages` guarda só o `message_id`. A mensagem do cliente some. Vale igualmente para o `org_billing_blocked` pré-existente. Fechado pela **Task 15c**, que é bloqueante para o go-live do enforcement. Esta task fica como está.

- [ ] **Step 3: Registrar o outcome novo**

Acrescentar `whatsapp_service_suspended` à lista de outcomes documentada no cabeçalho do arquivo e na seção "Observabilidade WhatsApp" do `CLAUDE.md` (feito na Task 21).

- [ ] **Step 4: Verificar sintaxe e commitar**

```bash
npx esbuild supabase/functions/webhook-whatsapp/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/webhook-whatsapp/index.ts
git commit -m "feat(billing): agente silencia quando o servico de WhatsApp esta suspenso"
```

---

## Task 15b: Gate da resposta automática a áudio, imagem e sticker

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-service-state-core.ts` (acrescenta uma função pura)
- Modify: `src/lib/whatsapp-service-state-core.test.ts`
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (o ramo de mídia, `if (!inbound)`)

**Interfaces:**
- Consumes: `decideWhatsAppGate`, `resolveEnforcement` (núcleo, Tasks 7 e 13); `resolveWhatsAppGateByOrg` (Task 13).
- Produces: `decideInboundAutoReply(i: InboundAutoReplyInput): InboundAutoReply` no núcleo puro.

**Contexto:** áudio/imagem/sticker não passam pelo fluxo de texto. `parseInbound` devolve `null` e o ramo de `peekInboundMedia` (index.ts:1250-1348) responde `MEDIA_REPLY_TEXT` pedindo mensagem escrita. Esse ramo **resolve a própria organização** (`orgId2`, l.1287-1292) e **já grava a mensagem recebida na conversa** (l.1319-1323), mas nunca consultou nem `billing_status` do sistema nem o estado do serviço — respondia e gastava Z-API com a organização suspensa.

- [ ] **Step 1: Escrever o teste que falha, no núcleo puro**

Em `src/lib/whatsapp-service-state-core.test.ts`, reaproveitando o helper `gate()` que já existe no arquivo (ele monta a decisão real por `decideWhatsAppGate` + `resolveEnforcement`, sem stub):

```ts
describe("decideInboundAutoReply", () => {
  const call = (o: { state?: Parameters<typeof gate>[0]; enforcementOn?: boolean } = {}) => {
    /* monta o ServiceGateResult-like pelo caminho real e chama decideInboundAutoReply */
  };

  it("SUSPENDED_UNPAID com enforcement ligado não responde", () => {
    expect(decideInboundAutoReply({ systemBlocked: false, enforcedSending: true }))
      .toBe("SILENT_WHATSAPP_SUSPENDED");
  });

  it("ADMIN_BLOCKED com enforcement ligado não responde", () => {
    expect(decideInboundAutoReply({ systemBlocked: false, enforcedSending: true }))
      .toBe("SILENT_WHATSAPP_SUSPENDED");
  });

  it("sistema suspenso não responde mesmo com override de WhatsApp e enforcement desligado", () => {
    expect(decideInboundAutoReply({ systemBlocked: true, enforcedSending: false }))
      .toBe("SILENT_SYSTEM_BLOCKED");
  });

  it("ACTIVE responde", () => {
    expect(decideInboundAutoReply({ systemBlocked: false, enforcedSending: false })).toBe("REPLY");
  });

  it("dry-run com SUSPENDED_UNPAID responde", () => {
    expect(decideInboundAutoReply({ systemBlocked: false, enforcedSending: false })).toBe("REPLY");
  });

  it("bloqueio do sistema vence a suspensão do WhatsApp no motivo reportado", () => {
    expect(decideInboundAutoReply({ systemBlocked: true, enforcedSending: true }))
      .toBe("SILENT_SYSTEM_BLOCKED");
  });
});
```

**Os seis casos exigidos pelo dono precisam ser montados pelo caminho REAL**, não por literais de `systemBlocked`/`enforcedSending`: cada `it` acima constrói o `ServiceGateResult` chamando `decideWhatsAppGate` com o input que produz o estado nomeado (`SUSPENDED_UNPAID`, `ADMIN_BLOCKED`, `OVERRIDE_ACTIVE` + `systemBillingStatus:"suspended"`, `ACTIVE`, `OVERRIDE_ACTIVE`) e depois `resolveEnforcement` com a flag ligada ou desligada, exatamente como o helper `gate()` já faz para os testes de `resolveEnforcement`. Um teste que passa `{ systemBlocked: true }` na mão não prova que o estado real produz esse booleano — e é justamente o elo que quebrou aqui. Casos obrigatórios, nomeados no `it`: `SUSPENDED_UNPAID` não responde; `ADMIN_BLOCKED` não responde; sistema suspenso não responde mesmo com override de WhatsApp; `ACTIVE` responde; `OVERRIDE_ACTIVE` responde; dry-run não bloqueia.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-service-state-core.test.ts`
Expected: FAIL — `decideInboundAutoReply is not a function`.

- [ ] **Step 3: Escrever a função pura**

Em `supabase/functions/_shared/whatsapp-service-state-core.ts`, no fim do arquivo:

```ts
/**
 * Resposta automática a mídia (áudio/imagem/sticker) recebida: responder ou
 * silenciar, e por quê. Função pura porque `supabase/functions/` não roda em
 * CI — sem ela, os seis casos exigidos não teriam onde ser testados.
 *
 * DUAS DIMENSÕES, NÃO UMA, e é o ponto todo: o bloqueio do sistema NÃO é
 * submetido a `whatsapp_service_enforcement` (é o mesmo tratamento não-gateado
 * que o fluxo de texto já dá ao `org_billing_blocked`), enquanto a suspensão
 * do WhatsApp é. Colapsar as duas num booleano faria o dry-run responder por
 * uma organização com o sistema bloqueado.
 */
export interface InboundAutoReplyInput {
  /** `WhatsAppGateDecision.systemBlocked` — estado real, nunca gateado por flag. */
  systemBlocked: boolean;
  /** `EnforcementResult.enforced.sending` — consequência, já gateada pela flag. */
  enforcedSending: boolean;
}

export type InboundAutoReply = "REPLY" | "SILENT_SYSTEM_BLOCKED" | "SILENT_WHATSAPP_SUSPENDED";

export function decideInboundAutoReply(i: InboundAutoReplyInput): InboundAutoReply {
  if (i.systemBlocked) return "SILENT_SYSTEM_BLOCKED";
  if (i.enforcedSending) return "SILENT_WHATSAPP_SUSPENDED";
  return "REPLY";
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/whatsapp-service-state-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Ligar o ramo de mídia ao gate**

Em `supabase/functions/webhook-whatsapp/index.ts`, **depois** do append da mensagem na conversa (hoje l.1319-1323, o bloco `if (mediaCustomer && unitId)`) e do check de handoff humano, e **antes** do `sendOutbound` de `MEDIA_REPLY_TEXT` (hoje l.1332):

```ts
      // Gate de serviço, nas duas dimensões (§6.5 da spec). Vem DEPOIS do
      // append na conversa — a mensagem recebida nunca se perde — e ANTES do
      // sendOutbound: bloqueado significa ZERO chamada à Z-API. Reusa o helper
      // central; não reimplementa os sete estados.
      if (orgId2) {
        const waGate = await resolveWhatsAppGateByOrg(supabase, orgId2);
        const verdict = decideInboundAutoReply({
          systemBlocked: waGate.systemBlocked,
          enforcedSending: waGate.enforced.sending,
        });
        if (verdict !== "REPLY") {
          const outcome = verdict === "SILENT_SYSTEM_BLOCKED"
            ? "org_billing_blocked"
            : "whatsapp_service_suspended";
          jsonLog("warn", {
            requestId, evt: "media_reply_suppressed", unitId, organizationId: orgId2,
            state: waGate.state, reason: waGate.reason, verdict,
          });
          await finish(outcome, undefined, { media: true, mediaKind: media.mediaKind, verdict });
          return new Response("ok");
        }
      }
```

**SILÊNCIO, não mensagem** — nenhuma resposta automática avisando suspensão, pelo mesmo motivo da Task 15. Outcomes **reaproveitados**, não novos: `org_billing_blocked` e `whatsapp_service_suspended` já existem no painel de diagnóstico; `meta.media` distingue a origem. `orgId2` vazio (unidade sem organização) não bloqueia — mesma direção de erro do resto do fluxo.

Importar `decideInboundAutoReply` de `../_shared/whatsapp-service-state-core.ts`; `resolveWhatsAppGateByOrg` já está importado pela Task 15.

- [ ] **Step 6: Verificar**

Run: `npm run typecheck && npm test && npx esbuild supabase/functions/webhook-whatsapp/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null`
Expected: typecheck 0 erros; suíte verde com os 6 testes novos; esbuild sem erro.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsapp-service-state-core.ts src/lib/whatsapp-service-state-core.test.ts supabase/functions/webhook-whatsapp/index.ts
git commit -m "feat(billing): resposta automatica a midia respeita bloqueio e suspensao"
```

---

## Task 15c: Persistir a mensagem recebida quando o gate silencia

**Files:**
- Modify: `supabase/functions/webhook-whatsapp/index.ts` (os dois gates: `org_billing_blocked` l.1489-1500 e `whatsapp_service_suspended` l.1502-1518)

**Interfaces:**
- Consumes: `getOrCreateConversation` e `appendToConversation`, ambas já existentes neste arquivo.
- Produces: nada exportado.

**Por que esta task existe:** os dois gates retornam **antes** do upsert de cliente (l.1520), do `getOrCreateConversation` (l.1670) e do `appendToConversation` (l.1705/1800). `processed_messages` guarda só `message_id`/`started_at`/`completed_at`/`outcome` — nenhum texto. `webhook_executions` é telemetria com TTL de 30d, sem payload, visível só a super-admin. A Z-API não reentrega o que já recebeu 200. **A mensagem do cliente acaba ali.** Bloqueante para o go-live do enforcement (§6.10 da spec).

**Fronteira — ler antes de implementar:** NÃO mover o upsert de cliente, o `getOrCreateConversation`, o debounce, o lock nem a deduplicação para antes dos gates. Esta task **acrescenta um desvio que termina**; não reordena nada. Se em algum momento a implementação exigir mexer na ordem do fluxo concorrente, pare e reporte — a decisão do dono foi explícita nesse ponto.

- [ ] **Step 1: Escrever o helper, uma vez, para os dois gates**

Perto das outras funções auxiliares do arquivo (acima do `serve`), na mesma vizinhança de `getOrCreateConversation`:

```ts
/**
 * Grava a mensagem recebida na conversa e RETORNA — sem agente, sem resposta
 * automática, sem ferramenta, sem envio. Chamado pelos gates de billing, que
 * silenciam a IA mas não podem fazer o cliente sumir do histórico: o operador
 * precisa ver o que chegou quando o serviço voltar (§6.10 da spec).
 *
 * RAMO-FOLHA DE PROPÓSITO: nada aqui é movido para antes dos gates. Não roda
 * interceptador de avaliação, não roda handoff, não dorme no debounce e não
 * reivindica `try_claim_conversation_for_ai` — a ordem do fluxo concorrente
 * fica intocada. A deduplicação por `providerMessageId` já aconteceu a
 * montante (INSERT em `processed_messages`), então reentrega do mesmo id nem
 * chega aqui; e o append é atômico pela RPC `append_conversation_message`.
 *
 * NUNCA LANÇA. Perder a persistência é ruim; devolver não-2xx é pior — faria o
 * provedor reentregar, e reentrega não recupera nada neste caminho. Devolve se
 * conseguiu, para o caller registrar em `meta`.
 */
async function persistInboundOnly(args: {
  requestId: string;
  organizationId: string;
  unitId: string;
  phone: string;
  contactName: string | null;
  text: string;
  chatLid: string | null;
}): Promise<boolean> {
  try {
    if (!args.organizationId || !args.unitId) return false;

    const { data: existing } = await supabase
      .from("customers")
      .select("id")
      .eq("organization_id", args.organizationId)
      .eq("phone", args.phone)
      .maybeSingle();

    let customerId = existing?.id as string | undefined;
    if (!customerId) {
      const { data: inserted } = await supabase
        .from("customers")
        .insert({ phone: args.phone, name: args.contactName ?? args.phone, organization_id: args.organizationId })
        .select("id")
        .single();
      customerId = inserted?.id as string | undefined;
    }
    if (!customerId) return false;

    const conv = await getOrCreateConversation(customerId, args.unitId, args.contactName, args.chatLid);
    if (!conv) return false;

    await appendToConversation(conv.id, conv.messages || [], "user", args.text);
    return true;
  } catch (e) {
    jsonLog("warn", { requestId: args.requestId, evt: "persist_inbound_only_failed", err: String(e) });
    return false;
  }
}
```

- [ ] **Step 2: Chamar nos dois gates**

No gate do sistema (hoje l.1495-1499), trocar o corpo do `if` por:

```ts
      if (orgBilling && (orgBilling.billing_status === "blocked" || orgBilling.billing_status === "suspended")) {
        const persisted = await persistInboundOnly({
          requestId, organizationId, unitId, phone,
          contactName: inbound.contactName, text: incomingText, chatLid: inboundChatLid,
        });
        jsonLog("warn", { requestId, evt: "webhook_org_billing_blocked", unitId, organizationId, status: orgBilling.billing_status, persisted });
        await finish("org_billing_blocked", undefined, { inbound_persisted: persisted });
        return new Response("ok");
      }
```

E no gate do WhatsApp (hoje l.1510-1517), o mesmo padrão, mantendo `evt`, `state`, `reason` e o outcome `whatsapp_service_suspended`, acrescentando `persisted` ao log e `{ inbound_persisted: persisted }` ao `meta` do `finish`.

**Um helper só para os dois** — dois blocos copiados divergem, e foi exatamente assim que o gate do sistema ficou anos perdendo mensagem sem ninguém notar.

- [ ] **Step 3: Conferir o que NÃO mudou**

Ler o diff inteiro e confirmar, item por item, que nenhuma destas linhas se moveu: o `INSERT` em `processed_messages`, o `check_rate_limit`, o upsert de cliente do fluxo normal, `getOrCreateConversation` (l.1670), o `sleep(DEBOUNCE_WINDOW_MS)`, o `append` de l.1800 e o `try_claim_conversation_for_ai`. O diff desta task deve ser: uma função nova + duas chamadas + dois `meta`. Qualquer linha movida além disso é fora de escopo e precisa ser revertida.

- [ ] **Step 4: Verificar sintaxe**

Run: `npx esbuild supabase/functions/webhook-whatsapp/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null`
Expected: sem erro. (Deno não está instalado; `npm test` e `npm run typecheck` não alcançam `supabase/functions/` — a verificação desta task é esbuild + revisão do diff.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/webhook-whatsapp/index.ts
git commit -m "fix(billing): mensagem recebida nao some quando o gate de billing silencia"
```

---

## Task 16: Gate de novo provisionamento

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-service-state-core.ts` (separa provisionamento de `enforced`)
- Modify: `supabase/functions/_shared/whatsapp-service-gate.ts` (repassa o campo novo)
- Modify: `src/lib/whatsapp-service-state-core.test.ts`
- Modify: `supabase/functions/manage-channels/index.ts:69-95`

**Interfaces:**
- Consumes: `resolveWhatsAppGateByUnit`, `ServiceGateResult` (Task 13).
- Produces: `resolveProvisioningEligibility(i): ProvisioningEligibility` no núcleo puro; `ServiceGateResult.provisioning: { allowed: boolean; blockReason: ProvisioningBlockReason }`.
- **Quebra deliberada:** `ServiceGateResult.enforced.newProvisioning` e o campo solto `provisioningBlockReason` **deixam de existir**. Consumidores hoje: nenhum — Tasks 14 e 15 usam só `enforced.sending`. Confirmar com `grep -rn "newProvisioning\|provisioningBlockReason" supabase/ src/` antes de commitar.

**Correção da orientação da Task 13 — ler antes de implementar.** A Task 13 pôs `newProvisioning` dentro de `enforced`, exigindo a flag `whatsapp_service_enforcement` ligada para liberar. **Está errado, e o dono corrigiu:** aquela flag governa a aplicação da suspensão sobre uso **existente** (envio, execução de jobs). Ela não autoriza contratar nem provisionar. Como a fase termina com a flag OFF por mandato, mantê-la nessa decisão bloquearia **toda** criação de canal, inclusive a operação legítima da própria plataforma. A elegibilidade para novo provisionamento é proteção **permanente** contra custo recorrente e **não consulta essa flag** — nem para liberar, nem para bloquear, nem quando a leitura dela falha.

**Fronteira desta fase:** "nova instância" aqui significa **criar canal para uma unidade que ainda não tem nenhum**. Substituir o canal de uma unidade que já tem **não** é bloqueado: o caminho (a) de rotação de secret do [runbook de credenciais](../../RUNBOOK-ROTACAO-CREDENCIAIS.md) depende exatamente de recriar o canal, e bloqueá-lo travaria a rotação de um cliente legado. Reconexão e reprovisionamento da mesma instância são detalhados na Fase 6.

- [ ] **Step 1: Escrever os testes que falham**

Em `src/lib/whatsapp-service-state-core.test.ts`, montando cada caso pelo caminho REAL (`decideWhatsAppGate` com o input que produz o estado nomeado — nunca um literal de `newProvisioningBlocked` na mão):

```ts
describe("resolveProvisioningEligibility", () => {
  it("flag de enforcement OFF + ACTIVE libera, e não pelo motivo errado", () => {
    const r = resolveProvisioningEligibility({ decision: decideWhatsAppGate(active()), dataReadFailed: false });
    expect(r.allowed).toBe(true);
    expect(r.blockReason).toBe("ALLOWED");
  });

  it("flag de enforcement OFF + SUSPENDED_UNPAID continua bloqueando", () => {
    const r = resolveProvisioningEligibility({ decision: decideWhatsAppGate(suspendedUnpaid()), dataReadFailed: false });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("SERVICE_STATE");
  });

  it("falha na leitura da flag de enforcement não interfere", () => {
    // A assinatura não tem onde receber a flag — é a prova estrutural.
    // Cobrir também por ServiceGateResult: gate com flagReadFailed em ACTIVE libera.
  });

  it("falha na resolução do estado bloqueia", () => {
    const r = resolveProvisioningEligibility({ decision: decideWhatsAppGate(active()), dataReadFailed: true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("STATE_READ_FAILED");
  });

  it("LEGACY_GRANDFATHERED permite envio e bloqueia instância nova", () => {
    const d = decideWhatsAppGate(legacy());
    expect(d.sendingBlocked).toBe(false);
    expect(resolveProvisioningEligibility({ decision: d, dataReadFailed: false }).allowed).toBe(false);
  });

  it("OVERRIDE_ACTIVE permite provisionamento", () => {
    expect(resolveProvisioningEligibility({ decision: decideWhatsAppGate(overrideActive()), dataReadFailed: false }).allowed).toBe(true);
  });

  it("sistema suspenso bloqueia mesmo com OVERRIDE_ACTIVE de WhatsApp", () => {
    const d = decideWhatsAppGate({ ...overrideActive(), systemBillingStatus: "suspended" });
    expect(d.state).toBe("OVERRIDE_ACTIVE");
    const r = resolveProvisioningEligibility({ decision: d, dataReadFailed: false });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("SERVICE_STATE");
  });
});
```

Os sete casos acima são os exigidos pelo dono, um `it` cada. `GRACE_PERIOD`, `NOT_ENTITLED` e `ADMIN_BLOCKED` também bloqueiam — acrescentar se ainda não estiverem cobertos pelo `describe` existente dos sete estados.

O terceiro caso ("falha na leitura da flag não interfere") tem duas provas complementares, e **as duas entram**: a estrutural — `ProvisioningEligibilityInput` não tem campo de flag, então é impossível consultá-la — e a de comportamento, que passa por `resolveEnforcement` com `flagReadFailed: true` em `ACTIVE` e confirma que a elegibilidade continua `allowed: true`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp-service-state-core.test.ts`
Expected: FAIL — `resolveProvisioningEligibility is not a function`.

- [ ] **Step 3: Separar provisionamento de `enforced` no núcleo**

Em `supabase/functions/_shared/whatsapp-service-state-core.ts`:

```ts
/**
 * Motivo do bloqueio de provisionamento, para a UI/log dizerem a coisa certa —
 * "não foi possível verificar agora" é mensagem diferente de "você não tem
 * direito". Precedência FIXA: transitório (leitura falhou) vence sobre
 * definitivo (estado).
 *
 * NÃO HÁ motivo ligado à flag de enforcement, e a ausência é o contrato: essa
 * flag governa consequência sobre uso existente, nunca autorização de despesa
 * nova. Acrescentar um `ENFORCEMENT_FLAG_*` aqui reintroduz o acoplamento que
 * esta separação existe para impedir.
 */
export type ProvisioningBlockReason = "ALLOWED" | "STATE_READ_FAILED" | "SERVICE_STATE";

export interface ProvisioningEligibilityInput {
  decision: WhatsAppGateDecision;
  /** Alguma leitura de ESTADO (org, overrides, assinatura, fatura) falhou. */
  dataReadFailed: boolean;
  // SEM campo de flag, de propósito — ver o comentário acima.
}

export interface ProvisioningEligibility {
  allowed: boolean;
  blockReason: ProvisioningBlockReason;
}

/**
 * Elegibilidade para gerar custo externo recorrente NOVO. Proteção permanente:
 * vale com qualquer valor de `whatsapp_service_enforcement`, inclusive
 * ilegível, porque não consulta a flag.
 *
 * FAIL-CLOSED, e a assimetria com o envio é deliberada: autorizar despesa
 * recorrente sem conseguir confirmar a autorização é pior do que recusar e
 * pedir para tentar de novo. Envio existente faz o oposto (fail-open) — um
 * soluço técnico não pode suspender quem está pagando.
 */
export function resolveProvisioningEligibility(i: ProvisioningEligibilityInput): ProvisioningEligibility {
  if (i.dataReadFailed) return { allowed: false, blockReason: "STATE_READ_FAILED" };
  if (i.decision.newProvisioningBlocked) return { allowed: false, blockReason: "SERVICE_STATE" };
  return { allowed: true, blockReason: "ALLOWED" };
}
```

E em `resolveEnforcement`, **remover** `newProvisioning` de `EnforcementResult.enforced` (fica `enforced: { sending: boolean }`) e remover o cálculo e o `provisioningBlockReason` de lá — passam a ser responsabilidade da função acima. A docstring de `resolveEnforcement` perde o parágrafo sobre provisionamento e ganha uma linha dizendo que `enforced` contém **somente** consequências submetidas à flag. Os campos `enforcementEnabled` e `telemetry` ficam como estão.

- [ ] **Step 4: Repassar no helper de I/O**

Em `supabase/functions/_shared/whatsapp-service-gate.ts`: trocar o campo `provisioningBlockReason` por

```ts
  /**
   * Elegibilidade para provisionar instância nova. Calculada SEM a flag de
   * enforcement e fail-closed — ver `resolveProvisioningEligibility`. Não
   * confundir com `enforced`, que é o outro eixo (consequência gateada por
   * flag, fail-open).
   */
  provisioning: ProvisioningEligibility;
```

chamando `resolveProvisioningEligibility({ decision, dataReadFailed })` — **`dataReadFailed`, não `readFailed`**: a falha de leitura da flag não entra nesta conta. Atualizar a docstring de `readFailed` no mesmo arquivo, que hoje descreve `enforced.newProvisioning` como o lado fail-closed; passa a apontar para `provisioning.allowed`.

- [ ] **Step 5: Rodar e ver passar**

Run: `npm run typecheck && npx vitest run src/lib/whatsapp-service-state-core.test.ts`
Expected: typecheck 0 erros; testes verdes.

- [ ] **Step 6: Acrescentar o gate na action `create`**

```ts
    if (action === "create") {
      // Gate de NOVO provisionamento: só ACTIVE e OVERRIDE_ACTIVE autorizam
      // gerar custo externo novo. GRACE_PERIOD preserva a instância existente
      // mas não cria outra; LEGACY_GRANDFATHERED preserva o uso existente mas
      // não expande o serviço.
      //
      // NÃO consulta `whatsapp_service_enforcement`, nem para liberar nem para
      // bloquear: aquela flag governa a suspensão de uso EXISTENTE. Esta guarda
      // impede despesa recorrente nova de nascer e vale sempre. Fail-closed:
      // gate irresolvível (unidade sem organização, leitura que falhou) recusa.
      //
      // platform_admin NÃO passa por cima — esta EF já é exclusiva de
      // super-admin, então "exceto para admin" seria "nunca". Provisionar para
      // organização sem assinatura exige override formal de `whatsapp`, que
      // leva a OVERRIDE_ACTIVE e libera pela porta da frente, com rastro.
      const { count: existingChannels, error: countErr } = await supabase
        .from("whatsapp_channels")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", unitId);

      if (countErr) {
        console.error("manage-channels:create count", countErr);
        return jsonResponse(req, { error: PROVISIONING_UNVERIFIABLE }, 403);
      }

      if ((existingChannels ?? 0) === 0) {
        const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
        if (!gate || !gate.provisioning.allowed) {
          const message = !gate || gate.provisioning.blockReason === "STATE_READ_FAILED"
            ? PROVISIONING_UNVERIFIABLE
            : NEW_PROVISIONING_MESSAGE[gate.state];
          return jsonResponse(req, { error: message }, 403);
        }
      }
```

`clearWhatsAppGateCache()` como primeira instrução do handler, depois do short-circuit de `OPTIONS` — mesmo padrão das Tasks 14 e 15.

- [ ] **Step 7: Escrever as mensagens**

```ts
/**
 * Mensagem por estado. Textos DIFERENTES de propósito: "regularize a
 * mensalidade" e "contrate a automação" pedem ações opostas, e um texto
 * genérico faria o cliente tentar a errada.
 */
const NEW_PROVISIONING_MESSAGE: Record<string, string> = {
  GRACE_PERIOD:
    "Há uma mensalidade da automação em aberto. Regularize em Cobrança para adicionar um novo número.",
  LEGACY_GRANDFATHERED:
    "Sua unidade usa a automação de WhatsApp em condição anterior à cobrança. Adicionar um novo número exige contratar a mensalidade da instância.",
  NOT_ENTITLED:
    "A automação de WhatsApp não está contratada para esta organização. Contrate em Cobrança para configurar o canal.",
  SUSPENDED_UNPAID:
    "Automação de WhatsApp suspensa por falta de pagamento. Regularize em Cobrança.",
  ADMIN_BLOCKED:
    "Automação de WhatsApp bloqueada administrativamente. Fale com o suporte.",
  ACTIVE: "Não foi possível criar o canal.",
  OVERRIDE_ACTIVE: "Não foi possível criar o canal.",
};

/**
 * Estado indeterminado ≠ sem direito. Dizer "você não contratou" a quem só
 * sofreu um soluço de leitura manda o cliente comprar o que já tem.
 */
const PROVISIONING_UNVERIFIABLE =
  "Não foi possível verificar o direito de uso da automação de WhatsApp agora. Tente novamente em alguns minutos.";
```

- [ ] **Step 8: Verificar e commitar**

```bash
grep -rn "newProvisioning\|provisioningBlockReason" supabase/ src/   # só as ocorrências novas
npm run typecheck && npm test && npm run lint
npx esbuild supabase/functions/manage-channels/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/_shared/whatsapp-service-state-core.ts supabase/functions/_shared/whatsapp-service-gate.ts src/lib/whatsapp-service-state-core.test.ts supabase/functions/manage-channels/index.ts
git commit -m "feat(billing): bloqueia canal novo de WhatsApp sem direito ativo"
```

- [ ] **Step 9: Atualizar o checklist de redeploy do CLAUDE.md**

`manage-channels` passa a consumir `whatsapp-service-gate.ts` (e, por ele, `whatsapp-service-state-core.ts`, `billing-financial-state-core.ts`, `billing-delinquency-core.ts` e `platform-flags.ts`). Acrescentar `manage-channels` a essas cinco linhas do checklist, conferindo cada uma contra os `import` reais do arquivo. Commitar junto.

---

## Task 17: Worker `process-whatsapp-enforcement`

**Files:**
- Create: `supabase/functions/process-whatsapp-enforcement/index.ts`
- Create: `supabase/migrations/20260727100500_083_cron_whatsapp_enforcement.sql`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `normalizeFinancialState` (Task 6), `resolveWhatsAppGateByOrg` (Task 13), `resolveBillingRecipient`/`enqueueBillingNotification`/`resolvePlatformAdminRecipients` de `_shared/billing-notify.ts`, colunas da Task 2.
- Produces: worker diário que suspende e restaura a assinatura de WhatsApp.

- [ ] **Step 1: Escrever o worker**

Cabeçalho e contrato:

```ts
// Worker: suspende e restaura o SERVIÇO de WhatsApp por inadimplência da
// mensalidade da instância. Roda diariamente via pg_cron.
//
// Suspender = billing_subscriptions.status='unpaid' + suspended_at. O núcleo de
// entitlements já trata `unpaid` como sem acesso, então nada nele muda; e
// `unpaid` não é `canceled`, então resolve_or_activate_subscription continua
// encontrando a linha e não cria uma segunda assinatura.
//
// NUNCA escreve organizations.billing_status — essa coluna representa o acesso
// ao SISTEMA, e a mensalidade da instância não governa o sistema.
// NUNCA escreve em organization_entitlement_overrides — override é ação
// administrativa; worker financeiro não mexe.
```

Laço, para cada assinatura `WHATSAPP_SUBSCRIPTION` com `status <> 'canceled'`:

1. Resolver o estado financeiro pelo núcleo, com a fatura em aberto mais antiga **excluindo `enforcement_hold`**.
2. **Ambiguidade** (mais de uma assinatura viva de WhatsApp para a mesma organização): não escolher; logar `evt:"whatsapp_ambiguous_subscription"`, avisar o administrador, pular a organização.
3. **Suspender** quando `state === "OVERDUE_BEYOND_GRACE"` **e** não houver override ativo de `whatsapp`:

```ts
      const { data: changed, error: updErr } = await supabase
        .from("billing_subscriptions")
        .update({ status: "unpaid", suspended_at: new Date().toISOString() })
        .eq("id", sub.id)
        .eq("status", "past_due")       // condicional: só quem estava em tolerância
        .select("id");
      // `.select("id")` é o que distingue "eu suspendi agora" de "já estava
      // suspensa" — só a execução que de fato mudou a linha enfileira o aviso.
```

Aceitar também transição a partir de `active` (assinatura que nunca passou por `past_due` porque o webhook de vencimento não chegou): usar `.in("status", ["active", "past_due"])` em vez do `.eq`.

4. Enfileirar `whatsapp_suspended` só quando `changed?.length` for maior que zero.
5. Com override ativo, **não suspender**, e registrar: `jsonLog("info", { evt: "whatsapp_suspension_skipped_override", org, sub: sub.id })` — o custo está patrocinado pela plataforma e isso precisa ser visível.
6. **Restaurar** quando `status === 'unpaid'` e `state === "PAID"`:

```ts
      const { data: restored } = await supabase
        .from("billing_subscriptions")
        .update({ status: "active", restored_at: new Date().toISOString(), suspended_at: null })
        .eq("id", sub.id)
        .eq("status", "unpaid")
        .select("id");
```

Enfileirar `whatsapp_restored` só quando mudou de fato.

7. **Gate de flag:** `whatsapp_service_enforcement` desligada → o worker calcula tudo, **não escreve nada**, e emite `evt:"whatsapp_enforcement_dryrun_worker"` por organização com o que teria feito. Responder `{ dry_run: true, would_suspend, would_restore }`.

Contadores na resposta: `subscriptions_scanned`, `suspended`, `restored`, `skipped_override`, `ambiguous`.

- [ ] **Step 2: Registrar no `config.toml`**

```toml
[functions.process-whatsapp-enforcement]
verify_jwt = false
```

- [ ] **Step 3: Escrever a migration do cron**

`0 11 * * *` — depois de `process-billing-overdue` (10:00 UTC), para que a escada do sistema já tenha rodado no mesmo dia. Copiar o padrão de wrapper `SECURITY DEFINER` + Vault + `pg_net.http_post` das migrations de cron existentes.

- [ ] **Step 4: Verificar sintaxe e commitar**

```bash
npx esbuild supabase/functions/process-whatsapp-enforcement/index.ts --bundle --platform=neutral --external:https://* --outfile=/dev/null
git add supabase/functions/process-whatsapp-enforcement/index.ts supabase/config.toml supabase/migrations/20260727100500_083_cron_whatsapp_enforcement.sql
git commit -m "feat(billing): worker de suspensao e restauracao do servico de WhatsApp"
```

---

## Task 18: Lembretes e avisos específicos do WhatsApp

**Files:**
- Modify: `supabase/functions/process-billing-reminders/index.ts`
- Modify: `supabase/functions/process-billing-notifications/index.ts:39-100`

**Interfaces:**
- Consumes: `isSystemInvoice` de `_shared/billing-category.ts` (para escolher o prefixo do `event_type`).
- Produces: event types `whatsapp_payment_pending`, `whatsapp_overdue_d1`, `whatsapp_overdue_d3`, `whatsapp_overdue_d5`, `whatsapp_suspended`, `whatsapp_restored`, `admin_correlation_ambiguity` com template próprio.

**Por que texto separado:** "seu acesso será suspenso" está errado para uma fatura que só desliga o WhatsApp. O cliente que ler isso e não pagar por não poder vai desligar o sistema inteiro na cabeça dele, sem necessidade.

- [ ] **Step 1: Fazer os lembretes cobrirem a fatura de WhatsApp**

Em `process-billing-reminders`, hoje as faturas não-sistema são ignoradas. Passar a tratá-las, mantendo os mesmos offsets do núcleo (`REMINDER_OFFSETS`: D0, D+1, D+3, D+5 — uma escada só, num lugar só) e escolhendo o prefixo do `event_type`:

```ts
      // Uma escada de dias, dois vocabulários. O prefixo decide o template, e
      // por consequência o que o cliente lê que vai acontecer.
      const isSystem = await isSystemInvoice(supabase, inv);
      const eventType = isSystem ? offset.type : `whatsapp_${offset.type}`;
```

Organização com override ativo de `whatsapp` **não recebe lembrete da mensalidade da instância** — o custo está patrocinado. Reusar a mesma checagem de override que o worker da Task 17 faz.

- [ ] **Step 2: Escrever os templates**

Em `process-billing-notifications`, acrescentar ao mapa de templates (o mesmo objeto que já tem `payment_pending`, `overdue_d1`, `suspended`, `regularized`):

```ts
  whatsapp_payment_pending: (d) => ({
    subject: "A mensalidade da automação de WhatsApp vence hoje",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} vence hoje. O restante do sistema não é afetado por esta cobrança.`,
    html: `<p>A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> vence hoje.</p><p>O restante do sistema não é afetado por esta cobrança.</p>`,
  }),
  whatsapp_overdue_d5: (d) => ({
    subject: "Último aviso antes da suspensão da automação de WhatsApp",
    text: `A mensalidade da automação de WhatsApp de ${d.orgName} está em atraso. Amanhã os envios e o atendimento automático pelo WhatsApp serão suspensos. Reservas, agenda, painel e relatórios continuam funcionando normalmente.`,
    html: `<p>A mensalidade da automação de WhatsApp de <strong>${d.orgName}</strong> está em atraso.</p><p>Amanhã os envios e o atendimento automático pelo WhatsApp serão suspensos. <strong>Reservas, agenda, painel e relatórios continuam funcionando normalmente.</strong></p>`,
  }),
  whatsapp_suspended: (d) => ({
    subject: "Automação de WhatsApp suspensa",
    text: `A automação de WhatsApp de ${d.orgName} foi suspensa por falta de pagamento. O sistema segue funcionando: reservas, agenda, clientes e relatórios não foram afetados. Regularize a mensalidade para retomar os envios.`,
    html: `<p>A automação de WhatsApp de <strong>${d.orgName}</strong> foi suspensa por falta de pagamento.</p><p>O sistema segue funcionando: reservas, agenda, clientes e relatórios não foram afetados. Regularize a mensalidade para retomar os envios.</p>`,
  }),
  whatsapp_restored: (d) => ({
    subject: "Automação de WhatsApp reativada",
    text: `Pagamento confirmado. A automação de WhatsApp de ${d.orgName} voltou a funcionar. Mensagens que ficaram pendentes durante a suspensão são reavaliadas antes de sair — as que perderam validade não são enviadas.`,
    html: `<p>Pagamento confirmado. A automação de WhatsApp de <strong>${d.orgName}</strong> voltou a funcionar.</p><p>Mensagens que ficaram pendentes durante a suspensão são reavaliadas antes de sair — as que perderam validade não são enviadas.</p>`,
  }),
  admin_correlation_ambiguity: (d) => ({
    subject: `[interno] Evento de cobrança precisa de conferência — ${d.orgName}`,
    text: `Um evento do Asaas não pôde ser correlacionado com segurança. Nada foi escrito e o evento continua na fila. Verifique billing_events no painel da plataforma.`,
    html: `<p>Um evento do Asaas não pôde ser correlacionado com segurança.</p><p>Nada foi escrito e o evento continua na fila. Verifique <code>billing_events</code> no painel da plataforma.</p>`,
  }),
```

Escrever também `whatsapp_overdue_d1` e `whatsapp_overdue_d3` no mesmo formato, com assuntos "Mensalidade da automação em atraso" e "Mensalidade da automação em atraso (3 dias)" e o mesmo corpo que deixa explícito que o sistema não é afetado.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/process-billing-reminders/index.ts supabase/functions/process-billing-notifications/index.ts
git commit -m "feat(billing): avisos proprios da mensalidade da automacao de WhatsApp"
```

---

## Task 19: Estacionamento e revalidação de jobs

**Files:**
- Modify: `supabase/functions/process-notification-outbox/index.ts:90-140`
- Modify: `supabase/functions/process-reservation-reminders/index.ts`
- Modify: `supabase/functions/process-satisfaction-surveys/index.ts`
- Modify: `supabase/functions/process-voucher-triggers/index.ts`
- Modify: `supabase/functions/process-waitlist-entered/index.ts`
- Modify: `supabase/functions/process-waitlist-feedback/index.ts`

**Interfaces:**
- Consumes: `resolveWhatsAppGateByUnit`, `clearWhatsAppGateCache` (Task 13).

**Onde há fila de verdade:** só `notification_outbox` tem `attempts`/backoff/`dead`. Os outros quatro consultam reservas diretamente — suspensos, simplesmente pulam a unidade, e não voltam atrasados depois porque a data que os justificava já passou.

- [ ] **Step 1: Estacionar no outbox**

O worker reivindica linhas marcando `status='processing'` **antes** de saber se pode enviar ([index.ts:94-100](../../../supabase/functions/process-notification-outbox/index.ts)). Depois de reivindicar, agrupar por `unit_id` e devolver as das unidades suspensas:

```ts
    clearWhatsAppGateCache();

    const rows = (claimed ?? []) as OutboxRow[];
    processed = rows.length;

    const toDispatch: OutboxRow[] = [];
    const parked: OutboxRow[] = [];

    for (const row of rows) {
      const gate = await resolveWhatsAppGateByUnit(supabase, row.unit_id);
      if (gate?.enforced.sending) parked.push(row);
      else toDispatch.push(row);
    }

    if (parked.length > 0) {
      // ESTACIONAMENTO: volta a 'pending', adia uma hora e NÃO incrementa
      // `attempts`. Sem isso, o teto de 5 tentativas é consumido pela suspensão
      // e o job vira 'dead' por não ter sido enviado enquanto o cliente estava
      // suspenso — perdendo a mensagem de vez quando ele pagar.
      const { error: parkErr } = await supabase
        .from("notification_outbox")
        .update({
          status: "pending",
          next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
          last_error: "whatsapp_service_suspended",
          updated_at: new Date().toISOString(),
        })
        .in("id", parked.map((r) => r.id));
      if (parkErr) {
        jsonLog("error", { evt: "outbox_park_failed", count: parked.length, err: parkErr.message });
      } else {
        jsonLog("info", { evt: "outbox_parked", count: parked.length });
      }
    }
```

O laço de despacho passa a iterar `toDispatch`, não `rows`. Acrescentar `parked: parked.length` à resposta JSON.

- [ ] **Step 2: Revalidar antes de despachar**

Antes de `dispatchOne(row)`, para `kind === "confirmation"`:

```ts
/**
 * Um job estacionado pode ter perdido a validade enquanto o serviço estava
 * suspenso. NÃO SE REENVIA TUDO AUTOMATICAMENTE: confirmação de reserva que já
 * aconteceu é ruído para o cliente e custo para o lojista.
 *
 * Vale também fora da suspensão — um job represado por 5 tentativas de falha
 * tem o mesmo problema. Por isso a checagem é do despacho, não do desestaciona.
 */
async function stillValid(row: OutboxRow): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: r } = await supabase
    .from("reservations")
    .select("id, date, time, status")
    .eq("id", row.reservation_id)
    .maybeSingle();

  if (!r) return { ok: false, reason: "reservation_missing" };
  if (r.status === "cancelled") return { ok: false, reason: "reservation_cancelled" };

  // Data e hora da reserva são horário local (BRT); comparar em BRT.
  const when = new Date(`${r.date}T${r.time ?? "23:59"}:00-03:00`).getTime();
  if (when < Date.now()) return { ok: false, reason: "reservation_in_the_past" };

  const { data: sent } = await supabase
    .from("notifications_sent")
    .select("id")
    .eq("reservation_id", row.reservation_id)
    .eq("kind", row.kind)
    .maybeSingle();
  if (sent) return { ok: false, reason: "already_sent" };

  return { ok: true };
}
```

Job inválido vira concluído com o motivo registrado, não enviado:

```ts
      const validity = await stillValid(row);
      if (!validity.ok) {
        await supabase
          .from("notification_outbox")
          .update({ status: "done", last_error: `expired_after_suspension:${validity.reason}`, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        jsonLog("info", { evt: "outbox_expired", id: row.id, reason: validity.reason });
        expired++;
        continue;
      }
```

Declarar o contador `expired` junto de `processed`/`succeeded`/`failed` e devolvê-lo na resposta.

- [ ] **Step 3: Pular a unidade nos outros quatro workers**

Em cada um dos cinco arquivos restantes, no topo do laço por unidade:

```ts
    const gate = await resolveWhatsAppGateByUnit(supabase, unitId);
    if (gate?.enforced.sending) {
      // Pula a unidade SEM gravar linha em `notifications_sent`: uma linha
      // `failed` ali bloquearia o reenvio depois da restauração pelo UNIQUE
      // (reservation_id, kind).
      jsonLog("info", { evt: "worker_skipped_whatsapp_suspended", unit_id: unitId, state: gate.state });
      continue;
    }
```

E `clearWhatsAppGateCache()` no início de cada invocação, junto do reset de `unitCache` que os workers já fazem.

- [ ] **Step 4: Verificar sintaxe de todos e commitar**

```bash
for f in process-notification-outbox process-reservation-reminders process-satisfaction-surveys process-voucher-triggers process-waitlist-entered process-waitlist-feedback; do
  npx esbuild "supabase/functions/$f/index.ts" --bundle --platform=neutral --external:https://* --outfile=/dev/null || echo "FALHOU: $f"
done
git add supabase/functions/process-notification-outbox/index.ts supabase/functions/process-reservation-reminders/index.ts supabase/functions/process-satisfaction-surveys/index.ts supabase/functions/process-voucher-triggers/index.ts supabase/functions/process-waitlist-entered/index.ts supabase/functions/process-waitlist-feedback/index.ts
git commit -m "feat(billing): estaciona e revalida jobs durante suspensao do WhatsApp"
```

---

## Task 20: Superfície do cliente e do administrador

**Files:**
- Modify: `supabase/functions/manage-whatsapp-implementations/index.ts` (action `get_service_status` + duas actions administrativas de grandfathering)
- Modify: `supabase/functions/manage-billing/index.ts` (action nova `release_invoice_enforcement_hold`)
- Modify: `supabase/functions/_shared/entitlement-overrides.ts` (revogação `REPLACED_BY_OVERRIDE`)
- Create: `src/components/billing/WhatsappServiceBanner.tsx`
- Modify: `src/pages/gestao/Cobranca.tsx`
- Modify: `src/pages/gestao/Conversas.tsx`
- Modify: a página de automação do lojista (`/g/:slug/automacao`)
- Modify: `src/pages/platform/WhatsappImplementations.tsx` (estado e botões de grandfathering)
- Modify: a página de billing da plataforma (`/platform/billing`) — seção de faturas retidas

**Interfaces:**
- Consumes: `resolveWhatsAppGateByOrg` (Task 13); colunas de grandfathering da Task 3.
- Produces: `get_service_status` devolve `serviceState`, `sendingBlocked`, `graceEndsAt`, `suspendedAt`; `manage-billing` aceita `action: "release_invoice_enforcement_hold"`; `manage-whatsapp-implementations` aceita `revoke_whatsapp_grandfathering` e `grant_whatsapp_grandfathering`.

**Cobertura da revogação terminal:** a spec §6.3 lista quatro gatilhos. `FIRST_PAID_SUBSCRIPTION` vive na RPC (Task 3); `REPLACED_BY_OVERRIDE`, `ADMIN_MIGRATION` e `ADMIN_REVOCATION` são desta task. Sem os três, a revogação terminal fica pela metade e o grandfathering nunca acaba na prática.

- [ ] **Step 1: Ampliar `get_service_status`**

Acrescentar ao payload de resposta:

```ts
      const gate = await resolveWhatsAppGateByOrg(supabase, organizationId);
      // Contrato de `readFailed`: esta action AFIRMA um estado pro cliente. Se
      // alguma leitura falhou, o objeto pode estar subestimando o acesso real —
      // responder 200 com ele seria mentir com confiança.
      if (gate.readFailed) {
        return jsonResponse(req, { error: "Não foi possível verificar o status do serviço agora. Tente novamente." }, 503);
      }
```

E, no corpo: `serviceState: gate.state`, `sendingBlocked: gate.enforced.sending`, `graceEndsAt` e `suspendedAt` (lidos da assinatura). **Nada de dado financeiro sensível** — só estado e datas.

- [ ] **Step 2: Escrever a action de liberação de retenção**

Em `manage-billing`, **fora** da whitelist `CLIENT_FRIENDLY_ACTIONS` (é exclusiva de `platform_admin`):

```ts
    if (action === "release_invoice_enforcement_hold") {
      const { invoice_id, reason } = body;
      if (!invoice_id || typeof reason !== "string" || reason.trim().length < 5) {
        return jsonResponse(req, { error: "Informe a fatura e o motivo da liberação." }, 400);
      }
      const { data: released, error } = await supabase
        .from("billing_invoices")
        .update({
          enforcement_hold: false,
          enforcement_released_at: new Date().toISOString(),
          enforcement_released_by: callerUserId,
        })
        .eq("id", invoice_id)
        .eq("enforcement_hold", true)   // condicional: liberar duas vezes não reescreve a autoria
        .select("id, organization_id");
      if (error) {
        jsonLog("error", { reqId, evt: "billing_release_hold_failed", invoice_id, err: error.message });
        return jsonResponse(req, { error: "Não foi possível liberar a fatura." }, 500);
      }
      if (!released?.length) {
        return jsonResponse(req, { error: "Fatura não está retida." }, 409);
      }
      // Auditoria: quem liberou, quando e por quê. Sem isso, uma fatura sai da
      // retenção e volta a poder suspender um cliente sem rastro de decisão.
      await supabase.from("billing_events").insert({
        organization_id: released[0].organization_id,
        provider: "asaas",
        event_type: "internal.invoice_hold_released",
        processing_status: "processed",
        payload: { invoice_id, reason: reason.trim(), released_by: callerUserId },
      });
      return jsonResponse(req, { success: true });
    }
```

Conferir os nomes reais das colunas de `billing_events` no arquivo antes de escrever o insert — imitar outro insert existente no mesmo arquivo.

- [ ] **Step 3: Revogar o grandfathering ao conceder override formal**

A migration 079 cobre um dos quatro gatilhos de revogação (`FIRST_PAID_SUBSCRIPTION`, dentro da RPC). Os outros três são código, e sem eles a revogação terminal que a spec exige fica pela metade.

Em [_shared/entitlement-overrides.ts](../../../supabase/functions/_shared/entitlement-overrides.ts) — que é o **writer único** de `organization_entitlement_overrides` —, depois de gravar uma concessão (`enabled=true`) de `feature='whatsapp'`:

```ts
  // Override formal SUBSTITUI o grandfathering: a organização passa a ter
  // direito por decisão administrativa registrada, não por antiguidade. E a
  // revogação é TERMINAL — revogar o override depois NÃO devolve o
  // grandfathering, senão "concedo, revogo, volto a ser legado" viraria
  // isenção permanente com aparência de processo.
  if (feature === "whatsapp" && enabled === true) {
    await supabase
      .from("organizations")
      .update({
        whatsapp_grandfather_revoked_at: new Date().toISOString(),
        whatsapp_grandfather_revoked_reason: "REPLACED_BY_OVERRIDE",
        whatsapp_grandfather_revoked_by: actorUserId,
      })
      .eq("id", organizationId)
      .eq("whatsapp_legacy_grandfathered", true)
      .is("whatsapp_grandfather_revoked_at", null);
  }
```

Best-effort: falha aqui loga e **não** derruba a concessão do override — o direito de acesso é o efeito principal, o encerramento do grandfathering é consequência administrativa.

- [ ] **Step 4: Actions administrativas de grandfathering**

Em `manage-whatsapp-implementations` (fora de `CLIENT_FRIENDLY_ACTIONS` — exclusivas de `platform_admin`), duas actions:

```ts
    // Encerra o grandfathering por decisão administrativa. `reason` decide o
    // rótulo: ADMIN_MIGRATION quando a empresa foi formalmente migrada para o
    // modelo comercial; ADMIN_REVOCATION quando é revogação pura.
    if (action === "revoke_whatsapp_grandfathering") {
      const { organization_id, reason, note } = body;
      if (!organization_id || (reason !== "ADMIN_MIGRATION" && reason !== "ADMIN_REVOCATION")) {
        return jsonResponse(req, { error: "Informe a organização e o motivo (ADMIN_MIGRATION ou ADMIN_REVOCATION)." }, 400);
      }
      if (typeof note !== "string" || note.trim().length < 5) {
        return jsonResponse(req, { error: "Descreva o motivo da revogação." }, 400);
      }
      const { data: rows, error } = await supabase
        .from("organizations")
        .update({
          whatsapp_grandfather_revoked_at: new Date().toISOString(),
          whatsapp_grandfather_revoked_reason: reason,
          whatsapp_grandfather_revoked_by: callerUserId,
        })
        .eq("id", organization_id)
        .eq("whatsapp_legacy_grandfathered", true)
        .is("whatsapp_grandfather_revoked_at", null)
        .select("id");
      if (error) return jsonResponse(req, { error: "Não foi possível revogar." }, 500);
      if (!rows?.length) return jsonResponse(req, { error: "Organização não está em condição legada ativa." }, 409);
      jsonLog("info", { reqId, evt: "whatsapp_grandfathering_revoked", org: organization_id, reason, by: callerUserId });
      return jsonResponse(req, { success: true });
    }

    // Reconceder é ação explícita, nunca automática: a revogação é terminal
    // justamente para que voltar a ser legado exija um humano decidindo.
    if (action === "grant_whatsapp_grandfathering") {
      const { organization_id, note } = body;
      if (!organization_id || typeof note !== "string" || note.trim().length < 5) {
        return jsonResponse(req, { error: "Informe a organização e o motivo." }, 400);
      }
      const { error } = await supabase
        .from("organizations")
        .update({
          whatsapp_legacy_grandfathered: true,
          whatsapp_grandfathered_at: new Date().toISOString(),
          whatsapp_grandfathered_source: "ADMIN",
          whatsapp_grandfather_revoked_at: null,
          whatsapp_grandfather_revoked_reason: null,
          whatsapp_grandfather_revoked_by: null,
        })
        .eq("id", organization_id);
      if (error) return jsonResponse(req, { error: "Não foi possível conceder." }, 500);
      jsonLog("warn", { reqId, evt: "whatsapp_grandfathering_granted", org: organization_id, by: callerUserId, note: note.trim() });
      return jsonResponse(req, { success: true });
    }
```

A tela de implantações da plataforma ganha, na linha da organização, o estado do grandfathering e os dois botões, com campo de motivo obrigatório.

- [ ] **Step 5: Banner no lojista**

Componente novo `src/components/billing/WhatsappServiceBanner.tsx`, alimentado pelo `get_service_status`, renderizado em Cobrança, Conversas e Automação. Renderiza:

- `SUSPENDED_UNPAID`: destrutivo — "Automação de WhatsApp suspensa por falta de pagamento desde `<data>`. Reservas, agenda e relatórios seguem funcionando." + botão para `/g/<slug>/cobranca`.
- `GRACE_PERIOD`: aviso — "Mensalidade da automação em aberto. Suspensão em `<graceEndsAt>`."
- `ADMIN_BLOCKED`: destrutivo, sem CTA de pagamento — "Automação bloqueada administrativamente. Fale com o suporte."
- Demais estados: não renderiza nada.

**Sem banner global e sem bloqueio de rota.** Painel, agenda, reservas, clientes, relatórios, e-mails e a página de cobrança continuam funcionando — a suspensão é do WhatsApp, não do sistema.

Usar `cn()` de `@/lib/utils` e tokens do tema; nunca cor hardcoded.

- [ ] **Step 6: Painel de faturas retidas**

Na página de billing da plataforma, uma seção listando `billing_invoices` com `enforcement_hold = true`: organização, valor, vencimento, motivo, data da retenção, e ação "Liberar" com campo de motivo obrigatório. Tratar os quatro estados de lista (carregando / erro com `refetch()` / vazia / lista), como manda o padrão do projeto — silenciar erro como lista vazia já mascarou incidente em produção.

- [ ] **Step 7: Rodar typecheck, lint e testes**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 0 erros de tipo, warnings na baseline, **295 testes** passando (265 da baseline + 26 dos três núcleos + 4 do `PAYMENT_CREATED`).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/manage-whatsapp-implementations/index.ts supabase/functions/manage-billing/index.ts supabase/functions/_shared/entitlement-overrides.ts src/components/billing/WhatsappServiceBanner.tsx src/pages/gestao/Cobranca.tsx src/pages/gestao/Conversas.tsx
git commit -m "feat(billing): superficie do servico, liberacao de retencao e revogacao do grandfathering"
```

---

## Task 21: Documentação, invariantes e roteiro de sandbox

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/billing-asaas/FASE-5B-RESUMO.md`
- Create: `docs/billing-asaas/FASE-5B-ROTEIRO-SANDBOX.md`
- Modify: `docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md` (marcar a Fase 5 como concluída e apontar para a 6)

- [ ] **Step 1: Acrescentar os invariantes ao `CLAUDE.md`**

Formato obrigatório: **regra em 1 frase. Por quê (1 frase). [arquivo.ts](arquivo.ts).** Sem storytelling, sem data de bug.

Na seção Billing:

- **O gate pai do WhatsApp lê `organizations.billing_status`, nunca `entitlements.system.allowed`.** Aquele campo é `false` para organização legada com `billing_status='active'` e sem assinatura de sistema, e usá-lo bloquearia exatamente quem nunca deveria ser bloqueado. [whatsapp-service-state-core.ts](supabase/functions/_shared/whatsapp-service-state-core.ts).
- **Ausência de direito de WhatsApp NÃO bloqueia envio; bloqueia provisionamento novo.** `entitlements.whatsapp.allowed` é `false` para toda org sem assinatura nem override, e gatear envio por ele silenciaria todo cliente que já usa WhatsApp e nunca comprou a instância. [whatsapp-service-state-core.ts](supabase/functions/_shared/whatsapp-service-state-core.ts).
- **A revogação do grandfathering é terminal — cancelar a assinatura depois não o restaura.** Sem isso, "assino, cancelo, volto a ser legado" viraria isenção permanente. [migration 079](supabase/migrations/20260727100200_079_whatsapp_legacy_grandfathering.sql).
- **`PAYMENT_CREATED` cria a fatura em aberto e é o único caminho pelo qual a renovação entra na inadimplência.** Antes da 5b ele era informativo e os workers de cobrança rodavam sobre entrada vazia. [asaas-billing-events.ts](supabase/functions/_shared/asaas-billing-events.ts).
- **A renovação do mês 2+ só correlaciona por `provider_subscription_id`.** Ela nasce da assinatura, sem `externalReference`, sem `checkoutSession`, e com um `customer` que pode ser o que o pagador criou na página hospedada. [billing-correlation-core.ts](supabase/functions/_shared/billing-correlation-core.ts).
- **Divergência de organização entre degraus de correlação derruba o evento.** Escrever no tenant errado é pior que atrasar um pagamento. [billing-correlation-core.ts](supabase/functions/_shared/billing-correlation-core.ts).
- **Fatura com `enforcement_hold` não conta como atraso em lugar nenhum.** É o freio que impede a primeira varredura da ingestão de suspender por dívida antiga nunca cobrada; hold esquecido é cliente que nunca é cobrado, e o painel existe para isso não ficar invisível. [migration 077](supabase/migrations/20260727100000_077_billing_invoice_enforcement_hold.sql).
- **Job estacionado por suspensão não incrementa `attempts`.** Sem isso o teto de 5 tentativas é consumido pela suspensão e a mensagem se perde justamente quando o cliente paga. [process-notification-outbox](supabase/functions/process-notification-outbox/index.ts).

Na seção "Workers automáticos", acrescentar as duas linhas novas à tabela: `process-asaas-invoice-reconcile` (`0 8 * * *`) e `process-whatsapp-enforcement` (`0 11 * * *`).

Na seção "Observabilidade WhatsApp", acrescentar o outcome `whatsapp_service_suspended`.

- [ ] **Step 2: Atualizar o checklist de redeploy do `CLAUDE.md`**

Acrescentar as entradas dos quatro módulos `_shared/` novos, com a lista completa de consumidores:

- `billing-correlation-core.ts` → `asaas-webhook`, `process-asaas-reconcile`, `manage-billing` (via `asaas-billing-events-apply.ts`)
- `billing-financial-state-core.ts` → tudo que importa `whatsapp-service-gate.ts`, mais `process-whatsapp-enforcement`
- `whatsapp-service-state-core.ts` → idem
- `whatsapp-service-gate.ts` → `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `webhook-whatsapp`, `manage-channels`, `manage-whatsapp-implementations`, `process-whatsapp-enforcement`, `process-notification-outbox`, `process-reservation-reminders`, `process-satisfaction-surveys`, `process-voucher-triggers`, `process-waitlist-entered`, `process-waitlist-feedback`

E ampliar as linhas existentes de `asaas-billing-events.ts`, `asaas.ts`, `platform-flags.ts`, `billing-notify.ts` e `whatsapp-send.ts` com os consumidores novos.

- [ ] **Step 3: Escrever o resumo da fase**

`docs/billing-asaas/FASE-5B-RESUMO.md`, no mesmo formato do [FASE-5A-RESUMO.md](../../billing-asaas/FASE-5A-RESUMO.md): estado atual, escopo entregue, tabela de verificações, resultado dos gates `saas-shield-br`, runbook de deploy (ordem de redeploy das Edge Functions, `db push`, ordem de ativação das flags), riscos residuais e próxima fase. **Registrar o resultado do relatório de grandfathering da migration 079** — quais organizações foram marcadas.

- [ ] **Step 4: Escrever o roteiro de sandbox**

`docs/billing-asaas/FASE-5B-ROTEIRO-SANDBOX.md`, formato do [FASE-5A-ROTEIRO-SANDBOX.md](../../billing-asaas/FASE-5A-ROTEIRO-SANDBOX.md): uma linha por cenário, com passo a passo verificável e resultado esperado objetivo, e coluna para o resultado real. Cobrir os 31 cenários da §11 da spec, mais o passo a passo da ordem de ativação das flags (§9 da spec).

- [ ] **Step 5: Rodar a bateria completa**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: lint 0 erros / 22 warnings, typecheck 0 erros, **295 testes**, build sem erro.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/billing-asaas/FASE-5B-RESUMO.md docs/billing-asaas/FASE-5B-ROTEIRO-SANDBOX.md docs/billing-asaas/01-PLANO-IMPLEMENTACAO.md
git commit -m "docs(billing): invariantes, resumo e roteiro de sandbox da fase 5b"
```

---

## Fechamento da fase (fora das tasks — executado pelo dono)

Checklist padrão de fim de fase, de [01-PLANO-IMPLEMENTACAO.md § Checklist](../../billing-asaas/01-PLANO-IMPLEMENTACAO.md):

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` — todos limpos.
2. Gates `saas-shield-br` obrigatórios (a fase toca banco, webhook, RLS e multi-tenant): `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`, `migration-validator`, `secret-hunter`, `integration-reliability-auditor`.
3. Pré-flight SQL das migrations, depois `supabase db push`.
4. Redeploy de **todas** as Edge Functions afetadas — a lista sai do checklist do `CLAUDE.md` atualizado na Task 21. Edge Functions não compartilham bundle em runtime: redeploy parcial deixa consumidor com `_shared/` velho em memória.
5. Roteiro de sandbox executado, coluna de resultado real preenchida, veredito trazido de volta ao resumo.
6. Merge `--no-ff` em `main` **por `refs/heads/billing-asaas/fase-5b`** — tag e branch são homônimas e isso já causou merge errado duas vezes; conferir que `git log --oneline main..refs/heads/billing-asaas/fase-5b` sai vazio.
7. Tag `billing-asaas/fase-5b` no commit de merge; push de `main` e da tag.

**As flags continuam OFF ao fim da fase.** Ligar `billing_invoice_ingestion` e depois `whatsapp_service_enforcement` é decisão separada, na ordem da §9 da spec.

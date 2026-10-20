# Fase 4b (enxuta) — Inadimplência: acesso desliga + notificações — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando uma mensalidade Asaas fica vencida, o acesso da organização desliga em cadência (tolerância 5 dias → bloqueio D+6) e o cliente é avisado por e-mail real; quando paga, o acesso restaura e o cliente é avisado.

**Architecture:** Três produtores (`process-billing-overdue`, `process-billing-reminders`, o aplicador `applyAsaasEvent`) enfileiram linhas em `billing_notifications` (`status='pending'`) com dedupe DB-enforced por UNIQUE `(organization_id, event_type, invoice_id)`; um consumidor novo (`process-billing-notifications`, gated por flag) renderiza o template e envia via Resend. A lógica pura (datas BRT, máquina de estados, seleção de destinatário) mora num módulo `_shared/*-core.ts` de zero imports, testado por vitest a partir de `src/`.

**Tech Stack:** Deno Edge Functions, Supabase (Postgres + pg_cron + Vault), Resend (`_shared/email.ts`), vitest.

## Global Constraints

- **Repo público + deploy automático Vercel.** Antes de QUALQUER commit: `git status` + `git diff --cached`, revisar 100% das linhas. Padrões proibidos: `sk-`, `sk-ant-`, `eyJ`, `Bearer `, `service_role` (valor), `SERVICE_ROLE_KEY`, `password`/`senha`/`token`/`api_key` com valor real, URLs com creds. **Nunca `git add .`/`-A`** — sempre `git add caminho/arquivo`. Em dúvida, não commite.
- **Timestamps sensíveis a dia SEMPRE em BRT** (`BRT_OFFSET_MS = 3*60*60*1000`; Deno roda em UTC). `new Date().toISOString().slice(0,10)` cru é regressão nos workers desta fase.
- **`billing_notifications` é FORCE RLS sem policies** — acesso só via service_role/Edge Function. Não criar policy.
- **Dedupe é DB-enforced (UNIQUE) + insert tratando `23505` como no-op** (padrão voucher do CLAUDE.md). Nunca SELECT-then-insert como dedupe.
- **Nunca usar o canal WhatsApp da própria org inadimplente** para avisar de cobrança. Só e-mail (Resend).
- **Inadimplência respeita override vitalício ANTES de escalar/avisar** — org com `organization_entitlement_overrides` ativo (`feature='system'`, `enabled=true`, `revoked_at is null`, `ends_at` nulo/futuro) nunca é bloqueada nem recebe aviso. Também respeita `billing_access_overrides` `grant_access` (legado) e nunca rebaixa `manual_override`/`canceled`.
- **Terminal de bloqueio = `billing_status='blocked'`** (reuso de `blocked_at`/`blocked_reason`), NÃO um status `suspended` novo. `GRACE_PERIOD_DAYS=5`, `BLOCK_AFTER_DAYS=6`.
- **`verify_jwt=false` explícito no `config.toml` para o worker novo, no MESMO commit** que cria a EF (CLI ≥2.95 default virou `true`; sem isso o gateway 401 antes do `requireInternalAuth`).
- **`npm run typecheck` = `tsc -b --noEmit`** (nunca sem `-b`). **Migrations sempre via `supabase db push`**, nunca Studio. Migration idempotente (`if not exists`, `on conflict do nothing`).
- **Edge Functions não compartilham bundle** — mudar `_shared/X.ts` exige redeploy de TODAS as EFs que importam (checklist no CLAUDE.md, atualizado nesta fase).
- Mensagens de commit terminam com `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

**Criados:**
- `supabase/functions/_shared/billing-delinquency-core.ts` — PURO (zero imports). Datas BRT, máquina de estados de atraso, offsets de lembrete, `pickRecipient`. Fonte única testável.
- `src/lib/billing-delinquency-core.test.ts` — vitest da lógica pura acima.
- `supabase/functions/_shared/billing-notify.ts` — IMPURO. `resolveBillingRecipient` (fallback de owner **escopado por org** — fecha o vazamento), `enqueueBillingNotification` (insert on-conflict-nothing), `hasActiveSystemOverride`.
- `supabase/functions/process-billing-notifications/index.ts` — worker dispatcher (consome `pending` → Resend), com `TEMPLATE_BY_EVENT` (6 templates).
- `supabase/migrations/20260719150000_068_billing_notifications_cycle.sql` — `invoice_id` + UNIQUE + índice de status em `billing_notifications`; `restored_at` em `organizations`.
- `supabase/migrations/20260719151000_069_process_billing_notifications_cron.sql` — pg_cron do dispatcher.
- `docs/billing-asaas/FASE-4B-RESUMO.md` — resumo de execução.

**Modificados:**
- `supabase/functions/process-billing-overdue/index.ts` — grace 5/block 6, BRT, skip override, enfileira `suspended`.
- `supabase/functions/process-billing-reminders/index.ts` — cadência D+1/D+3/D+5, **fix do vazamento**, on-conflict enqueue, BRT.
- `supabase/functions/_shared/asaas-billing-events-apply.ts` — regularização (restored_at + `regularized`).
- `supabase/config.toml` — entrada `process-billing-notifications`.
- `CLAUDE.md` — tabela de workers, invariantes, checklist de redeploy.

---

## Task 1: Núcleo puro — datas BRT + máquina de estados + destinatário

**Files:**
- Create: `supabase/functions/_shared/billing-delinquency-core.ts`
- Test: `src/lib/billing-delinquency-core.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `todayBrt(nowMs?: number): string`, `addDaysToDate(date: string, days: number): string`, `daysOverdue(dueDate: string, today: string): number`, `decideDelinquencyStatus(dueDate: string, today: string): "grace_period" | "blocked" | null`, `pickRecipient(billingEmail?: string|null, ownerEmail?: string|null): string | null`, `REMINDER_OFFSETS: {days:number; type:string}[]`, `GRACE_PERIOD_DAYS`, `BLOCK_AFTER_DAYS`.

- [ ] **Step 1: Escrever o teste que falha**

Create `src/lib/billing-delinquency-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  todayBrt,
  addDaysToDate,
  daysOverdue,
  decideDelinquencyStatus,
  pickRecipient,
  REMINDER_OFFSETS,
} from "../../supabase/functions/_shared/billing-delinquency-core";

describe("todayBrt", () => {
  it("volta o dia BRT, não UTC, perto da meia-noite", () => {
    // 2026-07-20T01:30:00Z == 2026-07-19 22:30 BRT -> dia BRT é 19
    expect(todayBrt(Date.parse("2026-07-20T01:30:00Z"))).toBe("2026-07-19");
    // 2026-07-19T12:00:00Z == 09:00 BRT -> 19
    expect(todayBrt(Date.parse("2026-07-19T12:00:00Z"))).toBe("2026-07-19");
  });
});

describe("addDaysToDate", () => {
  it("soma dias sem cruzar fuso e vira o mês", () => {
    expect(addDaysToDate("2026-07-19", 3)).toBe("2026-07-22");
    expect(addDaysToDate("2026-02-27", 2)).toBe("2026-03-01"); // 2026 não bissexto
  });
});

describe("daysOverdue", () => {
  it("conta dias de vencido (positivo = atrasado)", () => {
    expect(daysOverdue("2026-07-19", "2026-07-19")).toBe(0);
    expect(daysOverdue("2026-07-18", "2026-07-19")).toBe(1);
    expect(daysOverdue("2026-07-25", "2026-07-19")).toBe(-6);
  });
});

describe("decideDelinquencyStatus", () => {
  it("null quando não vencida (due hoje ou futuro)", () => {
    expect(decideDelinquencyStatus("2026-07-19", "2026-07-19")).toBeNull();
    expect(decideDelinquencyStatus("2026-07-25", "2026-07-19")).toBeNull();
  });
  it("grace_period de D+1 a D+5", () => {
    expect(decideDelinquencyStatus("2026-07-18", "2026-07-19")).toBe("grace_period"); // D+1
    expect(decideDelinquencyStatus("2026-07-14", "2026-07-19")).toBe("grace_period"); // D+5
  });
  it("blocked em D+6 ou mais", () => {
    expect(decideDelinquencyStatus("2026-07-13", "2026-07-19")).toBe("blocked"); // D+6
    expect(decideDelinquencyStatus("2026-06-19", "2026-07-19")).toBe("blocked");
  });
});

describe("pickRecipient", () => {
  it("prefere billing_email; senão owner; senão null", () => {
    expect(pickRecipient("a@b.com", "owner@x.com")).toBe("a@b.com");
    expect(pickRecipient(null, "owner@x.com")).toBe("owner@x.com");
    expect(pickRecipient("  ", "owner@x.com")).toBe("owner@x.com");
    expect(pickRecipient(null, null)).toBeNull();
  });
});

describe("REMINDER_OFFSETS", () => {
  it("tem os 4 offsets do ciclo, na ordem", () => {
    expect(REMINDER_OFFSETS.map((o) => o.type)).toEqual([
      "payment_pending",
      "overdue_d1",
      "overdue_d3",
      "overdue_d5",
    ]);
    expect(REMINDER_OFFSETS.map((o) => o.days)).toEqual([0, 1, 3, 5]);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- billing-delinquency-core`
Expected: FAIL — "Cannot find module '../../supabase/functions/_shared/billing-delinquency-core'".

- [ ] **Step 3: Implementar o módulo puro**

Create `supabase/functions/_shared/billing-delinquency-core.ts`:

```ts
// Núcleo PURO da inadimplência (Fase 4b). ZERO imports — importável por vitest a
// partir de src/ (mesmo padrão de _shared/entitlements-core.ts). Deno roda em UTC:
// toda conta de "dia" passa por BRT aqui.

export const GRACE_PERIOD_DAYS = 5;
export const BLOCK_AFTER_DAYS = 6;

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** "Hoje" no fuso BRT como YYYY-MM-DD. Passe nowMs fixo nos testes. */
export function todayBrt(nowMs: number = Date.now()): string {
  return new Date(nowMs - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Soma `days` a uma data YYYY-MM-DD, ancorada ao meio-dia UTC (não cruza fuso). */
export function addDaysToDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dias de atraso de `dueDate` até `today` (YYYY-MM-DD). Positivo = vencida. */
export function daysOverdue(dueDate: string, today: string): number {
  const due = new Date(dueDate + "T12:00:00Z").getTime();
  const now = new Date(today + "T12:00:00Z").getTime();
  return Math.round((now - due) / DAY_MS);
}

export type DelinquencyStatus = "grace_period" | "blocked";

/** billing_status alvo pela idade do atraso. null = não vencida (nada a fazer). */
export function decideDelinquencyStatus(
  dueDate: string,
  today: string,
): DelinquencyStatus | null {
  const overdue = daysOverdue(dueDate, today);
  if (overdue < 1) return null;
  return overdue >= BLOCK_AFTER_DAYS ? "blocked" : "grace_period";
}

/** Puro: preferência billing_email -> owner -> null. */
export function pickRecipient(
  billingEmail?: string | null,
  ownerEmail?: string | null,
): string | null {
  const be = (billingEmail ?? "").trim();
  if (be) return be;
  const oe = (ownerEmail ?? "").trim();
  if (oe) return oe;
  return null;
}

export type ReminderOffset = { days: number; type: string };

/** Offsets de lembrete relativos ao due_date. D0 = "vence hoje"; D+1/3/5 = atraso. */
export const REMINDER_OFFSETS: ReminderOffset[] = [
  { days: 0, type: "payment_pending" },
  { days: 1, type: "overdue_d1" },
  { days: 3, type: "overdue_d3" },
  { days: 5, type: "overdue_d5" },
];
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- billing-delinquency-core`
Expected: PASS (todos os `describe` verdes).

- [ ] **Step 5: Verificar Deno e typecheck**

Run: `npx deno@2.1.4 check supabase/functions/_shared/billing-delinquency-core.ts`
Expected: sem erros.
Run: `npm run typecheck`
Expected: 0 erros.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/billing-delinquency-core.ts src/lib/billing-delinquency-core.test.ts
git commit -m "feat(billing): nucleo puro de inadimplencia (datas BRT + maquina de estados)"
```

---

## Task 2: Migration 068 — ciclo em billing_notifications + restored_at

**Files:**
- Create: `supabase/migrations/20260719150000_068_billing_notifications_cycle.sql`

> Se já existir migration com timestamp ≥ `20260719150000`, use um timestamp estritamente maior que a última (mantendo o número `068`). A última hoje é `20260719130000_067`.

**Interfaces:**
- Consumes: tabela `billing_notifications` (existe: `20260528000000_billing_module.sql:311`), `organizations`.
- Produces: coluna `billing_notifications.invoice_id`, UNIQUE `(organization_id, event_type, invoice_id)`, índice parcial de `status='pending'`, coluna `organizations.restored_at`.

- [ ] **Step 1: Escrever a migration**

Create `supabase/migrations/20260719150000_068_billing_notifications_cycle.sql`:

```sql
-- Fase 4b: correlação de ciclo em billing_notifications (dedupe por invoice) +
-- restored_at em organizations (carimbo da regularização). Aditiva, idempotente.

begin;

-- Handle de ciclo: uma nova mensalidade nasce numa nova billing_invoice, então o
-- mesmo event_type volta a disparar no ciclo seguinte, mas 1x por ciclo.
alter table billing_notifications
  add column if not exists invoice_id uuid references billing_invoices(id) on delete set null;

-- Dedupe DB-enforced. Parcial: linhas antigas (invoice_id null) não conflitam.
create unique index if not exists billing_notifications_org_type_invoice_uidx
  on billing_notifications (organization_id, event_type, invoice_id)
  where invoice_id is not null;

-- O dispatcher varre só as pendentes.
create index if not exists billing_notifications_pending_idx
  on billing_notifications (status)
  where status = 'pending';

-- Carimbo da regularização (não existia; blocked_at/blocked_reason já existem).
alter table organizations
  add column if not exists restored_at timestamptz;

commit;
```

- [ ] **Step 2: Validar sem drift e aplicar**

Run: `supabase db push --dry-run`
Expected: lista só a `068...` como pendente, sem erro de drift.
Run: `supabase db push`
Expected: aplicada com sucesso.

- [ ] **Step 3: Query de validação pós-migration**

Run (Studio→SQL apenas para LER, ou psql):
```sql
select column_name from information_schema.columns
  where table_name='billing_notifications' and column_name='invoice_id';        -- 1 linha
select indexname from pg_indexes
  where tablename='billing_notifications'
  and indexname in ('billing_notifications_org_type_invoice_uidx','billing_notifications_pending_idx'); -- 2 linhas
select column_name from information_schema.columns
  where table_name='organizations' and column_name='restored_at';               -- 1 linha
```
Expected: as 3 confirmações acima.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260719150000_068_billing_notifications_cycle.sql
git commit -m "feat(billing): migration 068 - ciclo em billing_notifications + restored_at"
```

---

## Task 3: Helper compartilhado — destinatário (fix do vazamento) + enqueue + override

**Files:**
- Create: `supabase/functions/_shared/billing-notify.ts`
- Test: adicionar casos em `src/lib/billing-delinquency-core.test.ts` NÃO é necessário (a parte pura `pickRecipient` já é testada na Task 1; o resto é I/O validado em sandbox).

**Interfaces:**
- Consumes: `pickRecipient` de `./billing-delinquency-core.ts`; `jsonLog` de `./security.ts`; tabelas `organizations`, `units`, `unit_members`, `billing_notifications`, `organization_entitlement_overrides`.
- Produces:
  - `resolveBillingRecipient(supabase: SupabaseClient, orgId: string): Promise<string | null>`
  - `enqueueBillingNotification(supabase: SupabaseClient, n: { organizationId: string; eventType: string; invoiceId: string | null; recipient: string }): Promise<void>`
  - `hasActiveSystemOverride(supabase: SupabaseClient, orgId: string): Promise<boolean>`

- [ ] **Step 1: Implementar o helper**

Create `supabase/functions/_shared/billing-notify.ts`:

```ts
// Enfileira billing_notifications (status 'pending') para o dispatcher
// (process-billing-notifications). resolveBillingRecipient escopa o fallback de
// owner por ORG — fecha o vazamento cross-tenant que existia em
// process-billing-reminders (pegava o owner mais antigo da PLATAFORMA).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { pickRecipient } from "./billing-delinquency-core.ts";

/** billing_email da org, ou o owner DA PRÓPRIA ORG, ou null. */
export async function resolveBillingRecipient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | null> {
  const { data: org } = await supabase
    .from("organizations")
    .select("billing_email")
    .eq("id", orgId)
    .maybeSingle();

  let ownerEmail: string | null = null;
  if (!org?.billing_email) {
    // Escopar por org em dois passos (sem depender de filtro em recurso embutido):
    // units da org -> owners dessas units. Sem isso pegaria o owner mais antigo
    // da plataforma inteira (vazamento cross-tenant).
    const { data: units } = await supabase
      .from("units")
      .select("id")
      .eq("organization_id", orgId);
    const unitIds = (units ?? []).map((u) => u.id as string);
    if (unitIds.length > 0) {
      const { data: owner } = await supabase
        .from("unit_members")
        .select("email")
        .in("unit_id", unitIds)
        .eq("role", "owner")
        .order("created_at")
        .limit(1)
        .maybeSingle();
      ownerEmail = (owner?.email as string | undefined) ?? null;
    }
  }
  return pickRecipient(org?.billing_email as string | null | undefined, ownerEmail);
}

/**
 * INSERT ... ON CONFLICT DO NOTHING via tratamento de 23505 (padrão voucher do
 * CLAUDE.md). O UNIQUE (organization_id, event_type, invoice_id) garante 1 aviso
 * por ciclo. Best-effort: nunca lança.
 */
export async function enqueueBillingNotification(
  supabase: SupabaseClient,
  n: { organizationId: string; eventType: string; invoiceId: string | null; recipient: string },
): Promise<void> {
  const { error } = await supabase.from("billing_notifications").insert({
    organization_id: n.organizationId,
    event_type: n.eventType,
    invoice_id: n.invoiceId,
    channel: "email",
    recipient: n.recipient,
    status: "pending",
  });
  if (error && error.code === "23505") {
    jsonLog("info", {
      evt: "billing_notification_dedup",
      event_type: n.eventType,
      org: n.organizationId,
    });
  } else if (error) {
    jsonLog("error", {
      evt: "billing_notification_enqueue_failed",
      event_type: n.eventType,
      org: n.organizationId,
      err: error.message,
    });
  }
}

/**
 * true se a org tem cortesia/override de sistema ATIVO (não pode ser bloqueada
 * nem avisada por inadimplência). enabled=true = grant positivo; enabled=false é
 * bloqueio explícito e não impede escalação (a org já deve estar sem acesso).
 */
export async function hasActiveSystemOverride(
  supabase: SupabaseClient,
  orgId: string,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from("organization_entitlement_overrides")
    .select("id")
    .eq("organization_id", orgId)
    .eq("feature", "system")
    .eq("enabled", true)
    .is("revoked_at", null)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .limit(1);
  return (data ?? []).length > 0;
}
```

- [ ] **Step 2: Verificar Deno**

Run: `npx deno@2.1.4 check supabase/functions/_shared/billing-notify.ts`
Expected: sem erros.

- [ ] **Step 3: Confirmar que os testes puros seguem verdes**

Run: `npm test -- billing-delinquency-core`
Expected: PASS (nada quebrou; `pickRecipient` é a única parte pura, já coberta).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/billing-notify.ts
git commit -m "feat(billing): helper de notificacao (destinatario org-scoped + enqueue + override)"
```

---

## Task 4: Adaptar process-billing-overdue (grace 5 / block 6 + override + suspended)

**Files:**
- Modify: `supabase/functions/process-billing-overdue/index.ts` (reescrita completa do corpo)

**Interfaces:**
- Consumes: `todayBrt`, `decideDelinquencyStatus` de `../_shared/billing-delinquency-core.ts`; `resolveBillingRecipient`, `enqueueBillingNotification`, `hasActiveSystemOverride` de `../_shared/billing-notify.ts`.
- Produces: worker que transiciona `billing_status` para `grace_period`/`blocked` e enfileira `suspended` na entrada em `blocked`.

- [ ] **Step 1: Reescrever o worker**

Replace o conteúdo inteiro de `supabase/functions/process-billing-overdue/index.ts`:

```ts
// Worker: verifica invoices vencidas e atualiza billing_status das orgs.
// Roda diariamente via pg_cron.
// Política (Fase 4b): vencido D+1..D+5 -> grace_period. D+6+ -> blocked.
// Respeita override vitalício (system) e grant_access legado. Datas em BRT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { todayBrt, decideDelinquencyStatus } from "../_shared/billing-delinquency-core.ts";
import {
  resolveBillingRecipient,
  enqueueBillingNotification,
  hasActiveSystemOverride,
} from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_overdue_start" });

  try {
    const today = todayBrt();

    const { data: overdueInvoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date")
      .eq("status", "open")
      .lt("due_date", today);

    // Menor (mais antiga) invoice vencida por org.
    const oldestByOrg = new Map<string, { id: string; due_date: string }>();
    for (const inv of overdueInvoices ?? []) {
      if (!inv.due_date) continue;
      const cur = oldestByOrg.get(inv.organization_id);
      if (!cur || inv.due_date < cur.due_date) {
        oldestByOrg.set(inv.organization_id, { id: inv.id, due_date: inv.due_date });
      }
    }

    let updated = 0;
    for (const [orgId, inv] of oldestByOrg) {
      // Override legado grant_access.
      const { data: legacyOverride } = await supabase
        .from("billing_access_overrides")
        .select("id")
        .eq("organization_id", orgId)
        .eq("override_type", "grant_access")
        .eq("active", true)
        .maybeSingle();
      if (legacyOverride) continue;

      // Override vitalício novo (system) — nunca bloquear cliente cortesia.
      if (await hasActiveSystemOverride(supabase, orgId)) continue;

      const target = decideDelinquencyStatus(inv.due_date, today);
      if (!target) continue;

      const { data: org } = await supabase
        .from("organizations")
        .select("billing_status")
        .eq("id", orgId)
        .single();

      if (
        !org ||
        org.billing_status === target ||
        org.billing_status === "manual_override" ||
        org.billing_status === "canceled"
      ) {
        continue;
      }

      const updateFields: Record<string, unknown> = { billing_status: target };
      if (target === "blocked") {
        updateFields.blocked_at = new Date().toISOString();
        updateFields.blocked_reason = "Bloqueio automático por inadimplência.";
      }

      await supabase.from("organizations").update(updateFields).eq("id", orgId);
      updated++;
      jsonLog("info", { reqId, evt: "billing_overdue_updated", orgId, from: org.billing_status, to: target });

      // Aviso de suspensão só na TRANSIÇÃO para blocked (o guard acima garante
      // que não estávamos em blocked). UNIQUE por invoice é o backstop.
      if (target === "blocked") {
        const recipient = await resolveBillingRecipient(supabase, orgId);
        if (recipient) {
          await enqueueBillingNotification(supabase, {
            organizationId: orgId,
            eventType: "suspended",
            invoiceId: inv.id,
            recipient,
          });
        }
      }
    }

    jsonLog("info", { reqId, evt: "billing_overdue_done", checked: oldestByOrg.size, updated });
    return new Response(JSON.stringify({ success: true, checked: oldestByOrg.size, updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_overdue_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
```

- [ ] **Step 2: Verificar Deno e typecheck**

Run: `npx deno@2.1.4 check supabase/functions/process-billing-overdue/index.ts`
Expected: sem erros.
Run: `npm run typecheck`
Expected: 0 erros.

> Este é um task de wiring: a lógica de decisão (`decideDelinquencyStatus`, BRT) já tem teste unitário na Task 1; a integração é validada em sandbox na Task 8. O repo não tem runner Deno para teste de I/O de worker.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/process-billing-overdue/index.ts
git commit -m "feat(billing): overdue grace 5/block D+6 + skip override vitalicio + aviso suspended"
```

---

## Task 5: Adaptar process-billing-reminders (cadência D+1/3/5 + FIX do vazamento)

**Files:**
- Modify: `supabase/functions/process-billing-reminders/index.ts` (reescrita completa do corpo)

**Interfaces:**
- Consumes: `todayBrt`, `addDaysToDate`, `REMINDER_OFFSETS` de `../_shared/billing-delinquency-core.ts`; `resolveBillingRecipient`, `enqueueBillingNotification`, `hasActiveSystemOverride` de `../_shared/billing-notify.ts`.
- Produces: worker que enfileira `payment_pending`/`overdue_d1`/`overdue_d3`/`overdue_d5` sem vazar destinatário cross-tenant.

- [ ] **Step 1: Reescrever o worker**

Replace o conteúdo inteiro de `supabase/functions/process-billing-reminders/index.ts`:

```ts
// Worker: enfileira lembretes de billing (o envio real é do
// process-billing-notifications). Roda diariamente via pg_cron.
// Cadência (Fase 4b): D0 (vence hoje), D+1, D+3, D+5 relativos ao due_date.
// Datas em BRT. Destinatário escopado por org (sem vazamento cross-tenant).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { todayBrt, addDaysToDate, REMINDER_OFFSETS } from "../_shared/billing-delinquency-core.ts";
import {
  resolveBillingRecipient,
  enqueueBillingNotification,
  hasActiveSystemOverride,
} from "../_shared/billing-notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_reminders_start" });

  try {
    const today = todayBrt();

    const { data: invoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date")
      .eq("status", "open")
      .not("due_date", "is", null);

    let queued = 0;
    for (const inv of invoices ?? []) {
      if (!inv.due_date) continue;

      // Qual offset cai hoje? (no máximo um por invoice por dia)
      const match = REMINDER_OFFSETS.find((o) => addDaysToDate(inv.due_date, o.days) === today);
      if (!match) continue;

      // Nunca avisar cliente com cortesia vitalícia (system).
      if (await hasActiveSystemOverride(supabase, inv.organization_id)) continue;

      const recipient = await resolveBillingRecipient(supabase, inv.organization_id);
      if (!recipient) continue;

      await enqueueBillingNotification(supabase, {
        organizationId: inv.organization_id,
        eventType: match.type,
        invoiceId: inv.id,
        recipient,
      });
      queued++;
      jsonLog("info", { reqId, evt: "billing_reminder_queued", orgId: inv.organization_id, type: match.type });
    }

    jsonLog("info", { reqId, evt: "billing_reminders_done", queued });
    return new Response(JSON.stringify({ success: true, queued }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_reminders_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
```

- [ ] **Step 2: Confirmar que o vazamento sumiu (revisão do diff)**

Run: `git diff supabase/functions/process-billing-reminders/index.ts`
Expected: o bloco antigo (linhas 76-85) que buscava `unit_members` por `role='owner'` **sem filtro de org** não existe mais; a resolução de destinatário agora é 100% via `resolveBillingRecipient` (que escopa por org).

- [ ] **Step 3: Verificar Deno e typecheck**

Run: `npx deno@2.1.4 check supabase/functions/process-billing-reminders/index.ts`
Expected: sem erros.
Run: `npm run typecheck`
Expected: 0 erros.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/process-billing-reminders/index.ts
git commit -m "fix(billing): reminders cadencia D+1/3/5 + corrige vazamento cross-tenant do destinatario"
```

---

## Task 6: Worker novo process-billing-notifications + templates + config.toml + cron

**Files:**
- Create: `supabase/functions/process-billing-notifications/index.ts`
- Modify: `supabase/config.toml`
- Create: `supabase/migrations/20260719151000_069_process_billing_notifications_cron.sql`

**Interfaces:**
- Consumes: `requireInternalAuth`, `genRequestId`, `jsonLog` de `../_shared/security.ts`; `isFlagEnabled` de `../_shared/platform-flags.ts`; `sendEmail` de `../_shared/email.ts`; tabelas `billing_notifications`, `billing_invoices`, `organizations`.
- Produces: EF `process-billing-notifications` que consome a fila `pending` e envia e-mail.

- [ ] **Step 1: Criar o worker dispatcher**

Create `supabase/functions/process-billing-notifications/index.ts`:

```ts
// Worker: envia as notificações de billing pendentes (Resend). Roda a cada 5min
// via pg_cron. Gated pela flag billing_notifications_dispatch (OFF = a fila
// acumula sem enviar). Nunca usa canal WhatsApp da org.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { isFlagEnabled } from "../_shared/platform-flags.ts";
import { sendEmail } from "../_shared/email.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BATCH = 20;

type TemplateData = {
  orgName: string;
  amountBrl: string;
  paymentUrl: string | null;
};

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function wrapHtml(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222"><h2>${title}</h2>${body}</div>`;
}

function payLine(url: string | null): string {
  return url ? `Para pagar, acesse: ${url}` : "Acesse o painel para regularizar.";
}

const TEMPLATE_BY_EVENT: Record<
  string,
  (d: TemplateData) => { subject: string; text: string; html: string }
> = {
  payment_pending: (d) => ({
    subject: "Sua mensalidade vence hoje",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} vence hoje. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Sua mensalidade vence hoje", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> vence hoje.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d1: (d) => ({
    subject: "Pagamento em atraso",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso (1 dia). ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Pagamento em atraso", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 1 dia.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d3: (d) => ({
    subject: "Pagamento em atraso (3 dias)",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso há 3 dias. O acesso será suspenso se não for regularizado. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Pagamento em atraso (3 dias)", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 3 dias.`,
      `O acesso será suspenso se não for regularizado.`,
      payLine(d.paymentUrl),
    ]),
  }),
  overdue_d5: (d) => ({
    subject: "Último aviso antes da suspensão",
    text: `Olá, ${d.orgName}. Sua mensalidade de ${d.amountBrl} está em atraso há 5 dias. Sem o pagamento, o acesso será suspenso amanhã. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Último aviso antes da suspensão", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Sua mensalidade de <strong>${d.amountBrl}</strong> está em atraso há 5 dias.`,
      `Sem o pagamento, o acesso será <strong>suspenso amanhã</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  suspended: (d) => ({
    subject: "Acesso suspenso por falta de pagamento",
    text: `Olá, ${d.orgName}. O acesso ao sistema foi suspenso por falta de pagamento da mensalidade de ${d.amountBrl}. ${payLine(d.paymentUrl)}`,
    html: wrapHtml("Acesso suspenso", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `O acesso ao sistema foi <strong>suspenso</strong> por falta de pagamento da mensalidade de <strong>${d.amountBrl}</strong>.`,
      payLine(d.paymentUrl),
    ]),
  }),
  regularized: (d) => ({
    subject: "Pagamento confirmado — acesso liberado",
    text: `Olá, ${d.orgName}. Recebemos o pagamento da sua mensalidade e o acesso foi liberado. Obrigado!`,
    html: wrapHtml("Acesso liberado", [
      `Olá, <strong>${d.orgName}</strong>.`,
      `Recebemos o pagamento da sua mensalidade e o acesso foi <strong>liberado</strong>.`,
      `Obrigado!`,
    ]),
  }),
};

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();

  // Gate: OFF = não envia; a fila acumula em 'pending' (seguro).
  if (!(await isFlagEnabled("billing_notifications_dispatch"))) {
    jsonLog("info", { reqId, evt: "billing_notifications_flag_off" });
    return new Response(JSON.stringify({ success: true, skipped: "flag_off" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  jsonLog("info", { reqId, evt: "billing_notifications_start" });

  try {
    const { data: pending } = await supabase
      .from("billing_notifications")
      .select("id, organization_id, event_type, recipient, invoice_id")
      .eq("status", "pending")
      .order("sent_at", { ascending: true })
      .limit(BATCH);

    let sent = 0;
    let failed = 0;

    for (const row of pending ?? []) {
      const tmpl = TEMPLATE_BY_EVENT[row.event_type];
      if (!tmpl) {
        // Tipo desconhecido — marca failed pra não repetir eternamente.
        await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: "unknown_event_type" })
          .eq("id", row.id);
        failed++;
        continue;
      }

      let amountCents = 0;
      let paymentUrl: string | null = null;
      if (row.invoice_id) {
        const { data: inv } = await supabase
          .from("billing_invoices")
          .select("amount_cents, hosted_invoice_url")
          .eq("id", row.invoice_id)
          .maybeSingle();
        amountCents = (inv?.amount_cents as number | undefined) ?? 0;
        paymentUrl = (inv?.hosted_invoice_url as string | null | undefined) ?? null;
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", row.organization_id)
        .maybeSingle();

      const body = tmpl({
        orgName: (org?.name as string | undefined) ?? "cliente",
        amountBrl: formatBrl(amountCents),
        paymentUrl,
      });

      const result = await sendEmail({
        to: row.recipient,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });

      if (result.ok) {
        await supabase
          .from("billing_notifications")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        sent++;
      } else if (result.skipped && (result.reason === "no_api_key" || result.reason === "no_from")) {
        // Config ausente — não é culpa da linha. Deixa 'pending' e para o lote.
        jsonLog("warn", { reqId, evt: "billing_notifications_no_config", reason: result.reason });
        break;
      } else {
        const err = result.skipped ? result.reason : result.error;
        await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: err })
          .eq("id", row.id);
        failed++;
      }
    }

    jsonLog("info", { reqId, evt: "billing_notifications_done", sent, failed });
    return new Response(JSON.stringify({ success: true, sent, failed }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_notifications_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});
```

- [ ] **Step 2: Adicionar a entrada no config.toml**

Adicione ao final de `supabase/config.toml` (mesmo padrão dos outros `process-*`):

```toml
[functions.process-billing-notifications]
verify_jwt = false
```

- [ ] **Step 3: Criar a migration do cron**

Create `supabase/migrations/20260719151000_069_process_billing_notifications_cron.sql`:

```sql
-- Worker pg_cron: process-billing-notifications (Fase 4b).
-- Mesmo padrão de 20260716140000_064_process_asaas_reconcile_cron.sql:
-- pg_cron -> wrapper SECURITY DEFINER -> pg_net.http_post com internal_api_key
-- do Vault -> Edge Function. A EF é no-op se a flag billing_notifications_dispatch
-- estiver OFF, então agendar antes do go-live é inofensivo.
-- Schedule: */5 (junto com billing-unblock — jobs de minuto não colidem).

create extension if not exists pg_cron;

create or replace function trigger_billing_notifications()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets
  where name = 'internal_api_key'
  limit 1;

  if api_key is null or api_key = '' then
    raise notice '[billing-notifications] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

do $$
begin
  perform cron.unschedule('billing-notifications');
exception when others then null;
end $$;

select cron.schedule(
  'billing-notifications',
  '*/5 * * * *',
  'select trigger_billing_notifications();'
);
```

- [ ] **Step 4: Verificar Deno e aplicar a migration**

Run: `npx deno@2.1.4 check supabase/functions/process-billing-notifications/index.ts`
Expected: sem erros.
Run: `supabase db push --dry-run` depois `supabase db push`
Expected: aplica a `069...` sem drift.
Run (validação): `select jobname from cron.job where jobname='billing-notifications';`
Expected: 1 linha.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-billing-notifications/index.ts supabase/config.toml supabase/migrations/20260719151000_069_process_billing_notifications_cron.sql
git commit -m "feat(billing): dispatcher process-billing-notifications (Resend) + cron + templates"
```

---

## Task 7: Regularização no aplicador (restored_at + aviso regularized)

**Files:**
- Modify: `supabase/functions/_shared/asaas-billing-events-apply.ts` (imports no topo + bloco `activate_subscription` em ~656-659)

**Interfaces:**
- Consumes: `resolveBillingRecipient`, `enqueueBillingNotification` de `./billing-notify.ts`; variáveis já em escopo no bloco: `supabase`, `organizationId`, `invoice`.
- Produces: quando o pagamento tira a org de um estado de atraso, carimba `restored_at` e enfileira `regularized`.

- [ ] **Step 1: Adicionar os imports**

No topo de `supabase/functions/_shared/asaas-billing-events-apply.ts`, junto aos imports existentes, adicione:

```ts
import { resolveBillingRecipient, enqueueBillingNotification } from "./billing-notify.ts";
```

- [ ] **Step 2: Trocar o update de organizations no case activate_subscription**

Localize (≈ linhas 653-668):

```ts
        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side. É o último passo de propósito:
        // só liberamos acesso depois que assinatura e fatura ficaram duráveis.
        const { error: orgErr } = await supabase
          .from("organizations")
          .update({ billing_status: "active", blocked_at: null, blocked_reason: null })
          .eq("id", organizationId);
        if (orgErr) {
          return failWith(
            organizationId,
            effect.kind,
            "update_organization_active",
            orgErr,
            "Falha ao liberar o acesso da organização — ver logs.",
          );
        }
        break;
```

Substitua por:

```ts
        // Espelha em organizations, que é a coluna autoritativa do
        // BillingGuard e dos guards server-side. É o último passo de propósito:
        // só liberamos acesso depois que assinatura e fatura ficaram duráveis.
        //
        // Regularização (Fase 4b): se a org estava em atraso, carimba restored_at
        // e enfileira o aviso "regularized". Ler o status ANTES do update.
        const { data: prevOrg } = await supabase
          .from("organizations")
          .select("billing_status")
          .eq("id", organizationId)
          .maybeSingle();
        const wasDelinquent =
          prevOrg?.billing_status === "grace_period" ||
          prevOrg?.billing_status === "blocked" ||
          prevOrg?.billing_status === "past_due";

        const orgUpdate: Record<string, unknown> = {
          billing_status: "active",
          blocked_at: null,
          blocked_reason: null,
        };
        if (wasDelinquent) orgUpdate.restored_at = new Date().toISOString();

        const { error: orgErr } = await supabase
          .from("organizations")
          .update(orgUpdate)
          .eq("id", organizationId);
        if (orgErr) {
          return failWith(
            organizationId,
            effect.kind,
            "update_organization_active",
            orgErr,
            "Falha ao liberar o acesso da organização — ver logs.",
          );
        }

        if (wasDelinquent) {
          const recipient = await resolveBillingRecipient(supabase, organizationId);
          if (recipient) {
            await enqueueBillingNotification(supabase, {
              organizationId,
              eventType: "regularized",
              invoiceId: invoice?.id ?? null,
              recipient,
            });
          }
        }
        break;
```

- [ ] **Step 3: Verificar Deno**

Run: `npx deno@2.1.4 check supabase/functions/_shared/asaas-billing-events-apply.ts`
Expected: sem erros (imports resolvem; `invoice`/`organizationId` já em escopo).

- [ ] **Step 4: Confirmar que os testes existentes seguem verdes**

Run: `npm test`
Expected: PASS (nenhum teste do aplicador quebrou; a mudança é aditiva no caminho de ativação).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/asaas-billing-events-apply.ts
git commit -m "feat(billing): regularizacao - restored_at + aviso regularized ao voltar pra active"
```

---

## Task 8: Deploy sandbox + validação ao vivo + docs + checklist

> Deploy é do usuário (sandbox; go-live de produção fica na última fase — ver
> `docs/billing-asaas/FASE-4A-RESUMO.md`). A flag `billing_notifications_dispatch`
> fica **OFF** até a validação passar. Resend NÃO é sandbox: usar caixa de teste real.

**Files:**
- Create: `docs/billing-asaas/FASE-4B-RESUMO.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Redeploy das Edge Functions afetadas**

Mudou `_shared/billing-delinquency-core.ts` e `_shared/billing-notify.ts` (novos) e `_shared/asaas-billing-events-apply.ts`. Deploy:

```bash
supabase functions deploy process-billing-overdue
supabase functions deploy process-billing-reminders
supabase functions deploy process-billing-notifications
supabase functions deploy asaas-webhook
supabase functions deploy process-asaas-reconcile
supabase functions deploy manage-billing
```
Expected: 6 deploys OK. (As migrations 068/069 já foram aplicadas nas Tasks 2 e 6.)

- [ ] **Step 2: Validação ao vivo em sandbox (org "Seu Japa Teste")**

1. Setar em `billing_customers`/`organizations` da org de teste um `billing_email` = uma **caixa de teste real** que você controla.
2. Inserir/ajustar uma `billing_invoice` (`status='open'`, `provider='asaas'`) da org com `due_date` manipulável.
3. Exercitar (invocando os workers via `x-internal-key` ou aguardando o cron):
   - `due_date = today-1` → `process-billing-overdue` deixa `grace_period`; `process-billing-reminders` (com `due_date = today-1`) enfileira `overdue_d1`.
   - `due_date = today-5` → `overdue_d5` enfileirado.
   - `due_date = today-6` → org vira `blocked` + `suspended` enfileirado.
   - Ligar `billing_notifications_dispatch=true` → `process-billing-notifications` envia (conferir a caixa de teste) e marca `sent`.
   - Simular `PAYMENT_RECEIVED` da invoice → org volta `active` + `restored_at` + `regularized` enfileirado/enviado.
4. **Confirmar o fix do vazamento:** numa org com `billing_email` nulo, o destinatário resolvido é o owner **daquela** org (não o owner mais antigo de outra).
5. **Confirmar o skip de override:** Ren Sushi (LIFETIME system) com uma invoice forçada vencida → NÃO é bloqueada nem recebe aviso.

Registrar no resumo o que passou. Desligar `billing_notifications_dispatch` de volta se ainda não for pra deixar ligado.

- [ ] **Step 3: Escrever o resumo da fase**

Create `docs/billing-asaas/FASE-4B-RESUMO.md` com: escopo entregue, decisões, arquivos alterados, riscos residuais (renovação mês 2+, reconcile-completion, enforcement de entitlements, UI in-app), rollback (`billing_notifications_dispatch` OFF + revert dos workers), e "próxima fase" (Fase 5 — implementação WhatsApp + suspensão por-serviço).

- [ ] **Step 4: Atualizar o CLAUDE.md**

Fazer, em `CLAUDE.md`:
1. **Tabela de workers automáticos:** adicionar linha `process-billing-notifications | */5 * * * * | Dispatcher de avisos de billing (Resend, flag billing_notifications_dispatch)`; atualizar as linhas de `process-billing-overdue` (grace 5d / bloqueio D+6) e `process-billing-reminders` (D+1/D+3/D+5).
2. **Checklist de redeploy** (seção Deploy → Edge Functions): adicionar
   - `billing-delinquency-core.ts` → `process-billing-overdue`, `process-billing-reminders`
   - `billing-notify.ts` → `process-billing-overdue`, `process-billing-reminders`, `process-billing-notifications`, `asaas-webhook`, `process-asaas-reconcile`, `manage-billing`
   - anexar `process-billing-notifications` como consumidor de `platform-flags.ts` e `email.ts`.
3. **Invariante novo** (seção Billing) em 1 frase + porquê + ponteiro:
   - "Avisos de billing são enfileirados em `billing_notifications` (pending) com dedupe UNIQUE `(organization_id, event_type, invoice_id)` e enviados só pelo `process-billing-notifications` (flag `billing_notifications_dispatch`); produtor novo insere tratando `23505` como no-op e resolve destinatário via `resolveBillingRecipient` (escopado por org — nunca query de owner sem filtro). [billing-notify.ts](../../../supabase/functions/_shared/billing-notify.ts)."

- [ ] **Step 5: Scan de segurança e commit dos docs**

```bash
git status
git diff --cached
git add docs/billing-asaas/FASE-4B-RESUMO.md CLAUDE.md
git commit -m "docs(billing): resumo da Fase 4b + invariantes + checklist de redeploy"
```
Expected: `git diff --cached` sem nenhum padrão de secret.

---

## Self-Review (executado ao escrever o plano)

**1. Spec coverage:**
- Máquina de estados (grace 5/block 6, blocked reuse) → Task 1 (decide) + Task 4 (overdue). ✅
- Migration (invoice_id + UNIQUE + restored_at) → Task 2. ✅
- Overdue adaptado + skip LIFETIME + BRT + suspended → Task 4. ✅
- Reminders cadência D+1/3/5 + **fix do blocker** + dedupe on-conflict + BRT → Task 3 (helper) + Task 5. ✅
- Dispatcher novo + flag + Resend + 6 templates + config.toml + cron → Task 6. ✅
- Regularização (restored_at + regularized) → Task 7. ✅
- Testes unit (state machine, BRT, pickRecipient) → Task 1; sandbox → Task 8. ✅
- Flags/rollback/redeploy/docs → Task 8. ✅
- **Não-escopo** (enforcement, reconcile-completion, renovação, trial) → registrado como riscos residuais, sem task. ✅

**2. Placeholder scan:** sem TBD/TODO; todo passo de código traz o código completo. ✅

**3. Type consistency:** `decideDelinquencyStatus`, `todayBrt`, `addDaysToDate`, `pickRecipient`, `REMINDER_OFFSETS` definidos na Task 1 e consumidos com a mesma assinatura nas Tasks 4/5; `resolveBillingRecipient`/`enqueueBillingNotification`/`hasActiveSystemOverride` definidos na Task 3 e consumidos idênticos nas Tasks 4/5/7; `sendEmail`/`isFlagEnabled` usados conforme as assinaturas reais lidas do código. ✅

**Nota de teste (honestidade):** Tasks 4/5/6/7 são wiring de worker/aplicador — o repo não tem runner Deno, então a verificação é `deno check` + `typecheck` + testes puros verdes (Task 1) + validação em sandbox (Task 8). A lógica de decisão que importa está toda no núcleo puro testado.

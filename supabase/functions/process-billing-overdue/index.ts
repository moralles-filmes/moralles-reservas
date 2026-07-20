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

      const { error: updErr } = await supabase.from("organizations").update(updateFields).eq("id", orgId);
      if (updErr) {
        jsonLog("error", { reqId, evt: "billing_overdue_update_failed", orgId, to: target, err: updErr.message });
        continue;
      }
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

// Worker: verifica invoices vencidas e atualiza billing_status das orgs.
// Roda diariamente via pg_cron.
// Política: vencido → past_due. +7 dias → grace_period. +8 dias (total) → blocked.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GRACE_PERIOD_DAYS = 7;
const BLOCK_AFTER_DAYS = 8;

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_overdue_start" });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const graceDate = new Date(Date.now() - GRACE_PERIOD_DAYS * 86400000).toISOString().slice(0, 10);
    const blockDate = new Date(Date.now() - BLOCK_AFTER_DAYS * 86400000).toISOString().slice(0, 10);

    // Invoices vencidas que ainda estão open
    const { data: overdueInvoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date")
      .eq("status", "open")
      .lt("due_date", today);

    const orgIds = new Set<string>();
    for (const inv of overdueInvoices ?? []) {
      orgIds.add(inv.organization_id);
    }

    let updated = 0;
    for (const orgId of orgIds) {
      // Verificar se tem override ativo de grant_access
      const { data: override } = await supabase
        .from("billing_access_overrides")
        .select("id")
        .eq("organization_id", orgId)
        .eq("override_type", "grant_access")
        .eq("active", true)
        .maybeSingle();

      if (override) continue;

      // Pegar a invoice mais antiga vencida
      const oldestInvoice = (overdueInvoices ?? [])
        .filter((i) => i.organization_id === orgId)
        .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))[0];

      if (!oldestInvoice?.due_date) continue;

      const dueDate = oldestInvoice.due_date;
      let newStatus: string;

      if (dueDate <= blockDate) {
        newStatus = "blocked";
      } else if (dueDate <= graceDate) {
        newStatus = "grace_period";
      } else {
        newStatus = "past_due";
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("billing_status")
        .eq("id", orgId)
        .single();

      if (!org || org.billing_status === newStatus || org.billing_status === "manual_override") continue;

      const updateFields: Record<string, unknown> = { billing_status: newStatus };
      if (newStatus === "blocked") {
        updateFields.blocked_at = new Date().toISOString();
        updateFields.blocked_reason = "Bloqueio automático por inadimplência.";
      }

      await supabase.from("organizations").update(updateFields).eq("id", orgId);
      updated++;

      jsonLog("info", { reqId, evt: "billing_overdue_updated", orgId, from: org.billing_status, to: newStatus });
    }

    jsonLog("info", { reqId, evt: "billing_overdue_done", checked: orgIds.size, updated });
    return new Response(JSON.stringify({ success: true, checked: orgIds.size, updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_overdue_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});

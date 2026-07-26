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
import { isSystemInvoice } from "../_shared/billing-category.ts";

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
      .select("id, organization_id, due_date, billing_subscription_id, external_reference, purpose")
      .eq("status", "open")
      .not("due_date", "is", null);

    let queued = 0;
    for (const inv of invoices ?? []) {
      if (!inv.due_date) continue;

      // Qual offset cai hoje? (no máximo um por invoice por dia)
      const match = REMINDER_OFFSETS.find((o) => addDaysToDate(inv.due_date, o.days) === today);
      if (!match) continue;

      // Os templates de lembrete dizem "o acesso será suspenso". Mandar isso por
      // uma fatura de instância seria mentira: ela não suspende nada na 5a.
      if (!(await isSystemInvoice(supabase, inv))) continue;

      // Nunca avisar cliente com cortesia vitalícia (system).
      if (await hasActiveSystemOverride(supabase, inv.organization_id)) continue;

      // Coerência com process-billing-overdue: não avisar org com override
      // legado grant_access, nem org manual_override/canceled (o overdue as pula).
      const { data: legacyOverride } = await supabase
        .from("billing_access_overrides")
        .select("id")
        .eq("organization_id", inv.organization_id)
        .eq("override_type", "grant_access")
        .eq("active", true)
        .maybeSingle();
      if (legacyOverride) continue;

      const { data: orgRow } = await supabase
        .from("organizations")
        .select("billing_status")
        .eq("id", inv.organization_id)
        .maybeSingle();
      if (orgRow?.billing_status === "manual_override" || orgRow?.billing_status === "canceled") continue;

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

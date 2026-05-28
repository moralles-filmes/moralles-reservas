// Worker: envia lembretes de billing por e-mail.
// Roda diariamente via pg_cron.
// Lembretes: 3 dias antes, no dia, 2 dias após, 5 dias após, no bloqueio.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function addDays(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Cadência alinhada à política de grace=3 dias / bloqueio em D+4 em
// process-billing-overdue. Lembretes em D+5 ou D+8 não fariam sentido
// porque a org já está blocked nesse momento.
const REMINDER_OFFSETS = [
  { days: -3, type: "reminder_3d_before" },
  { days: 0, type: "reminder_due_today" },
  { days: 1, type: "reminder_1d_after" },
  { days: 3, type: "reminder_3d_after" },
  { days: 4, type: "reminder_blocked" },
];

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_reminders_start" });

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Buscar invoices open com due_date
    const { data: invoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date, amount_cents, hosted_invoice_url")
      .eq("status", "open")
      .not("due_date", "is", null);

    let sent = 0;
    for (const inv of invoices ?? []) {
      if (!inv.due_date) continue;

      for (const offset of REMINDER_OFFSETS) {
        const triggerDate = addDays(inv.due_date, offset.days);
        if (triggerDate !== today) continue;

        // Dedupe: já mandou esse tipo hoje pra essa org?
        const { data: existing } = await supabase
          .from("billing_notifications")
          .select("id")
          .eq("organization_id", inv.organization_id)
          .eq("event_type", offset.type)
          .gte("sent_at", today + "T00:00:00Z")
          .maybeSingle();

        if (existing) continue;

        // Buscar email de cobrança
        const { data: org } = await supabase
          .from("organizations")
          .select("billing_email, name")
          .eq("id", inv.organization_id)
          .single();

        let recipient = org?.billing_email;
        if (!recipient) {
          // Fallback: email do owner
          const { data: owner } = await supabase
            .from("unit_members")
            .select("email")
            .eq("role", "owner")
            .order("created_at")
            .limit(1);
          recipient = owner?.[0]?.email;
        }

        if (!recipient) continue;

        await supabase.from("billing_notifications").insert({
          organization_id: inv.organization_id,
          event_type: offset.type,
          channel: "email",
          recipient,
          status: "pending",
        });

        sent++;
        jsonLog("info", { reqId, evt: "billing_reminder_queued", orgId: inv.organization_id, type: offset.type, recipient });
      }
    }

    jsonLog("info", { reqId, evt: "billing_reminders_done", sent });
    return new Response(JSON.stringify({ success: true, sent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_reminders_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});

// Worker: enfileira lembretes de billing (o envio real é do
// process-billing-notifications). Roda diariamente via pg_cron.
// Cadência (Fase 4b): D0 (vence hoje), D+1, D+3, D+5 relativos ao due_date —
// UMA escada, aplicada tanto a fatura de sistema quanto de instância de
// WhatsApp (Task 18, Fase 5b): REMINDER_OFFSETS nunca bifurca por tipo de
// fatura, só o prefixo do event_type muda ("whatsapp_" ou não), e é esse
// prefixo que decide o texto que o cliente lê (ver TEMPLATE_BY_EVENT em
// process-billing-notifications).
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
import { resolveWhatsAppGateByOrg, clearWhatsAppGateCache } from "../_shared/whatsapp-service-gate.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  // Sem isso, um isolate quente serviria o veredito de override de uma
  // organização de uma invocação anterior — este worker varre MUITAS
  // organizações numa só passagem, mesmo cuidado de process-whatsapp-enforcement
  // (Task 17, ver header de whatsapp-service-gate.ts).
  clearWhatsAppGateCache();

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_reminders_start" });

  try {
    const today = todayBrt();

    const { data: invoices } = await supabase
      .from("billing_invoices")
      .select("id, organization_id, due_date, billing_subscription_id, external_reference, purpose")
      .eq("status", "open")
      // Fatura retida não gera lembrete: cobrar por e-mail o que o sistema
      // decidiu não escalar é pior que não cobrar. Mesmo filtro e mesmo
      // ponto do process-billing-overdue — antes de qualquer decisão por
      // invoice, não depois.
      .eq("enforcement_hold", false)
      .not("due_date", "is", null);

    let queued = 0;
    for (const inv of invoices ?? []) {
      if (!inv.due_date) continue;

      // Qual offset cai hoje? (no máximo um por invoice por dia)
      const match = REMINDER_OFFSETS.find((o) => addDaysToDate(inv.due_date, o.days) === today);
      if (!match) continue;

      // Uma escada de dias, dois vocabulários. O prefixo decide o template, e
      // por consequência o que o cliente lê que vai acontecer: "acesso
      // suspenso" é verdade pra fatura de sistema e seria mentira pra fatura
      // da instância de WhatsApp — por isso o texto muda (Task 18), não a
      // decisão de mandar ou não.
      const isSystem = await isSystemInvoice(supabase, inv);

      if (isSystem) {
        // Nunca avisar cliente com cortesia vitalícia (system).
        if (await hasActiveSystemOverride(supabase, inv.organization_id)) continue;
      } else {
        // Org com override ativo de whatsapp não recebe lembrete da
        // mensalidade da instância — o custo está patrocinado. Mesma
        // checagem que process-whatsapp-enforcement (Task 17) faz antes de
        // suspender o serviço (resolveWhatsAppGateByOrg + state ===
        // "OVERRIDE_ACTIVE"), reusada aqui em vez de duplicar a resolução do
        // gate num segundo lugar. readFailed é tratado como Task 17 trata: não
        // age no soluço técnico, tenta de novo na próxima passagem diária.
        const gate = await resolveWhatsAppGateByOrg(supabase, inv.organization_id);
        if (gate.readFailed) {
          jsonLog("warn", {
            reqId,
            evt: "billing_reminder_whatsapp_gate_read_failed",
            orgId: inv.organization_id,
            invoiceId: inv.id,
          });
          continue;
        }
        if (gate.state === "OVERRIDE_ACTIVE") continue;
      }

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

      const eventType = isSystem ? match.type : `whatsapp_${match.type}`;

      const recipient = await resolveBillingRecipient(supabase, inv.organization_id);
      if (!recipient) continue;

      await enqueueBillingNotification(supabase, {
        organizationId: inv.organization_id,
        eventType,
        invoiceId: inv.id,
        recipient,
      });
      queued++;
      jsonLog("info", { reqId, evt: "billing_reminder_queued", orgId: inv.organization_id, type: eventType });
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

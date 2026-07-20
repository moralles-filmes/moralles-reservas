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
    const { data: pending, error: pendingErr } = await supabase
      .from("billing_notifications")
      .select("id, organization_id, event_type, recipient, invoice_id")
      .eq("status", "pending")
      .order("sent_at", { ascending: true })
      .limit(BATCH);

    if (pendingErr) {
      jsonLog("error", { reqId, evt: "billing_notifications_query_failed", err: pendingErr.message });
      return new Response(JSON.stringify({ success: false, error: "query_failed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;

    for (const row of pending ?? []) {
      const tmpl = TEMPLATE_BY_EVENT[row.event_type];
      if (!tmpl) {
        // Tipo desconhecido — marca failed pra não repetir eternamente.
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: "unknown_event_type" })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "failed",
            err: updErr.message,
          });
        }
        failed++;
        continue;
      }

      let amountCents = 0;
      let paymentUrl: string | null = null;
      if (row.invoice_id) {
        const { data: inv, error: invErr } = await supabase
          .from("billing_invoices")
          .select("amount_cents, hosted_invoice_url")
          .eq("id", row.invoice_id)
          .maybeSingle();
        if (invErr) {
          jsonLog("warn", {
            reqId,
            evt: "billing_notification_invoice_lookup_failed",
            id: row.id,
            invoice_id: row.invoice_id,
            err: invErr.message,
          });
          continue;
        }
        amountCents = (inv?.amount_cents as number | undefined) ?? 0;
        paymentUrl = (inv?.hosted_invoice_url as string | null | undefined) ?? null;
      }

      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", row.organization_id)
        .maybeSingle();

      if (orgErr) {
        jsonLog("warn", {
          reqId,
          evt: "billing_notification_org_lookup_failed",
          id: row.id,
          org: row.organization_id,
          err: orgErr.message,
        });
        continue;
      }

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
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "sent",
            err: updErr.message,
          });
        }
        sent++;
      } else if (result.skipped && (result.reason === "no_api_key" || result.reason === "no_from")) {
        // Config ausente — não é culpa da linha. Deixa 'pending' e para o lote.
        jsonLog("warn", { reqId, evt: "billing_notifications_no_config", reason: result.reason });
        break;
      } else {
        const err = result.skipped ? result.reason : result.error;
        const { error: updErr } = await supabase
          .from("billing_notifications")
          .update({ status: "failed", error: err })
          .eq("id", row.id);
        if (updErr) {
          jsonLog("error", {
            reqId,
            evt: "billing_notification_status_write_failed",
            id: row.id,
            to: "failed",
            err: updErr.message,
          });
        }
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

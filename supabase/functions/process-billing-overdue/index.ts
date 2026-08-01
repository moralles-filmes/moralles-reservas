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
  resolvePlatformAdminRecipients,
  enqueueBillingNotification,
  hasActiveSystemOverride,
} from "../_shared/billing-notify.ts";
import { resolveInvoiceCategory } from "../_shared/billing-category.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * Fatura cuja categoria não pôde ser afirmada: retém e avisa o administrador.
 *
 * A retenção é o que impede a escalada — `enforcement_hold=true` sai do
 * conjunto varrido por este worker e pelo de lembretes na próxima execução, e
 * a liberação é ação administrativa explícita (`manage-billing`).
 *
 * Best-effort e idempotente: `.eq("enforcement_hold", false)` faz o UPDATE não
 * repetir, e o aviso é deduplicado pelo UNIQUE (org, event_type, invoice_id) de
 * `billing_notifications`. Falha aqui NÃO derruba o lote — a fatura
 * simplesmente não escala nesta passada, que é a direção segura.
 */
async function holdForReview(
  reqId: string,
  inv: { id: string; organization_id: string },
  reason: string,
): Promise<void> {
  const { error: holdErr } = await supabase
    .from("billing_invoices")
    .update({
      enforcement_hold: true,
      enforcement_hold_reason: `categoria indeterminada: ${reason}`,
    })
    .eq("id", inv.id)
    .eq("enforcement_hold", false);

  if (holdErr) {
    jsonLog("error", {
      reqId,
      evt: "billing_overdue_hold_failed",
      orgId: inv.organization_id,
      invoiceId: inv.id,
      reason,
      err: holdErr.message,
    });
  } else {
    jsonLog("warn", {
      reqId,
      evt: "billing_overdue_held_for_review",
      orgId: inv.organization_id,
      invoiceId: inv.id,
      reason,
    });
  }

  // Destinatário é o ADMIN da plataforma, não o lojista: a organização não tem
  // o que fazer com "não consegui classificar sua fatura", e o dado por trás
  // (categoria, vínculo de assinatura) é administrativo.
  const admins = await resolvePlatformAdminRecipients(supabase);
  if (admins.length === 0) return;

  await enqueueBillingNotification(supabase, {
    organizationId: inv.organization_id,
    eventType: "admin_invoice_category_review",
    recipient: admins[0],
    invoiceId: inv.id,
  });
}

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
      // `provider` e `created_at` entram por causa do hotfix do Risco 7: são os
      // fatos objetivos que distinguem fatura LEGADA (compatibilidade preservada)
      // de MODERNA (sem vínculo confiável → revisão, nunca escalada).
      .select(
        "id, organization_id, due_date, billing_subscription_id, external_reference, purpose, provider, created_at",
      )
      .eq("status", "open")
      // Fatura retida para revisão administrativa NÃO conta como atraso — é o
      // freio que impede a primeira varredura da ingestão de suspender alguém
      // por dívida antiga que nunca foi cobrada de verdade. Filtro entra ANTES
      // da redução "mais antiga por org": se entrasse depois, uma org cuja
      // fatura mais antiga está retida jamais seria avaliada pela próxima
      // fatura vencida não retida.
      .eq("enforcement_hold", false)
      .lt("due_date", today);

    // Menor (mais antiga) invoice vencida por org — CONSIDERANDO SÓ AS DE
    // SISTEMA. Uma fatura de R$149 da instância vencida não pode bloquear o
    // acesso ao sistema inteiro; a inadimplência da instância é da Fase 5b.
    const oldestByOrg = new Map<string, { id: string; due_date: string }>();
    for (const inv of overdueInvoices ?? []) {
      if (!inv.due_date) continue;

      const decision = await resolveInvoiceCategory(supabase, inv);

      // NEEDS_REVIEW nunca escala e nunca é silenciado como "não é do sistema":
      // a fatura é RETIDA e o administrador é avisado. Este é o freio do hotfix
      // do Risco 7 — antes, ausência de vínculo virava `true` por compatibilidade
      // e uma renovação de R$149 da instância bloqueava a organização inteira.
      if (decision.verdict === "NEEDS_REVIEW") {
        await holdForReview(reqId, inv, decision.reason);
        continue;
      }

      if (decision.verdict === "NON_SYSTEM") {
        jsonLog("info", {
          reqId,
          evt: "billing_overdue_skip_non_system",
          orgId: inv.organization_id,
          invoiceId: inv.id,
          reason: decision.reason,
        });
        continue;
      }
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

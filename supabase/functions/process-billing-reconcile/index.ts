// Worker: reconcilia subscriptions/invoices locais com a Stripe.
// Roda diariamente via pg_cron. Stripe é fonte de verdade.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireInternalAuth, genRequestId, jsonLog } from "../_shared/security.ts";
import { retrieveStripeSubscription, retrieveStripeInvoice } from "../_shared/stripe-billing.ts";
import { isSystemInvoice, isSystemSubscription } from "../_shared/billing-category.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const reqId = genRequestId();
  jsonLog("info", { reqId, evt: "billing_reconcile_start" });

  try {
    let synced = 0;

    // Sync subscriptions que não estão canceled
    const { data: subs } = await supabase
      .from("billing_subscriptions")
      .select("id, stripe_subscription_id, status, organization_id")
      .not("stripe_subscription_id", "is", null)
      .neq("status", "canceled")
      .limit(100);

    for (const sub of subs ?? []) {
      try {
        const res = await retrieveStripeSubscription(sub.stripe_subscription_id!);
        if (!res.ok) continue;

        const s = res.data;
        const newStatus = s.status as string;
        const updates: Record<string, unknown> = {
          status: newStatus,
          current_period_start: s.current_period_start ? new Date((s.current_period_start as number) * 1000).toISOString() : null,
          current_period_end: s.current_period_end ? new Date((s.current_period_end as number) * 1000).toISOString() : null,
          cancel_at_period_end: s.cancel_at_period_end === true,
          canceled_at: s.canceled_at ? new Date((s.canceled_at as number) * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        };

        await supabase.from("billing_subscriptions").update(updates).eq("id", sub.id);

        // Sync org billing_status se mudou — SÓ quando a assinatura é de sistema.
        if (newStatus !== sub.status && (await isSystemSubscription(supabase, sub.id))) {
          const statusMap: Record<string, string> = {
            active: "active", trialing: "trialing", past_due: "past_due",
            unpaid: "past_due", canceled: "canceled", paused: "suspended",
          };
          const billingStatus = statusMap[newStatus] ?? "active";

          const orgUpdate: Record<string, unknown> = { billing_status: billingStatus };
          if (billingStatus === "active" || billingStatus === "trialing") {
            orgUpdate.blocked_at = null;
            orgUpdate.blocked_reason = null;
          }

          await supabase.from("organizations").update(orgUpdate).eq("id", sub.organization_id);
        }

        synced++;
      } catch {
        // Individual sub error — continue with next
      }
    }

    // Sync invoices que estão open/draft
    const { data: invoices } = await supabase
      .from("billing_invoices")
      // `provider` e `created_at`: fatos do hotfix do Risco 7. Este worker só
      // varre fatura com `stripe_invoice_id`, que é legada por definição — mas
      // a classificação não deduz isso do filtro, ela lê o fato.
      .select(
        "id, stripe_invoice_id, status, organization_id, billing_subscription_id, external_reference, purpose, provider, created_at",
      )
      .not("stripe_invoice_id", "is", null)
      .in("status", ["draft", "open"])
      .limit(100);

    for (const inv of invoices ?? []) {
      try {
        const res = await retrieveStripeInvoice(inv.stripe_invoice_id!);
        if (!res.ok) continue;

        const i = res.data;
        const updates: Record<string, unknown> = {
          status: i.status as string,
          hosted_invoice_url: (i.hosted_invoice_url as string) ?? null,
          invoice_pdf: (i.invoice_pdf as string) ?? null,
          updated_at: new Date().toISOString(),
        };

        if (i.status === "paid") {
          // paid_at é dado financeiro da própria fatura — grava sempre, não
          // importa a categoria. Só o desbloqueio da organização é gateado:
          // uma fatura de instância paga não pode reabrir o acesso ao sistema.
          updates.paid_at = new Date().toISOString();

          if (await isSystemInvoice(supabase, inv)) {
            const { data: org } = await supabase
              .from("organizations")
              .select("billing_status")
              .eq("id", inv.organization_id)
              .single();

            if (org && ["past_due", "grace_period", "blocked"].includes(org.billing_status)) {
              await supabase.from("organizations").update({
                billing_status: "active",
                blocked_at: null,
                blocked_reason: null,
              }).eq("id", inv.organization_id);

              jsonLog("info", { reqId, evt: "billing_reconcile_unblocked", orgId: inv.organization_id });
            }
          }
        }

        await supabase.from("billing_invoices").update(updates).eq("id", inv.id);
        synced++;
      } catch {
        // Individual invoice error — continue
      }
    }

    jsonLog("info", { reqId, evt: "billing_reconcile_done", synced });
    return new Response(JSON.stringify({ success: true, synced }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "billing_reconcile_error", err: String(err) });
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }
});

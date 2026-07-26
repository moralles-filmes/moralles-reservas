import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { getStripeWebhookSecret } from "../_shared/stripe-config.ts";

// Billing event types — roteados para billing_events (idempotencia separada de stripe_webhook_events)
const BILLING_EVENT_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
]);

// checkout.session.* é dual-purpose: caução de reserva (metadata.reservation_id)
// OU billing self-service (mode=subscription|setup + metadata.organization_id).
// Discriminado em runtime — sem essa separação, o set acima rotearia tudo pra billing.
const CHECKOUT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
]);

function isBillingCheckout(obj: Record<string, unknown> | undefined): boolean {
  if (!obj) return false;
  const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
  if (metadata.reservation_id) return false; // caução
  const mode = obj.mode as string | undefined;
  return mode === "subscription" || mode === "setup" || !!metadata.organization_id;
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const pair of sigHeader.split(",")) {
    const [k, v] = pair.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject events older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

// ═══════════════════════════════════════════════════════════════════════════
// Billing event handlers
// ═══════════════════════════════════════════════════════════════════════════

async function resolveOrgIdFromCustomer(stripeCustomerId: string): Promise<string | null> {
  const { data } = await supabase
    .from("billing_customers")
    .select("organization_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  return data?.organization_id ?? null;
}

async function handleBillingEvent(
  reqId: string,
  eventType: string,
  obj: Record<string, unknown>,
  orgIdFromMeta: string | null,
): Promise<void> {
  const orgId = orgIdFromMeta
    ?? await resolveOrgIdFromCustomer(obj.customer as string ?? "");

  if (!orgId) {
    jsonLog("warn", { reqId, evt: "billing_webhook_no_org", eventType, objectId: obj.id });
    return;
  }

  // ── Subscription events ──────────────────────────────────────────────
  if (eventType === "customer.subscription.created" || eventType === "customer.subscription.updated") {
    const stripeSubId = obj.id as string;
    const status = obj.status as string;
    const periodStart = obj.current_period_start
      ? new Date((obj.current_period_start as number) * 1000).toISOString()
      : null;
    const periodEnd = obj.current_period_end
      ? new Date((obj.current_period_end as number) * 1000).toISOString()
      : null;
    const cancelAtPeriodEnd = obj.cancel_at_period_end === true;
    const canceledAt = obj.canceled_at
      ? new Date((obj.canceled_at as number) * 1000).toISOString()
      : null;
    const trialEnd = obj.trial_end
      ? new Date((obj.trial_end as number) * 1000).toISOString()
      : null;

    const { data: existingSub } = await supabase
      .from("billing_subscriptions")
      .select("id")
      .eq("stripe_subscription_id", stripeSubId)
      .maybeSingle();

    if (existingSub) {
      await supabase.from("billing_subscriptions").update({
        status,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: cancelAtPeriodEnd,
        canceled_at: canceledAt,
        trial_end: trialEnd,
        updated_at: new Date().toISOString(),
      }).eq("id", existingSub.id);
    }

    const billingStatusMap: Record<string, string> = {
      active: "active",
      trialing: "trialing",
      past_due: "past_due",
      unpaid: "past_due",
      canceled: "canceled",
      paused: "suspended",
    };
    const newBillingStatus = billingStatusMap[status] ?? "active";

    const updateFields: Record<string, unknown> = { billing_status: newBillingStatus };
    if (newBillingStatus === "active" || newBillingStatus === "trialing") {
      updateFields.blocked_at = null;
      updateFields.blocked_reason = null;
    }
    if (trialEnd) updateFields.trial_ends_at = trialEnd;

    await supabase.from("organizations").update(updateFields).eq("id", orgId);

    jsonLog("info", { reqId, evt: "billing_sub_synced", eventType, orgId, stripeSubId, status });
  }

  if (eventType === "customer.subscription.deleted") {
    const stripeSubId = obj.id as string;

    await supabase.from("billing_subscriptions").update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("stripe_subscription_id", stripeSubId);

    await supabase.from("organizations").update({
      billing_status: "canceled",
    }).eq("id", orgId);

    jsonLog("info", { reqId, evt: "billing_sub_deleted", orgId, stripeSubId });
  }

  // ── Checkout Session events (billing self-service) ───────────────────
  // Caução de reserva já é tratada no path de reservations (isBillingCheckout=false).
  // Aqui só billing: cliente terminou checkout em mode=subscription ou setup.
  //
  // O Stripe emite customer.subscription.created/updated AUTOMATICAMENTE após
  // checkout em mode=subscription, e o handler acima (linhas 88+) faz o upsert real.
  // Esse handler só sincroniza metadata.plan_id (que vem do checkout, não da sub)
  // e registra o evento pra rastreamento.
  if (eventType === "checkout.session.completed") {
    const mode = obj.mode as string | undefined;
    const sessionId = obj.id as string;
    const stripeSubId = obj.subscription as string | null;
    const planIdFromMeta = (obj.metadata as Record<string, string>)?.plan_id ?? null;

    if (mode === "subscription" && stripeSubId && planIdFromMeta) {
      // Garante que billing_subscriptions tem o plan_id correto (subscription.created
      // pode ter chegado antes sem o plan_id resolvido, ou pode chegar depois).
      const { data: existingSub } = await supabase
        .from("billing_subscriptions")
        .select("id, billing_plan_id")
        .eq("stripe_subscription_id", stripeSubId)
        .maybeSingle();

      if (existingSub) {
        if (existingSub.billing_plan_id !== planIdFromMeta) {
          await supabase.from("billing_subscriptions").update({
            billing_plan_id: planIdFromMeta,
            updated_at: new Date().toISOString(),
          }).eq("id", existingSub.id);
        }
      } else {
        // Subscription ainda não foi criada pelo handler de subscription.created.
        // Insere registro mínimo agora; subscription.created/updated faz o resto.
        const { data: cust } = await supabase
          .from("billing_customers")
          .select("id")
          .eq("organization_id", orgId)
          .maybeSingle();

        if (cust) {
          const { error: insertSubErr } = await supabase.from("billing_subscriptions").insert({
            organization_id: orgId,
            billing_customer_id: cust.id,
            billing_plan_id: planIdFromMeta,
            stripe_subscription_id: stripeSubId,
            status: "trialing",
            payment_method: "card",
          });
          if (insertSubErr) {
            // 23505 = billing_subscriptions_org_plan_active_idx (migration 073):
            // a org já tem assinatura viva deste plano — reentrega do Stripe do
            // mesmo checkout.session.completed. Dedupe silencioso, igual ao
            // precedente do módulo de giftback: tenta o INSERT, trata 23505
            // como no-op logado em vez de deixar a exceção subir e devolver
            // 5xx pra Stripe (que reentregaria de novo em loop).
            const isDuplicate = String(insertSubErr.code ?? "") === "23505";
            jsonLog(isDuplicate ? "info" : "error", {
              reqId,
              evt: isDuplicate ? "billing_sub_insert_dedup" : "billing_sub_insert_error",
              orgId,
              stripeSubId,
              err: insertSubErr.message,
            });
          }
        }
      }
    }

    jsonLog("info", {
      reqId,
      evt: "billing_checkout_completed",
      mode,
      orgId,
      sessionId,
      stripeSubId,
      planId: planIdFromMeta,
    });
  }

  // ── Invoice events ───────────────────────────────────────────────────
  if (eventType === "invoice.created" || eventType === "invoice.finalized") {
    const stripeInvId = obj.id as string;
    const status = obj.status as string;
    const amountDue = (obj.amount_due as number) ?? 0;
    const hostedUrl = obj.hosted_invoice_url as string | null;
    const pdfUrl = obj.invoice_pdf as string | null;
    const dueDate = obj.due_date
      ? new Date((obj.due_date as number) * 1000).toISOString().slice(0, 10)
      : null;
    const invNumber = obj.number as string | null;

    const subId = obj.subscription as string | null;
    let localSubId: string | null = null;
    if (subId) {
      const { data: localSub } = await supabase
        .from("billing_subscriptions")
        .select("id")
        .eq("stripe_subscription_id", subId)
        .maybeSingle();
      localSubId = localSub?.id ?? null;
    }

    const { data: existingInv } = await supabase
      .from("billing_invoices")
      .select("id")
      .eq("stripe_invoice_id", stripeInvId)
      .maybeSingle();

    if (existingInv) {
      await supabase.from("billing_invoices").update({
        status,
        hosted_invoice_url: hostedUrl,
        invoice_pdf: pdfUrl,
        due_date: dueDate,
        number: invNumber,
        updated_at: new Date().toISOString(),
      }).eq("id", existingInv.id);
    } else {
      const { data: cust } = await supabase
        .from("billing_customers")
        .select("id")
        .eq("organization_id", orgId)
        .maybeSingle();

      if (cust) {
        await supabase.from("billing_invoices").insert({
          organization_id: orgId,
          billing_subscription_id: localSubId,
          stripe_invoice_id: stripeInvId,
          number: invNumber,
          status,
          amount_cents: amountDue,
          hosted_invoice_url: hostedUrl,
          invoice_pdf: pdfUrl,
          due_date: dueDate,
        }).single();
      }
    }

    jsonLog("info", { reqId, evt: "billing_invoice_synced", eventType, orgId, stripeInvId, status });
  }

  if (eventType === "invoice.paid") {
    const stripeInvId = obj.id as string;

    await supabase.from("billing_invoices").update({
      status: "paid",
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("stripe_invoice_id", stripeInvId);

    // Desbloquear org se estava bloqueada/vencida
    const { data: org } = await supabase
      .from("organizations")
      .select("billing_status")
      .eq("id", orgId)
      .single();

    if (org && ["past_due", "grace_period", "blocked", "pending_payment"].includes(org.billing_status)) {
      await supabase.from("organizations").update({
        billing_status: "active",
        blocked_at: null,
        blocked_reason: null,
      }).eq("id", orgId);

      jsonLog("info", { reqId, evt: "billing_org_unblocked_by_payment", orgId });
    }

    // Atualizar subscription pra active se existir
    const subId = obj.subscription as string | null;
    if (subId) {
      await supabase.from("billing_subscriptions").update({
        status: "active",
        updated_at: new Date().toISOString(),
      }).eq("stripe_subscription_id", subId).neq("status", "canceled");
    }

    jsonLog("info", { reqId, evt: "billing_invoice_paid", orgId, stripeInvId });
  }

  if (eventType === "invoice.payment_failed") {
    const stripeInvId = obj.id as string;

    await supabase.from("billing_invoices").update({
      status: "open",
      updated_at: new Date().toISOString(),
    }).eq("stripe_invoice_id", stripeInvId);

    // Verificar se tem override ativo de grant_access
    const { data: override } = await supabase
      .from("billing_access_overrides")
      .select("id")
      .eq("organization_id", orgId)
      .eq("override_type", "grant_access")
      .eq("active", true)
      .maybeSingle();

    if (!override) {
      await supabase.from("organizations").update({
        billing_status: "past_due",
      }).eq("id", orgId);
    }

    jsonLog("info", { reqId, evt: "billing_payment_failed", orgId, stripeInvId, overrideActive: !!override });
  }

  if (eventType === "invoice.payment_action_required") {
    jsonLog("info", { reqId, evt: "billing_payment_action_required", orgId, stripeInvId: obj.id });
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const reqId = genRequestId();

  try {
    const webhookSecret = await getStripeWebhookSecret();
    if (!webhookSecret) {
      jsonLog("error", { reqId, evt: "stripe_webhook_no_secret" });
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const rawBody = await req.text();
    const sigHeader = req.headers.get("stripe-signature") ?? "";

    const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
    if (!valid) {
      jsonLog("warn", { reqId, evt: "stripe_webhook_invalid_signature" });
      return new Response("Invalid signature", { status: 400 });
    }

    const event = JSON.parse(rawBody);
    const eventId = event.id as string;
    const eventType = event.type as string;

    // ═══════════════════════════════════════════════════════════════════════
    // BILLING EVENTS — roteados ANTES da idempotencia de reservas.
    // Usam billing_events para idempotencia (separada de stripe_webhook_events).
    // ═══════════════════════════════════════════════════════════════════════

    const objForRouting = event.data?.object as Record<string, unknown> | undefined;
    const routeAsBilling =
      BILLING_EVENT_TYPES.has(eventType) ||
      (CHECKOUT_EVENT_TYPES.has(eventType) && isBillingCheckout(objForRouting));

    if (routeAsBilling) {
      const { data: billingExisting } = await supabase
        .from("billing_events")
        .select("id")
        .eq("stripe_event_id", eventId)
        .maybeSingle();

      if (billingExisting) {
        jsonLog("info", { reqId, evt: "billing_webhook_duplicate", eventId });
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      const obj = objForRouting!;
      const orgId = (obj?.metadata as Record<string, string>)?.organization_id ?? null;

      await handleBillingEvent(reqId, eventType, obj, orgId);

      await supabase.from("billing_events").insert({
        stripe_event_id: eventId,
        event_type: eventType,
        organization_id: orgId,
        data: { object_id: obj?.id, status: obj?.status, mode: obj?.mode },
      });

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESERVATION EVENTS — idempotencia via stripe_webhook_events (inalterada)
    // ═══════════════════════════════════════════════════════════════════════

    const { data: existing } = await supabase
      .from("stripe_webhook_events")
      .select("id")
      .eq("stripe_event_id", eventId)
      .maybeSingle();

    if (existing) {
      jsonLog("info", { reqId, evt: "stripe_webhook_duplicate", eventId });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESERVATION EVENTS — fluxo existente de caucao (inalterado)
    // ═══════════════════════════════════════════════════════════════════════

    const session = event.data?.object;
    const reservationId = session?.metadata?.reservation_id as string | undefined;

    if (eventType === "checkout.session.completed" && reservationId) {
      const paymentIntentId = session.payment_intent as string | undefined;

      const { error: updateErr } = await supabase
        .from("reservations")
        .update({
          payment_status: "paid",
          stripe_payment_intent_id: paymentIntentId ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", reservationId)
        .eq("payment_status", "pending_payment");

      if (updateErr) {
        jsonLog("error", {
          reqId,
          evt: "stripe_webhook_update_error",
          reservationId,
          err: updateErr.message,
        });
      }

      const { data: reservation } = await supabase
        .from("reservations")
        .select("id, unit_id, customer_id, date, time, party_size, reservation_code")
        .eq("id", reservationId)
        .maybeSingle();

      if (reservation) {
        await supabase.from("notification_outbox").insert({
          reservation_id: reservation.id,
          unit_id: reservation.unit_id,
          kind: "confirmation",
          status: "pending",
          payload: {
            customer_id: reservation.customer_id,
            date: reservation.date,
            time: reservation.time,
            party_size: reservation.party_size,
            reservation_code: reservation.reservation_code,
          },
        });
      }

      jsonLog("info", {
        reqId,
        evt: "stripe_payment_completed",
        reservationId,
        paymentIntentId,
      });
    } else if (eventType === "checkout.session.expired" && reservationId) {
      const { error: updateErr } = await supabase
        .from("reservations")
        .update({
          payment_status: "expired",
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", reservationId)
        .eq("payment_status", "pending_payment");

      if (updateErr) {
        jsonLog("error", {
          reqId,
          evt: "stripe_webhook_expire_error",
          reservationId,
          err: updateErr.message,
        });
      }

      jsonLog("info", {
        reqId,
        evt: "stripe_session_expired",
        reservationId,
      });
    } else {
      jsonLog("info", {
        reqId,
        evt: "stripe_webhook_unhandled_type",
        eventType,
      });
    }

    // Record event for idempotency (reservation events only)
    await supabase.from("stripe_webhook_events").insert({
      stripe_event_id: eventId,
      event_type: eventType,
      reservation_id: reservationId ?? null,
    });

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "stripe_webhook_unhandled", err: String(err) });
    return new Response("Internal error", { status: 500 });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { getStripeWebhookSecret } from "../_shared/stripe-config.ts";

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

    // Idempotency check
    const { data: existing } = await supabase
      .from("stripe_webhook_events")
      .select("id")
      .eq("stripe_event_id", eventId)
      .maybeSingle();

    if (existing) {
      jsonLog("info", { reqId, evt: "stripe_webhook_duplicate", eventId });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

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

      // Enqueue confirmation notification (same as notification_outbox trigger
      // for web reservations — the trigger filters source='whatsapp', so web
      // reservations with pending_payment that just got paid need explicit enqueue)
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

    // Record event for idempotency
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

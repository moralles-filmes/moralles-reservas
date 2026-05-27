import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const STRIPE_API = "https://api.stripe.com/v1";
const APP_BASE_URL =
  Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  const reqId = genRequestId();

  try {
    const STRIPE_SECRET_KEY = await getStripeSecretKey();
    if (!STRIPE_SECRET_KEY) {
      return jsonResponse({ error: "Stripe não configurado." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const reservationId = body.reservation_id as string | undefined;
    if (!reservationId) {
      return jsonResponse({ error: "reservation_id obrigatório." }, 400);
    }

    const { data: reservation, error: resErr } = await supabase
      .from("reservations")
      .select(
        "id, unit_id, reservation_code, payment_status, payment_amount_cents, stripe_checkout_session_id",
      )
      .eq("id", reservationId)
      .maybeSingle();

    if (resErr || !reservation) {
      return jsonResponse({ error: "Reserva não encontrada." }, 404);
    }

    if (reservation.payment_status !== "pending_payment") {
      return jsonResponse({ error: "Pagamento não pendente para esta reserva." }, 400);
    }

    if (!reservation.payment_amount_cents || reservation.payment_amount_cents <= 0) {
      return jsonResponse({ error: "Valor de caução inválido." }, 400);
    }

    // Se já tem session, retornar a URL dela (idempotência)
    if (reservation.stripe_checkout_session_id) {
      const existingRes = await fetch(
        `${STRIPE_API}/checkout/sessions/${reservation.stripe_checkout_session_id}`,
        {
          headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
        },
      );
      const existingSession = await existingRes.json();
      if (existingRes.ok && existingSession.url && existingSession.status === "open") {
        return jsonResponse({ success: true, checkout_url: existingSession.url });
      }
    }

    const { data: stripeAccount } = await supabase
      .from("stripe_accounts")
      .select("stripe_account_id, charges_enabled")
      .eq("unit_id", reservation.unit_id)
      .maybeSingle();

    if (!stripeAccount?.stripe_account_id || !stripeAccount.charges_enabled) {
      jsonLog("warn", {
        reqId,
        evt: "checkout_no_stripe_account",
        unit_id: reservation.unit_id,
      });
      return jsonResponse(
        { error: "Pagamento indisponível para esta unidade." },
        400,
      );
    }

    const { data: unit } = await supabase
      .from("units")
      .select("slug")
      .eq("id", reservation.unit_id)
      .maybeSingle();

    const slug = unit?.slug ?? "";
    const successUrl = `${APP_BASE_URL}/r/${slug}?payment=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${APP_BASE_URL}/r/${slug}?payment=cancelled&reservation_id=${reservationId}`;

    const params = new URLSearchParams({
      mode: "payment",
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "pix",
      "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][unit_amount]":
        String(reservation.payment_amount_cents),
      "line_items[0][price_data][product_data][name]":
        `Caução reserva #${reservation.reservation_code}`,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[reservation_id]": reservationId,
      "metadata[unit_id]": reservation.unit_id,
      "metadata[reservation_code]": reservation.reservation_code,
      "payment_intent_data[transfer_data][destination]":
        stripeAccount.stripe_account_id,
    });

    const sessionRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await sessionRes.json();

    if (!sessionRes.ok) {
      jsonLog("error", {
        reqId,
        evt: "stripe_create_session_error",
        status: sessionRes.status,
        err: session,
      });
      return jsonResponse({ error: "Falha ao criar sessão de pagamento." }, 500);
    }

    await supabase
      .from("reservations")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", reservationId);

    jsonLog("info", {
      reqId,
      evt: "checkout_session_created",
      reservation_id: reservationId,
      session_id: session.id,
    });

    return jsonResponse({ success: true, checkout_url: session.url });
  } catch (err) {
    jsonLog("error", { reqId, evt: "create_checkout_unhandled", err: String(err) });
    return jsonResponse({ error: "Erro interno." }, 500);
  }
});

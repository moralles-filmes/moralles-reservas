// Edge Function: create-billing-checkout
// Gera Stripe Checkout Session (mode=subscription | mode=setup) pra self-service.
//
// Auth: JWT obrigatório. Caller precisa ser:
//   - platform_admin OU
//   - member (role owner|gerente) de qualquer unit da organization_id alvo
//
// mode=subscription → cliente cadastra cartão e ativa subscription do plano
// mode=setup        → cliente só troca o cartão (sem mudar plano)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";
import { createStripeCustomer } from "../_shared/stripe-billing.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const STRIPE_API = "https://api.stripe.com/v1";
const APP_BASE_URL =
  Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function canManageOrgBilling(userId: string, organizationId: string): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;

  // owner/gerente de qualquer unit da org pode iniciar checkout
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);

  return !!(data && data.length > 0);
}

async function resolveOrgSlug(organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("organizations")
    .select("slug")
    .eq("id", organizationId)
    .maybeSingle();
  return data?.slug ?? null;
}

async function resolveUnitSlug(organizationId: string): Promise<string | null> {
  // Pra montar success_url precisamos do unit_slug. Pegamos a primeira unit
  // da org (a UI cliente sempre acessa via /g/<unit_slug>/cobranca).
  const { data } = await supabase
    .from("units")
    .select("slug")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.slug ?? null;
}

async function getOrCreateBillingCustomer(organizationId: string, fallbackEmail: string | null): Promise<{ id: string; stripe_customer_id: string | null } | null> {
  const { data: existing } = await supabase
    .from("billing_customers")
    .select("id, stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing) {
    // Garante que tem stripe_customer_id; se não, cria no Stripe agora
    if (existing.stripe_customer_id) return existing;

    const { data: org } = await supabase
      .from("organizations")
      .select("name, slug, billing_email")
      .eq("id", organizationId)
      .single();

    const stripeRes = await createStripeCustomer({
      email: org?.billing_email ?? fallbackEmail ?? undefined,
      name: org?.name ?? undefined,
      metadata: { organization_id: organizationId, slug: org?.slug ?? "" },
    });

    if (!stripeRes.ok) return null;

    await supabase
      .from("billing_customers")
      .update({ stripe_customer_id: stripeRes.customerId })
      .eq("id", existing.id);

    return { id: existing.id, stripe_customer_id: stripeRes.customerId! };
  }

  // Não existe — cria do zero
  const { data: org } = await supabase
    .from("organizations")
    .select("name, slug, billing_email")
    .eq("id", organizationId)
    .single();

  const stripeRes = await createStripeCustomer({
    email: org?.billing_email ?? fallbackEmail ?? undefined,
    name: org?.name ?? undefined,
    metadata: { organization_id: organizationId, slug: org?.slug ?? "" },
  });

  if (!stripeRes.ok) return null;

  const { data: created, error } = await supabase
    .from("billing_customers")
    .insert({
      organization_id: organizationId,
      stripe_customer_id: stripeRes.customerId,
      email: org?.billing_email ?? fallbackEmail ?? null,
      name: org?.name ?? null,
    })
    .select("id, stripe_customer_id")
    .single();

  if (error) return null;
  return created;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Método não permitido." }, 405);
  }

  const reqId = genRequestId();

  try {
    const STRIPE_SECRET_KEY = await getStripeSecretKey();
    if (!STRIPE_SECRET_KEY) {
      return jsonResponse(req, { error: "Stripe não configurado." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;
    const callerEmail = callerData.user.email ?? null;

    const body = await req.json().catch(() => ({}));
    const { organization_id, plan_id, mode = "subscription" } = body as {
      organization_id?: string;
      plan_id?: string;
      mode?: "subscription" | "setup";
    };

    if (!organization_id) {
      return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
    }
    if (mode === "subscription" && !plan_id) {
      return jsonResponse(req, { error: "plan_id é obrigatório para mode=subscription." }, 400);
    }
    if (!["subscription", "setup"].includes(mode)) {
      return jsonResponse(req, { error: "mode inválido (use 'subscription' ou 'setup')." }, 400);
    }

    if (!(await canManageOrgBilling(callerId, organization_id))) {
      return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
    }

    // Resolve plano (se subscription)
    let plan: Record<string, unknown> | null = null;
    if (mode === "subscription") {
      const { data: planData, error: planErr } = await supabase
        .from("billing_plans")
        .select("id, name, slug, stripe_price_id_card, trial_days, active")
        .eq("id", plan_id)
        .maybeSingle();

      if (planErr || !planData) {
        return jsonResponse(req, { error: "Plano não encontrado." }, 404);
      }
      if (!planData.active) {
        return jsonResponse(req, { error: "Plano inativo." }, 400);
      }
      if (!planData.stripe_price_id_card) {
        return jsonResponse(req, { error: "Plano sem stripe_price_id_card configurado." }, 400);
      }
      plan = planData;
    }

    // Resolve/cria billing_customer (com stripe_customer_id)
    const customer = await getOrCreateBillingCustomer(organization_id, callerEmail);
    if (!customer || !customer.stripe_customer_id) {
      jsonLog("error", { reqId, evt: "checkout_no_stripe_customer", orgId: organization_id });
      return jsonResponse(req, { error: "Falha ao preparar customer Stripe." }, 500);
    }

    const unitSlug = await resolveUnitSlug(organization_id);
    const orgSlug = await resolveOrgSlug(organization_id);
    const successBase = unitSlug
      ? `${APP_BASE_URL}/g/${unitSlug}/cobranca`
      : `${APP_BASE_URL}/platform/billing/${organization_id}`;

    // Monta payload do Checkout Session
    const sessionBody: Record<string, string> = {
      "customer": customer.stripe_customer_id,
      "mode": mode,
      "success_url": `${successBase}?session=success&sid={CHECKOUT_SESSION_ID}`,
      "cancel_url": `${successBase}?session=cancel`,
      "metadata[organization_id]": organization_id,
      "metadata[caller_user_id]": callerId,
    };

    if (mode === "subscription" && plan) {
      sessionBody["line_items[0][price]"] = plan.stripe_price_id_card as string;
      sessionBody["line_items[0][quantity]"] = "1";
      sessionBody["metadata[plan_id]"] = plan.id as string;
      sessionBody["subscription_data[metadata][organization_id]"] = organization_id;
      sessionBody["subscription_data[metadata][plan_id]"] = plan.id as string;

      const trialDays = (plan.trial_days as number | undefined) ?? 0;
      if (trialDays > 0) {
        sessionBody["subscription_data[trial_period_days]"] = String(trialDays);
      }

      // BR aceita só cartão pra subscription recorrente
      sessionBody["payment_method_types[0]"] = "card";
    } else if (mode === "setup") {
      // Stripe exige payment_method_types em mode=setup
      sessionBody["payment_method_types[0]"] = "card";
    }

    const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(sessionBody).toString(),
    });

    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      const errMsg = (stripeData.error as Record<string, string> | undefined)?.message ?? "Falha no Stripe.";
      jsonLog("error", { reqId, evt: "checkout_stripe_error", err: errMsg, status: stripeRes.status });
      return jsonResponse(req, { error: errMsg }, 500);
    }

    jsonLog("info", {
      reqId,
      evt: "checkout_session_created",
      orgId: organization_id,
      planId: plan?.id ?? null,
      mode,
      sessionId: stripeData.id,
      orgSlug,
    });

    return jsonResponse(req, {
      success: true,
      url: stripeData.url,
      session_id: stripeData.id,
    });
  } catch (err) {
    jsonLog("error", { reqId, evt: "checkout_unexpected_error", err: err instanceof Error ? err.message : String(err) });
    return jsonResponse(req, { error: "Erro inesperado ao criar checkout." }, 500);
  }
});

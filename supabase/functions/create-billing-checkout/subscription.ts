// Ramo de assinatura de create-billing-checkout: sistema (R$449, Asaas) e
// instância de WhatsApp (R$149, Task 11 decide elegibilidade), mais o ramo
// Stripe legado (assinatura antiga + payment_method_update/troca de cartão).
//
// O ramo Asaas passa pelo gate `asaas_enabled` e pelo ciclo de vida de
// billing_checkout_sessions (_shared/checkout-sessions.ts, via context.ts). O
// ramo Stripe é legado, não muda: sem gate, sem sessão.

import { jsonLog } from "../_shared/security.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { buildExternalReference } from "../_shared/asaas-billing-events.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";
import { createStripeCustomer } from "../_shared/stripe-billing.ts";
import {
  supabase,
  requireAsaasEnabled,
  resolveAsaasCustomer,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
  type CheckoutContext,
  type CheckoutPurpose,
  type PlanRow,
} from "./context.ts";
import { assertCanContractPlan } from "./eligibility.ts";

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const STRIPE_API = "https://api.stripe.com/v1";

export async function handleSubscription(
  ctx: CheckoutContext,
  purpose: CheckoutPurpose,
): Promise<HandlerResult> {
  const plan = ctx.plan;

  // payment_method_update (troca de cartão) não contrata plano nenhum — é o
  // ÚNICO purpose que chega aqui sem plan_id (index.ts não o exige pra ele,
  // espelhando o `mode=setup` legado). Sem este atalho ANTES do `if (!plan)`
  // abaixo, toda troca de cartão (Cobranca.tsx `handleChangeCard`) devolveria
  // 400 "plan_id é obrigatório" — regressão no fluxo em produção. Só Stripe
  // suporta isto hoje (ver comentário de topo de index.ts).
  if (purpose === "payment_method_update") return await stripeCheckout(ctx, purpose);

  if (!plan) return { status: 400, body: { error: "plan_id é obrigatório para contratar uma assinatura." } };
  if (!plan.active) return { status: 400, body: { error: "Plano inativo." } };
  // Produto de cobrança única (implantação, recarga de IA) não é assinatura:
  // seguir aqui abriria um RECURRENT e cobraria todo mês por algo avulso.
  if (plan.billing_type === "one_time") {
    return {
      status: 400,
      body: { error: "Este produto é de cobrança única e não pode ser contratado como assinatura." },
    };
  }

  // Elegibilidade por categoria (Task 11). Para SYSTEM_SUBSCRIPTION é no-op.
  const eligibility = await assertCanContractPlan(ctx, plan);
  if (!eligibility.ok) return { status: eligibility.status, body: { error: eligibility.error } };

  const provider = plan.provider === "asaas" || plan.provider === "stripe" ? plan.provider : null;
  if (provider === "asaas") return await asaasSubscriptionCheckout(ctx, plan);
  return await stripeCheckout(ctx, purpose);
}

/**
 * Ramo Asaas da assinatura recorrente. Reserva a sessão ANTES de chamar o
 * Asaas — dois cliques não podem abrir duas cobranças reais (o Asaas não tem
 * Idempotency-Key).
 */
async function asaasSubscriptionCheckout(ctx: CheckoutContext, plan: PlanRow): Promise<HandlerResult> {
  const asaasGate = await requireAsaasEnabled(ctx.reqId, ctx.organizationId, plan.id);
  if (!asaasGate.ok) return { status: asaasGate.status, body: { error: asaasGate.error } };

  if (!plan.amount_cents || plan.amount_cents <= 0) {
    return { status: 400, body: { error: "Plano sem valor configurado." } };
  }

  const asaas = getBillingProvider("asaas");

  const customerResult = await resolveAsaasCustomer(ctx, (a) => asaas.createCustomer(a));
  if (!customerResult.ok) return { status: customerResult.status, body: { error: customerResult.error } };
  const customerId = customerResult.customerId;

  // Correlação do webhook. ATENÇÃO (§13.7, verificado ao vivo): o checkout
  // hospedado do Asaas NÃO propaga este externalReference para a assinatura
  // nem para a cobrança geradas (ambas nascem com externalReference=null), e
  // o pagador digita os dados na página gerando um customer NOVO — logo nem
  // externalReference nem customer resolvem a org no webhook. Por isso a
  // sessão abaixo grava o mapa checkoutId → org; este externalReference vai
  // no checkout mesmo assim (é lido de volta de billing_checkout_sessions e
  // reidrata plano+purpose no aplicador).
  const externalReference = buildExternalReference({
    orgId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
  });

  const reserved = await reserveCheckoutSession(supabase, {
    reqId: ctx.reqId,
    organizationId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
    externalReference,
  });
  if (!reserved.ok && reserved.reuse) {
    return { status: 200, body: { success: true, url: reserved.url, session_id: reserved.providerCheckoutId } };
  }
  if (!reserved.ok) return { status: reserved.status, body: { error: reserved.error } };

  const checkout = await asaas.createCheckout({
    providerCustomerId: customerId,
    amountCents: plan.amount_cents!,
    description: plan.name,
    interval: plan.interval,
    externalReference,
    mode: "subscription",
    minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
    successUrl: `${ctx.successBase}?session=success`,
    cancelUrl: `${ctx.successBase}?session=cancel`,
  });

  if (!checkout.ok || !checkout.data?.checkoutId) {
    await failCheckoutSession(supabase, reserved.sessionId);
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_error",
      orgId: ctx.organizationId,
      planId: plan.id,
      err: checkout.error ?? "checkout sem id",
    });
    return {
      status: 502,
      body: { error: "Não foi possível abrir o checkout de pagamento. Tente novamente em instantes." },
    };
  }

  // Persistir é PRÉ-REQUISITO: sem a linha correlacionável, o webhook não
  // resolve a org e o pagamento se perde em silêncio.
  const finalized = await finalizeCheckoutSession(supabase, reserved.sessionId, {
    providerCheckoutId: checkout.data.checkoutId,
    checkoutUrl: checkout.data.url,
  });
  if (!finalized) {
    return { status: 500, body: { error: "Falha ao registrar o checkout. Tente novamente em instantes." } };
  }

  jsonLog("info", {
    reqId: ctx.reqId,
    evt: "checkout_session_created",
    provider: "asaas",
    orgId: ctx.organizationId,
    planId: plan.id,
    purpose: "subscription",
    sessionId: checkout.data.checkoutId,
  });
  return {
    status: 200,
    body: { success: true, url: checkout.data.url, session_id: checkout.data.checkoutId },
  };
}

interface StripeBillingCustomer {
  id: string;
  stripe_customer_id: string | null;
}

/** Ramo Stripe legado — resolve/cria billing_customer com stripe_customer_id.
 *  Comportamento IDÊNTICO ao da EF original (linhas 110-171): não otimizado,
 *  não mexido — é o caminho antigo, mantido de pé só pra troca de cartão e
 *  assinatura de plano `provider != 'asaas'`. */
async function getOrCreateBillingCustomer(
  organizationId: string,
  fallbackEmail: string | null,
): Promise<StripeBillingCustomer | null> {
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

/**
 * Ramo Stripe legado (linhas 500-578 da EF original) — inalterado. Não passa
 * pelo gate `asaas_enabled` nem pelo ciclo de billing_checkout_sessions.
 * `mode` deriva do purpose: `payment_method_update` → `setup`, senão
 * `subscription`.
 */
async function stripeCheckout(ctx: CheckoutContext, purpose: CheckoutPurpose): Promise<HandlerResult> {
  const mode: "subscription" | "setup" = purpose === "payment_method_update" ? "setup" : "subscription";
  const plan = ctx.plan;

  const STRIPE_SECRET_KEY = await getStripeSecretKey();
  if (!STRIPE_SECRET_KEY) {
    return { status: 500, body: { error: "Stripe não configurado." } };
  }

  if (mode === "subscription" && !plan?.stripe_price_id_card) {
    return { status: 400, body: { error: "Plano sem stripe_price_id_card configurado." } };
  }

  // Resolve/cria billing_customer (com stripe_customer_id)
  const customer = await getOrCreateBillingCustomer(ctx.organizationId, ctx.callerEmail);
  if (!customer || !customer.stripe_customer_id) {
    jsonLog("error", { reqId: ctx.reqId, evt: "checkout_no_stripe_customer", orgId: ctx.organizationId });
    return { status: 500, body: { error: "Falha ao preparar customer Stripe." } };
  }

  // Monta payload do Checkout Session
  const sessionBody: Record<string, string> = {
    "customer": customer.stripe_customer_id,
    "mode": mode,
    "success_url": `${ctx.successBase}?session=success&sid={CHECKOUT_SESSION_ID}`,
    "cancel_url": `${ctx.successBase}?session=cancel`,
    "metadata[organization_id]": ctx.organizationId,
    "metadata[caller_user_id]": ctx.callerId,
  };

  if (mode === "subscription" && plan) {
    sessionBody["line_items[0][price]"] = plan.stripe_price_id_card!;
    sessionBody["line_items[0][quantity]"] = "1";
    sessionBody["metadata[plan_id]"] = plan.id;
    sessionBody["subscription_data[metadata][organization_id]"] = ctx.organizationId;
    sessionBody["subscription_data[metadata][plan_id]"] = plan.id;

    const trialDays = plan.trial_days ?? 0;
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
    jsonLog("error", { reqId: ctx.reqId, evt: "checkout_stripe_error", err: errMsg, status: stripeRes.status });
    return { status: 500, body: { error: errMsg } };
  }

  jsonLog("info", {
    reqId: ctx.reqId,
    evt: "checkout_session_created",
    provider: "stripe",
    orgId: ctx.organizationId,
    planId: plan?.id ?? null,
    mode,
    sessionId: stripeData.id,
    orgSlug: ctx.org?.slug ?? null,
  });

  return {
    status: 200,
    body: { success: true, url: stripeData.url, session_id: stripeData.id },
  };
}

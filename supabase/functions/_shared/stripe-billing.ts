/**
 * Helpers para Stripe Billing (mensalidades da plataforma).
 *
 * Usa a conta principal da plataforma (nao Connected Account).
 * Nao usa transfer_data. Nao interfere em caucao de reservas.
 *
 * Chamado por: manage-billing, stripe-webhook (billing events),
 *              workers de billing (reconcile, overdue, unblock).
 */

import { getStripeSecretKey } from "./stripe-config.ts";

const STRIPE_API = "https://api.stripe.com/v1";

export async function stripeRequest(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) {
    throw new Error("Stripe não configurado na plataforma.");
  }
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`${STRIPE_API}${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ── Customer ─────────────────────────────────────────────────────────────────

export async function createStripeCustomer(params: {
  email?: string;
  name?: string;
  taxId?: string;
  metadata?: Record<string, string>;
}): Promise<{ ok: boolean; customerId?: string; error?: string }> {
  const body: Record<string, string> = {};
  if (params.email) body["email"] = params.email;
  if (params.name) body["name"] = params.name;
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  const res = await stripeRequest("/customers", "POST", body);
  if (!res.ok) {
    return { ok: false, error: (res.data.error as Record<string, string>)?.message ?? "Falha ao criar customer." };
  }

  const customerId = res.data.id as string;

  if (params.taxId) {
    await stripeRequest(`/customers/${customerId}/tax_ids`, "POST", {
      type: "br_cpf_cnpj",
      value: params.taxId.replace(/\D/g, ""),
    });
  }

  return { ok: true, customerId };
}

export async function retrieveStripeCustomer(
  customerId: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  return stripeRequest(`/customers/${customerId}`);
}

// ── Subscription ─────────────────────────────────────────────────────────────

export async function createStripeSubscription(params: {
  customerId: string;
  priceId: string;
  trialDays?: number;
  metadata?: Record<string, string>;
}): Promise<{ ok: boolean; subscriptionId?: string; clientSecret?: string; error?: string }> {
  const body: Record<string, string> = {
    "customer": params.customerId,
    "items[0][price]": params.priceId,
    "payment_behavior": "default_incomplete",
    "expand[0]": "latest_invoice.payment_intent",
  };
  if (params.trialDays && params.trialDays > 0) {
    body["trial_period_days"] = String(params.trialDays);
  }
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  const res = await stripeRequest("/subscriptions", "POST", body);
  if (!res.ok) {
    return { ok: false, error: (res.data.error as Record<string, string>)?.message ?? "Falha ao criar assinatura." };
  }

  const sub = res.data;
  const invoice = sub.latest_invoice as Record<string, unknown> | undefined;
  const pi = invoice?.payment_intent as Record<string, unknown> | undefined;

  return {
    ok: true,
    subscriptionId: sub.id as string,
    clientSecret: pi?.client_secret as string | undefined,
  };
}

export async function cancelStripeSubscription(
  subscriptionId: string,
  atPeriodEnd = true,
): Promise<{ ok: boolean; error?: string }> {
  if (atPeriodEnd) {
    const res = await stripeRequest(`/subscriptions/${subscriptionId}`, "POST", {
      cancel_at_period_end: "true",
    });
    if (!res.ok) {
      return { ok: false, error: (res.data.error as Record<string, string>)?.message ?? "Falha ao cancelar." };
    }
    return { ok: true };
  }

  const res = await stripeRequest(`/subscriptions/${subscriptionId}`, "DELETE");
  if (!res.ok) {
    return { ok: false, error: (res.data.error as Record<string, string>)?.message ?? "Falha ao cancelar." };
  }
  return { ok: true };
}

export async function retrieveStripeSubscription(
  subscriptionId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return stripeRequest(`/subscriptions/${subscriptionId}`);
}

// ── Invoice ──────────────────────────────────────────────────────────────────

export async function createStripeInvoice(params: {
  customerId: string;
  amountCents: number;
  description: string;
  daysUntilDue?: number;
  metadata?: Record<string, string>;
}): Promise<{ ok: boolean; invoiceId?: string; hostedUrl?: string; error?: string }> {
  const invoiceBody: Record<string, string> = {
    customer: params.customerId,
    collection_method: "send_invoice",
    days_until_due: String(params.daysUntilDue ?? 7),
    "payment_settings[payment_method_types][0]": "boleto",
    "payment_settings[payment_method_types][1]": "pix",
  };
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      invoiceBody[`metadata[${k}]`] = v;
    }
  }

  const invoiceRes = await stripeRequest("/invoices", "POST", invoiceBody);
  if (!invoiceRes.ok) {
    return { ok: false, error: (invoiceRes.data.error as Record<string, string>)?.message ?? "Falha ao criar fatura." };
  }
  const invoiceId = invoiceRes.data.id as string;

  const itemRes = await stripeRequest("/invoiceitems", "POST", {
    customer: params.customerId,
    invoice: invoiceId,
    amount: String(params.amountCents),
    currency: "brl",
    description: params.description,
  });
  if (!itemRes.ok) {
    return { ok: false, error: (itemRes.data.error as Record<string, string>)?.message ?? "Falha ao adicionar item." };
  }

  const finalizeRes = await stripeRequest(`/invoices/${invoiceId}/finalize`, "POST");
  if (!finalizeRes.ok) {
    return { ok: false, error: (finalizeRes.data.error as Record<string, string>)?.message ?? "Falha ao finalizar fatura." };
  }

  return {
    ok: true,
    invoiceId,
    hostedUrl: finalizeRes.data.hosted_invoice_url as string | undefined,
  };
}

export async function retrieveStripeInvoice(
  invoiceId: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return stripeRequest(`/invoices/${invoiceId}`);
}

export async function voidStripeInvoice(
  invoiceId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await stripeRequest(`/invoices/${invoiceId}/void`, "POST");
  if (!res.ok) {
    return { ok: false, error: (res.data.error as Record<string, string>)?.message ?? "Falha ao anular fatura." };
  }
  return { ok: true };
}

export async function listStripeInvoices(
  customerId: string,
  params?: { limit?: number; status?: string },
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const query: Record<string, string> = {
    customer: customerId,
    limit: String(params?.limit ?? 20),
  };
  if (params?.status) query["status"] = params.status;

  const qs = new URLSearchParams(query).toString();
  return stripeRequest(`/invoices?${qs}`);
}

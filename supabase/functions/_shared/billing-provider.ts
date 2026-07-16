/**
 * Camada abstrata de provedores de pagamento (Fase 1 billing-asaas).
 *
 * BillingProviderPort é o contrato único; implementações:
 *   - StripeBillingProvider (este arquivo): adapter fino sobre os helpers
 *     legados de stripe-billing.ts — comportamento IDÊNTICO ao atual, papel
 *     read-only/legado durante a migração.
 *   - AsaasBillingProvider (Fase 2, _shared/asaas.ts): provedor principal novo.
 *
 * Regras:
 *   - Valores monetários SEMPRE em centavos inteiros.
 *   - O caller NUNCA aceita preço vindo do request — carrega de billing_plans.
 *   - processWebhook fica FORA do port: cada provedor tem verificação própria
 *     (Stripe HMAC t=/v1= em stripe-webhook; Asaas token de header em
 *     asaas-webhook). O port cobre as operações imperativas.
 *
 * REDEPLOY: nenhuma EF importa este módulo ainda. Quando importarem, adicionar
 * ao checklist de redeploy do CLAUDE.md.
 */

import {
  cancelStripeSubscription,
  createStripeCustomer,
  createStripeInvoice,
  createStripeSubscription,
  retrieveStripeInvoice,
  retrieveStripeSubscription,
} from "./stripe-billing.ts";

export type BillingProviderName = "stripe" | "asaas";

export interface ProviderResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface CreateCustomerParams {
  organizationId: string;
  name?: string;
  email?: string;
  /** CPF/CNPJ — obrigatório no Asaas, opcional no Stripe. */
  taxId?: string;
}

export interface CreateCheckoutParams {
  providerCustomerId: string;
  /** Centavos — SEMPRE carregado de billing_plans no servidor. */
  amountCents: number;
  description: string;
  /** Correlação org|plan|purpose validada no webhook. */
  externalReference: string;
  mode: "subscription" | "one_time";
  successUrl?: string;
  cancelUrl?: string;
}

export interface CreateOneTimeChargeParams {
  providerCustomerId: string;
  amountCents: number;
  description: string;
  externalReference: string;
  daysUntilDue?: number;
}

export interface CreateSubscriptionParams {
  providerCustomerId: string;
  amountCents: number;
  /** Stripe exige price pré-cadastrado; Asaas usa valor direto. */
  providerPriceId?: string;
  trialDays?: number;
  externalReference: string;
  metadata?: Record<string, string>;
}

export interface BillingProviderPort {
  readonly name: BillingProviderName;
  createCustomer(params: CreateCustomerParams): Promise<ProviderResult<{ customerId: string }>>;
  createCheckout(params: CreateCheckoutParams): Promise<ProviderResult<{ checkoutId?: string; url: string }>>;
  createOneTimeCharge(params: CreateOneTimeChargeParams): Promise<ProviderResult<{ paymentId: string; paymentUrl?: string }>>;
  createSubscription(params: CreateSubscriptionParams): Promise<ProviderResult<{ subscriptionId: string }>>;
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd: boolean): Promise<ProviderResult>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderResult>;
  getPayment(providerPaymentId: string): Promise<ProviderResult>;
  refundPayment(providerPaymentId: string, amountCents?: number): Promise<ProviderResult>;
}

/** Operação sem suporte no provedor/camada — erro explícito, nunca silencioso. */
function unsupported(provider: string, op: string): ProviderResult<never> {
  return { ok: false, error: `Operação ${op} não suportada via provider layer (${provider}).` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe (legado read-only) — adapter sobre stripe-billing.ts
// ─────────────────────────────────────────────────────────────────────────────

const stripeProvider: BillingProviderPort = {
  name: "stripe",

  async createCustomer(params) {
    const res = await createStripeCustomer({
      email: params.email,
      name: params.name,
      taxId: params.taxId,
      metadata: { organization_id: params.organizationId },
    });
    if (!res.ok || !res.customerId) return { ok: false, error: res.error ?? "Falha ao criar customer." };
    return { ok: true, data: { customerId: res.customerId } };
  },

  // Checkout hospedado Stripe permanece no fluxo legado (EF create-billing-checkout).
  // deno-lint-ignore require-await
  async createCheckout() {
    return unsupported("stripe", "createCheckout — usar EF create-billing-checkout (legado)");
  },

  async createOneTimeCharge(params) {
    const res = await createStripeInvoice({
      customerId: params.providerCustomerId,
      amountCents: params.amountCents,
      description: params.description,
      daysUntilDue: params.daysUntilDue,
      metadata: { external_reference: params.externalReference },
    });
    if (!res.ok || !res.invoiceId) return { ok: false, error: res.error ?? "Falha ao criar cobrança." };
    return { ok: true, data: { paymentId: res.invoiceId, paymentUrl: res.hostedUrl } };
  },

  async createSubscription(params) {
    if (!params.providerPriceId) {
      return { ok: false, error: "Stripe exige providerPriceId (price_...) pré-cadastrado." };
    }
    const res = await createStripeSubscription({
      customerId: params.providerCustomerId,
      priceId: params.providerPriceId,
      trialDays: params.trialDays,
      metadata: { external_reference: params.externalReference, ...params.metadata },
    });
    if (!res.ok || !res.subscriptionId) return { ok: false, error: res.error ?? "Falha ao criar assinatura." };
    return { ok: true, data: { subscriptionId: res.subscriptionId } };
  },

  async cancelSubscription(providerSubscriptionId, atPeriodEnd) {
    const res = await cancelStripeSubscription(providerSubscriptionId, atPeriodEnd);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  },

  async getSubscription(providerSubscriptionId) {
    const res = await retrieveStripeSubscription(providerSubscriptionId);
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: "Assinatura não encontrada no Stripe." };
  },

  async getPayment(providerPaymentId) {
    const res = await retrieveStripeInvoice(providerPaymentId);
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: "Cobrança não encontrada no Stripe." };
  },

  // Stripe legado nunca usou refund via plataforma — sem suporte até precisar.
  // deno-lint-ignore require-await
  async refundPayment() {
    return unsupported("stripe", "refundPayment");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function getBillingProvider(name: BillingProviderName): BillingProviderPort {
  switch (name) {
    case "stripe":
      return stripeProvider;
    case "asaas":
      // AsaasBillingProvider chega na Fase 2 (_shared/asaas.ts). Erro explícito
      // até lá — flag asaas_enabled OFF impede qualquer caller de chegar aqui.
      throw new Error("AsaasBillingProvider ainda não implementado (Fase 2 do plano billing-asaas).");
  }
}

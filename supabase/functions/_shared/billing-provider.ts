/**
 * Camada abstrata de provedores de pagamento (Fase 1/2 billing-asaas).
 *
 * BillingProviderPort é o contrato único; implementações:
 *   - StripeBillingProvider (este arquivo): adapter fino sobre os helpers
 *     legados de stripe-billing.ts — comportamento IDÊNTICO ao atual, papel
 *     read-only/legado durante a migração.
 *   - AsaasBillingProvider (este arquivo, Fase 2): provedor principal novo,
 *     adapter fino sobre _shared/asaas.ts (cliente HTTP) + conversão
 *     centavos↔reais de _shared/asaas-core.ts (§9.1 de
 *     docs/billing-asaas/03-ASAAS-API-VERIFICADO.md).
 *
 * Regras:
 *   - Valores monetários de SAÍDA (params que o port recebe) SEMPRE em
 *     centavos inteiros — AsaasBillingProvider converte pra reais só na
 *     chamada ao asaas.ts. Exceção documentada: `getPayment`/`getSubscription`
 *     devolvem o payload cru do Asaas na fronteira do port — reais decimais,
 *     NÃO normalizados (ver comentário em cada método abaixo).
 *   - O caller NUNCA aceita preço vindo do request — carrega de billing_plans.
 *   - processWebhook fica FORA do port: cada provedor tem verificação própria
 *     (Stripe HMAC t=/v1= em stripe-webhook; Asaas token de header em
 *     asaas-webhook). O port cobre as operações imperativas.
 *
 * REDEPLOY: nenhuma EF importa este módulo ainda — os primeiros consumidores
 * prováveis são `asaas-webhook` e `process-asaas-reconcile` (ambos ainda
 * FASE 2, não Fase 4) — nada a adicionar no checklist de redeploy do
 * CLAUDE.md até uma EF de fato importar `getBillingProvider`/`AsaasBillingProvider`.
 */

import {
  cancelStripeSubscription,
  createStripeCustomer,
  createStripeInvoice,
  createStripeSubscription,
  retrieveStripeInvoice,
  retrieveStripeSubscription,
} from "./stripe-billing.ts";
import {
  createAsaasCheckout,
  createAsaasCustomer,
  createAsaasPayment,
  createAsaasSubscription,
  deleteAsaasSubscription,
  getAsaasPayment,
  getAsaasSubscription,
  refundAsaasPayment,
  updateAsaasSubscription,
  type AsaasCheckoutParams,
} from "./asaas.ts";
import { centsToAsaasValue } from "./asaas-core.ts";
import { jsonLog } from "./security.ts";

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
// Asaas — provedor principal novo, adapter sobre _shared/asaas.ts
//
// Nenhum retorno lança — todo caminho, incluindo erro inesperado (ex.: um
// `amountCents` inválido estourando em centsToAsaasValue), é traduzido pra
// ProviderResult{ok:false}. O `safely()` abaixo é o guard disso: os callers
// deste port contam com "nunca lançar" (mesmo invariante do stripeProvider).
// ─────────────────────────────────────────────────────────────────────────────

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

// Sem dueDate explícito, mesma janela default do createStripeInvoice
// (stripe-billing.ts) — mantém paridade de comportamento entre provedores.
const DEFAULT_DAYS_UNTIL_DUE = 7;

/**
 * YYYY-MM-DD do dia de calendário BRT, N dias à frente de agora. Deno roda em
 * UTC (mesmo padrão de _shared/giftback.ts e _shared/availability.ts) — sem
 * o ajuste, a virada de dia entre 21h e meia-noite BRT erraria a data de
 * vencimento em ±1 dia.
 */
function isoDateInDaysBrt(days: number): string {
  const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
  nowBrt.setUTCDate(nowBrt.getUTCDate() + days);
  return nowBrt.toISOString().slice(0, 10);
}

/**
 * Envolve cada método do provider: captura qualquer exceção (ex.:
 * centsToAsaasValue lançando em amountCents corrompido) e traduz pra
 * ProviderResult — nunca deixa escapar um throw pro caller. Detalhe técnico
 * vai pro jsonLog; o cliente nunca vê stack/mensagem crua.
 */
async function safely<T>(op: string, fn: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
  try {
    return await fn();
  } catch (err) {
    jsonLog("error", { evt: "asaas_provider_unexpected_error", op, error: String(err) });
    // Não afirmar "comunicar com o Asaas" — a exceção pode ser local (ex.:
    // centsToAsaasValue rejeitando um amountCents inválido ANTES de qualquer
    // request sair), então "falha ao comunicar" apontaria o operador pra um
    // problema de rede/upstream que não necessariamente ocorreu.
    return { ok: false, error: "Falha inesperada ao processar a operação no Asaas." };
  }
}

const asaasProvider: BillingProviderPort = {
  name: "asaas",

  async createCustomer(params) {
    return safely<{ customerId: string }>("createCustomer", async () => {
      // cpfCnpj é OBRIGATÓRIO no Asaas (§9) mas opcional na porta (Stripe não
      // exige) — validar aqui e devolver erro claro SEM chamar a API, em vez
      // de deixar o Asaas rejeitar com um 400 genérico.
      if (!params.taxId?.trim()) {
        return { ok: false, error: "CPF/CNPJ é obrigatório para cadastrar cliente no Asaas." };
      }
      if (!params.name?.trim()) {
        return { ok: false, error: "Nome é obrigatório para cadastrar cliente no Asaas." };
      }
      const res = await createAsaasCustomer({
        name: params.name,
        cpfCnpj: params.taxId,
        email: params.email,
        externalReference: params.organizationId,
      });
      if (!res.ok || !res.customerId) return { ok: false, error: res.error ?? "Falha ao criar cliente no Asaas." };
      return { ok: true, data: { customerId: res.customerId } };
    });
  },

  async createCheckout(params) {
    return safely<{ checkoutId?: string; url: string }>("createCheckout", async () => {
      if (!params.successUrl || !params.cancelUrl) {
        return { ok: false, error: "URL de sucesso e de cancelamento são obrigatórias para o checkout." };
      }
      const value = centsToAsaasValue(params.amountCents);
      const isSubscription = params.mode === "subscription";

      const checkoutParams: AsaasCheckoutParams = {
        // Único conjunto aceito pelo produto de checkout hospedado — sem
        // BOLETO (§9). Deixar os dois habilitados dá ao pagador a escolha.
        billingTypes: ["CREDIT_CARD", "PIX"],
        chargeTypes: isSubscription ? ["RECURRENT"] : ["DETACHED"],
        callback: { successUrl: params.successUrl, cancelUrl: params.cancelUrl },
        items: [
          {
            name: params.description.slice(0, 30),
            quantity: 1,
            value,
            description: params.description.slice(0, 150),
          },
        ],
        externalReference: params.externalReference,
      };
      if (isSubscription) {
        // `subscription` obrigatório quando chargeTypes inclui RECURRENT
        // (§9). Shape exato do objeto NÃO documentado pro checkout — `cycle`
        // é o único campo que usamos aqui por analogia ao endpoint irmão
        // POST /v3/subscriptions (que exige `cycle`, §9), não porque o §9
        // afirme isso pro objeto `subscription` do checkout. Validar no
        // sandbox antes da Fase 4.
        checkoutParams.subscription = { cycle: "MONTHLY" };
      }

      const res = await createAsaasCheckout(checkoutParams);
      if (!res.ok || !res.link) return { ok: false, error: res.error ?? "Falha ao criar checkout no Asaas." };
      return { ok: true, data: { checkoutId: res.checkoutId, url: res.link } };
    });
  },

  async createOneTimeCharge(params) {
    return safely<{ paymentId: string; paymentUrl?: string }>("createOneTimeCharge", async () => {
      const value = centsToAsaasValue(params.amountCents);
      const dueDate = isoDateInDaysBrt(params.daysUntilDue ?? DEFAULT_DAYS_UNTIL_DUE);
      const res = await createAsaasPayment({
        customer: params.providerCustomerId,
        // UNDEFINED é um valor válido do enum billingType (§9) — a doc NÃO
        // descreve o comportamento pro pagador. Suposição nossa, NÃO
        // VERIFICADA: deixa o Asaas oferecer todos os métodos habilitados da
        // conta na fatura pro pagador escolher, em vez de travar um método
        // fixo aqui; validar no sandbox antes da Fase 4.
        billingType: "UNDEFINED",
        value,
        dueDate,
        // description máx 500 (§9) — mesmo truncamento aplicado aos campos
        // do item de checkout acima (name 30 / description 150).
        description: params.description.slice(0, 500),
        externalReference: params.externalReference,
      });
      if (!res.ok || !res.paymentId) return { ok: false, error: res.error ?? "Falha ao criar cobrança no Asaas." };
      return { ok: true, data: { paymentId: res.paymentId, paymentUrl: res.invoiceUrl } };
    });
  },

  async createSubscription(params) {
    return safely<{ subscriptionId: string }>("createSubscription", async () => {
      const value = centsToAsaasValue(params.amountCents);
      // Asaas não tem trial nativo (diferente do trial_period_days da
      // Stripe) — aproximamos adiando nextDueDate por trialDays: a
      // assinatura já nasce ACTIVE, mas a primeira cobrança real só é
      // emitida nessa data. Não é idêntico ao trial da Stripe (que suspende
      // a cobrança até o fim do trial mantendo o registro em "trialing");
      // aqui o efeito prático equivalente (sem cobrança até a data) é
      // alcançado só pelo adiamento da data de vencimento.
      const trialDays = params.trialDays && params.trialDays > 0 ? params.trialDays : 0;
      const nextDueDate = isoDateInDaysBrt(trialDays);
      const res = await createAsaasSubscription({
        customer: params.providerCustomerId,
        // Mesmo raciocínio do createOneTimeCharge: deixa o pagador escolher
        // o método na cobrança gerada a cada ciclo.
        billingType: "UNDEFINED",
        value,
        nextDueDate,
        cycle: "MONTHLY",
        externalReference: params.externalReference,
        // providerPriceId é conceito Stripe (price pré-cadastrado); Asaas
        // manda `value` cru, então params.providerPriceId é ignorado aqui.
      });
      if (!res.ok || !res.subscriptionId) return { ok: false, error: res.error ?? "Falha ao criar assinatura no Asaas." };
      return { ok: true, data: { subscriptionId: res.subscriptionId } };
    });
  },

  async cancelSubscription(providerSubscriptionId, atPeriodEnd) {
    return safely<Record<string, unknown>>("cancelSubscription", async () => {
      if (atPeriodEnd) {
        // Não existe cancel_at_period_end no Asaas (§9): INACTIVE interrompe
        // a geração de cobranças futuras mas preserva o registro e as
        // cobranças já emitidas — o acesso do período pago continua
        // governado por billing_subscriptions.current_period_end no nosso
        // banco, não pelo Asaas.
        const res = await updateAsaasSubscription(providerSubscriptionId, { status: "INACTIVE" });
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      }
      // Cancelamento imediato: DELETE encerra a assinatura E remove as
      // cobranças pendentes/vencidas em aberto (§9) — só para quando o
      // cancelamento deve ser instantâneo, sem cobrança residual.
      const res = await deleteAsaasSubscription(providerSubscriptionId);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    });
  },

  async getSubscription(providerSubscriptionId) {
    return safely<Record<string, unknown>>("getSubscription", async () => {
      const res = await getAsaasSubscription(providerSubscriptionId);
      // Passthrough do payload cru do Asaas (mesmo padrão do stripeProvider)
      // — ATENÇÃO: ao contrário do Stripe (já em centavos), campos monetários
      // aqui (`value`, `netValue`, etc.) vêm em REAIS decimais (§9.1). Quem
      // consumir precisa passar por asaasValueToCents antes de tratar como
      // amountCents.
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: "Assinatura não encontrada no Asaas." };
    });
  },

  async getPayment(providerPaymentId) {
    return safely<Record<string, unknown>>("getPayment", async () => {
      const res = await getAsaasPayment(providerPaymentId);
      // Mesma ressalva do getSubscription acima: `value`/`netValue`/etc. no
      // payload cru estão em reais decimais, não em centavos.
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: "Cobrança não encontrada no Asaas." };
    });
  },

  async refundPayment(providerPaymentId, amountCents) {
    return safely<Record<string, unknown>>("refundPayment", async () => {
      // Sem amountCents = estorno total (Asaas usa ausência de `value` como
      // sinal, não um valor explícito de "tudo").
      const params = amountCents !== undefined ? { value: centsToAsaasValue(amountCents) } : undefined;
      const res = await refundAsaasPayment(providerPaymentId, params);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    });
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
      return asaasProvider;
  }
}

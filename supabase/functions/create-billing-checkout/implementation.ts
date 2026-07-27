import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { getBillingProvider } from "../_shared/billing-provider.ts";
import { jsonLog } from "../_shared/security.ts";
import {
  loadImplementationPlan,
  openImplementationCheckout,
} from "../_shared/implementation-checkout.ts";
import {
  supabase,
  requireAsaasEnabled,
  resolveAsaasCustomer,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  CHECKOUT_EXPIRY_MINUTES,
  type CheckoutContext,
} from "./context.ts";
import type { HandlerResult } from "./subscription.ts";

export async function handleImplementation(ctx: CheckoutContext): Promise<HandlerResult> {
  // Gate de visibilidade. Repetido no servidor mesmo com o botão escondido: o
  // frontend não é fronteira de autorização.
  const flag = await checkFlagEnabled("whatsapp_implementation_flow");
  if (!flag.enabled) {
    jsonLog(flag.readFailed ? "error" : "info", {
      reqId: ctx.reqId,
      evt: "implementation_flow_disabled",
      orgId: ctx.organizationId,
      readFailed: flag.readFailed,
    });
    return { status: 403, body: { error: "Este produto ainda não está disponível para contratação." } };
  }

  const asaasGate = await requireAsaasEnabled(ctx.reqId, ctx.organizationId, ctx.plan?.id ?? null);
  if (!asaasGate.ok) return { status: asaasGate.status, body: { error: asaasGate.error } };

  // O plano vem do SLUG, não do plan_id do request: a implantação é um produto
  // único, e aceitar qualquer plan_id aqui deixaria o navegador escolher o
  // preço da "implantação" apontando para outro produto do catálogo.
  const plan = await loadImplementationPlan(supabase);
  if (!plan) return { status: 404, body: { error: "Produto não encontrado." } };

  const asaas = getBillingProvider("asaas");
  const customer = await resolveAsaasCustomer(ctx, (a) => asaas.createCustomer(a));
  if (!customer.ok) return { status: customer.status, body: { error: customer.error } };

  const result = await openImplementationCheckout({
    supabase,
    reqId: ctx.reqId,
    organizationId: ctx.organizationId,
    plan,
    asaasCustomerId: customer.customerId,
    successUrl: `${ctx.successBase}?session=success`,
    cancelUrl: `${ctx.successBase}?session=cancel`,
    minutesToExpire: CHECKOUT_EXPIRY_MINUTES,
    createdBy: ctx.callerId,
    // Injetadas com o `supabase` desta EF — o módulo de sessão não instancia
    // cliente próprio, para que as duas EFs usem o service_role já criado.
    reserve: (a) => reserveCheckoutSession(supabase, a),
    finalize: (id, a) => finalizeCheckoutSession(supabase, id, a),
    fail: (id) => failCheckoutSession(supabase, id),
  });

  if (!result.ok) return { status: result.status, body: { error: result.error } };
  return {
    status: 200,
    body: { success: true, url: result.url, session_id: result.providerCheckoutId },
  };
}

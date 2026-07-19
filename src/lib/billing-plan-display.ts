/**
 * Derivações puras de apresentação de plano de billing.
 *
 * Separado de `@/types/billing` (que guarda os mapas de label) porque aqui mora
 * LÓGICA — e lógica de billing errada custa dinheiro. Tudo aqui é função pura,
 * sem React e sem Supabase, então é coberto por billing-plan-display.test.ts.
 *
 * Invariante central: todo campo de `migration 063` é OPCIONAL no tipo
 * `BillingPlan`, porque uma EF antiga deployada pode não devolvê-lo. Cada
 * helper daqui normaliza o `undefined` para o mesmo default do banco — nunca
 * deixe um `plan.category` cru vazar pra UI.
 */
import type { BillingPlan, PlanBillingType, PlanCategory, BillingProviderName } from "@/types/billing";

/** Defaults espelhando os DEFAULTs da migration 063. */
const DEFAULT_CATEGORY: PlanCategory = "SYSTEM_SUBSCRIPTION";
const DEFAULT_PROVIDER: BillingProviderName = "stripe";
const DEFAULT_BILLING_TYPE: PlanBillingType = "recurring";

const CATEGORIES: readonly PlanCategory[] = [
  "SYSTEM_SUBSCRIPTION",
  "WHATSAPP_IMPLEMENTATION",
  "WHATSAPP_SUBSCRIPTION",
  "AI_CREDIT_PACKAGE",
  "TRIAL",
  "CUSTOM",
];

const PROVIDERS: readonly BillingProviderName[] = ["stripe", "asaas", "manual", "lifetime"];

type PlanLike = Pick<
  BillingPlan,
  "category" | "provider" | "billing_type" | "interval" | "amount_credited_cents"
>;

/**
 * Categoria normalizada. Valor desconhecido (banco à frente do frontend) cai no
 * default em vez de quebrar o render — o CHECK do Postgres é quem barra lixo.
 */
export function planCategory(plan: Pick<BillingPlan, "category">): PlanCategory {
  const raw = plan.category;
  return raw && CATEGORIES.includes(raw) ? raw : DEFAULT_CATEGORY;
}

export function planProvider(plan: Pick<BillingPlan, "provider">): BillingProviderName {
  const raw = plan.provider;
  return raw && PROVIDERS.includes(raw) ? raw : DEFAULT_PROVIDER;
}

export function planBillingType(plan: Pick<BillingPlan, "billing_type">): PlanBillingType {
  return plan.billing_type === "one_time" ? "one_time" : DEFAULT_BILLING_TYPE;
}

/**
 * Rótulo do intervalo — `null` quando o plano é cobrança única.
 *
 * Planos `one_time` carregam `interval='month'` no banco só porque a coluna é
 * NOT NULL com CHECK in ('month','year') e não existe valor neutro (ver
 * migration 065). Renderizar "Mensal" num pacote de crédito de R$ 70 diria ao
 * operador que o cliente é cobrado todo mês — mentira cara. `null` = a UI
 * mostra o rótulo de cobrança única no lugar.
 */
export function planIntervalLabel(plan: PlanLike): string | null {
  if (planBillingType(plan) === "one_time") return null;
  return plan.interval === "year" ? "Anual" : "Mensal";
}

/**
 * A seção de Price IDs da Stripe só faz sentido em plano `provider='stripe'`.
 * Plano Asaas não tem `price_...`; deixar os campos à vista convida o operador
 * a preencher o que nunca será lido.
 */
export function showsStripeConfig(plan: Pick<BillingPlan, "provider">): boolean {
  return planProvider(plan) === "stripe";
}

/** Só pacote de IA credita saldo — é o único que expõe "Valor creditado". */
export function isAiCreditPackage(plan: Pick<BillingPlan, "category">): boolean {
  return planCategory(plan) === "AI_CREDIT_PACKAGE";
}

/**
 * Planos ofertáveis na pricing table do cliente.
 *
 * Filtra DUAS coisas:
 * - `is_trial` — trial é aplicado automaticamente pelo `manage-organizations`,
 *   o cliente nunca escolhe (invariante herdado de PricingTable).
 * - categoria ≠ SYSTEM_SUBSCRIPTION — implantação de WhatsApp, instância e
 *   pacote de IA não são assinatura do sistema. Cada um ganha fluxo próprio
 *   (Fase 5 e Fase 7); listá-los como "plano" daria ao cliente um botão de
 *   contratar que nenhum checkout processa.
 */
export function isSelectableSystemPlan(
  plan: Pick<BillingPlan, "category" | "is_trial">,
): boolean {
  return !plan.is_trial && planCategory(plan) === "SYSTEM_SUBSCRIPTION";
}

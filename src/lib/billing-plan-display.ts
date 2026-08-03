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
 * Filtra TRÊS coisas:
 * - `active !== true` — plano despublicado. **Não é redundante com o filtro do
 *   servidor:** `manage-billing` action `list_plans` devolve `select("*")` SEM
 *   filtro de `active` para `platform_admin` (só o caller não-admin recebe
 *   `.eq("active", true)`). Sem esta linha, um admin abrindo `/g/<slug>/cobranca`
 *   de um cliente veria `sistema-reservas` e `plano-automacao` com botão de
 *   contratar — dois produtos que o checkout recusa com "Plano inativo.".
 *   Fail-CLOSED de propósito: campo ausente esconde o plano. Esconder um plano
 *   talvez ativo adia uma venda; oferecer um plano talvez inativo entrega um
 *   400 ao cliente depois do clique.
 * - `is_trial` — trial é aplicado automaticamente pelo `manage-organizations`,
 *   o cliente nunca escolhe.
 * - categoria ≠ SYSTEM_SUBSCRIPTION — implantação de WhatsApp, instância e
 *   pacote de IA não são assinatura do sistema. Cada um tem fluxo próprio;
 *   listá-los como "plano" daria um botão que nenhum checkout processa.
 */
export function isSelectableSystemPlan(
  plan: Pick<BillingPlan, "category" | "is_trial" | "active">,
): boolean {
  return plan.active === true && !plan.is_trial && planCategory(plan) === "SYSTEM_SUBSCRIPTION";
}

/**
 * `billing_plans.included_features` normalizado (migration 094).
 *
 * AUTORIZAÇÃO — o que o plano concede. **Nunca confundir com `plan.features`**,
 * que é copy de marketing renderizada no `PricingCard` e editada como textarea:
 * um administrador escrevendo a palavra "whatsapp" numa frase comercial não
 * pode conceder acesso a nada.
 *
 * Ausente ou `null` vira `[]` = plano legado, que resolve por categoria.
 */
export function planIncludedFeatures(
  plan: Pick<BillingPlan, "included_features">,
): string[] {
  const raw = plan.included_features;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Plano que declara franquia de IA não pode ser vendido nem ativado enquanto o
 * teto financeiro por ciclo (Plano D) não existir — `PLAN_AUTOMACAO_CHECKOUT =
 * NO-GO`.
 *
 * Espelha exatamente o CHECK `billing_plans_ai_plan_not_sellable_chk`
 * (migration 097), que olha **só** `'ai'`. Divergir daqui faria o painel avisar
 * sobre um bloqueio que o banco não aplica — ou, pior, deixar de avisar sobre
 * um que ele aplica, e o admin descobriria pelo 23514.
 */
export function planBlockedFromSale(
  plan: Pick<BillingPlan, "included_features">,
): boolean {
  return planIncludedFeatures(plan).includes("ai");
}

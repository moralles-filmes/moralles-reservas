// Núcleo puro (Fase 6b): atribuição de receita e margem. ZERO IMPORTS.
//
// A política existe porque N instâncias por organização é PERMITIDO (§5).
// Nunca copiar a assinatura para cada instância (inflaria em N×) e nunca
// ratear igualmente sem decisão comercial explícita e versionada.
//
// PLAN_COMPONENT e o componente contratual do PACOTE DE AUTOMACAO (WhatsApp +
// IA + operacao relacionada) — NAO e receita pura da instancia Z-API.
// Consequencias:
//   - a margem parcial desta fase e `componente - custo Z-API`;
//   - a margem CONSOLIDADA correta precisa descontar tambem o custo de IA,
//     integrado pelo Plano D;
//   - o mesmo componente NUNCA e somado de novo em outra margem;
//   - com N instancias, AMBIGUOUS_MULTI_INSTANCE — nunca R$350 por instancia.

export type RevenueSource =
  | "SUBSCRIPTION_SOLE_INSTANCE"
  | "AMBIGUOUS_MULTI_INSTANCE"
  | "LIFETIME_OVERRIDE"
  | "NO_ENTITLEMENT"
  | "PLAN_COMPONENT";

/**
 * UNIAO DISCRIMINADA. `INVALID_INPUT` NAO e uma origem de receita: e a
 * afirmacao de que os fatos recebidos sao internamente inconsistentes.
 *
 * NO_ENTITLEMENT significa "nao existe fonte valida de receita" — resultado
 * comercialmente VALIDO, persistivel no historico economico. Contagem zero
 * dentro de um calculo feito PARA O CICLO DE UMA INSTANCIA significa outra
 * coisa: erro de input ou de consulta. Colapsar os dois deixaria um caller
 * incompleto gravar inconsistencia como se fosse situacao comercial.
 *
 * Nenhum valor novo entra no CHECK de `revenue_source` do banco: `INVALID_INPUT`
 * mora no discriminante, nunca em `revenueSource`.
 */
export type AttributedRevenue = {
  kind: "ATTRIBUTED";
  customerRevenueCents: number | null;
  revenueSource: RevenueSource;
};

export type RevenueAttribution =
  | AttributedRevenue
  | { kind: "INVALID_INPUT"; reasonCode: "NO_ACTIVE_INSTANCE" };

export type RevenueInput = {
  activeInstanceCount: number;
  subscriptionAmountCents: number | null;
  hasLifetimeWhatsappOverride: boolean;
  planWhatsappComponentCents?: number | null;
};

const attributed = (
  customerRevenueCents: number | null,
  revenueSource: RevenueSource,
): RevenueAttribution => ({ kind: "ATTRIBUTED", customerRevenueCents, revenueSource });

export function attributeRevenue(input: RevenueInput): RevenueAttribution {
  // attributeRevenue e chamada POR CICLO DE INSTANCIA: contagem < 1 e erro de
  // programacao, nao cenario de negocio. Vem ANTES ate do override vitalicio —
  // "receita zero verdadeira" tambem e uma afirmacao, e nao ha o que afirmar
  // sobre uma instancia que nao existe. (A forma `!(x >= 1)` tambem barra NaN.)
  if (!(input.activeInstanceCount >= 1)) {
    return { kind: "INVALID_INPUT", reasonCode: "NO_ACTIVE_INSTANCE" };
  }

  // Override PRIMEIRO entre os resultados atribuiveis: cortesia vitalicia e
  // decisao comercial que substitui a assinatura E o componente, e 0 aqui e
  // zero VERDADEIRO — nao "nao sei".
  if (input.hasLifetimeWhatsappOverride) return attributed(0, "LIFETIME_OVERRIDE");

  const component = input.planWhatsappComponentCents;
  if (component !== null && component !== undefined) {
    if (input.activeInstanceCount > 1) return attributed(null, "AMBIGUOUS_MULTI_INSTANCE");
    return attributed(component, "PLAN_COMPONENT");
  }

  if (input.subscriptionAmountCents === null || input.subscriptionAmountCents === undefined) {
    return attributed(null, "NO_ENTITLEMENT");
  }
  if (input.activeInstanceCount > 1) return attributed(null, "AMBIGUOUS_MULTI_INSTANCE");
  return attributed(input.subscriptionAmountCents, "SUBSCRIPTION_SOLE_INSTANCE");
}

export function grossMarginCents(
  revenueCents: number | null,
  costCents: number | null,
): number | null {
  if (revenueCents === null || revenueCents === undefined) return null;
  if (costCents === null || costCents === undefined) return null;
  return revenueCents - costCents;
}

export type MarginDisplay =
  | { kind: "PERCENT"; value: number }
  | { kind: "NOT_APPLICABLE" }
  | { kind: "PENDING" };

/**
 * O percentual é DERIVADO, nunca armazenado: um percentual gravado só pode
 * divergir dos dois inteiros que já estão persistidos.
 */
export function grossMarginDisplay(
  revenueCents: number | null,
  costCents: number | null,
): MarginDisplay {
  if (revenueCents === null || revenueCents === undefined) return { kind: "PENDING" };
  if (costCents === null || costCents === undefined) return { kind: "PENDING" };
  if (revenueCents === 0) return { kind: "NOT_APPLICABLE" };
  return { kind: "PERCENT", value: ((revenueCents - costCents) / revenueCents) * 100 };
}

/**
 * Margem consolidada da ORGANIZAÇÃO. Custo desconhecido em qualquer instância
 * impede a consolidação — somar só o que se conhece produziria uma margem
 * otimista que parece um fato.
 */
export function consolidateOrgMargin(
  costs: (number | null)[],
  revenueCents: number | null,
): { knownCostCents: number; unknownCostInstances: number; marginCents: number | null } {
  let knownCostCents = 0;
  let unknownCostInstances = 0;
  for (const c of costs) {
    if (c === null || c === undefined) unknownCostInstances++;
    else knownCostCents += c;
  }
  const marginCents =
    unknownCostInstances > 0 || revenueCents === null || revenueCents === undefined
      ? null
      : revenueCents - knownCostCents;
  return { knownCostCents, unknownCostInstances, marginCents };
}

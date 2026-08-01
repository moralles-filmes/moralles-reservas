// Núcleo puro (Fase 6b): atribuição de receita e margem. ZERO IMPORTS.
//
// A política existe porque N instâncias por organização é PERMITIDO (§5).
// Nunca copiar a assinatura para cada instância (inflaria em N×) e nunca
// ratear igualmente sem decisão comercial explícita e versionada.

export type RevenueSource =
  | "SUBSCRIPTION_SOLE_INSTANCE"
  | "AMBIGUOUS_MULTI_INSTANCE"
  | "LIFETIME_OVERRIDE"
  | "NO_ENTITLEMENT";

export type RevenueAttribution = {
  customerRevenueCents: number | null;
  revenueSource: RevenueSource;
};

export type RevenueInput = {
  activeInstanceCount: number;
  subscriptionAmountCents: number | null;
  hasLifetimeWhatsappOverride: boolean;
};

export function attributeRevenue(input: RevenueInput): RevenueAttribution {
  // Override PRIMEIRO: cortesia vitalícia é decisão comercial que substitui a
  // assinatura, e 0 aqui é zero VERDADEIRO — não "não sei".
  if (input.hasLifetimeWhatsappOverride) {
    return { customerRevenueCents: 0, revenueSource: "LIFETIME_OVERRIDE" };
  }
  if (input.subscriptionAmountCents === null || input.subscriptionAmountCents === undefined) {
    return { customerRevenueCents: null, revenueSource: "NO_ENTITLEMENT" };
  }
  if (input.activeInstanceCount > 1) {
    return { customerRevenueCents: null, revenueSource: "AMBIGUOUS_MULTI_INSTANCE" };
  }
  return {
    customerRevenueCents: input.subscriptionAmountCents,
    revenueSource: "SUBSCRIPTION_SOLE_INSTANCE",
  };
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

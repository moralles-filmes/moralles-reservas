/**
 * Núcleo puro do cancelamento de assinatura: decide PARA ONDE roteia e QUE
 * colunas escrever. Sem I/O, sem Supabase, sem provedor.
 *
 * Existe porque `manage-billing` cancelava chamando a Stripe direto, guardado
 * por `if (sub.stripe_subscription_id)`. Numa assinatura Asaas essa coluna é
 * null: o provedor nunca era chamado, o banco gravava `canceled`, e o Asaas
 * seguia cobrando todo mês com a tela dizendo que o cliente havia cancelado.
 * Ver docs/billing-asaas/08-BUG-CANCELAMENTO-ASAAS-NAO-PROPAGA.md.
 */

/** O que de fato aconteceu no provedor — não o que o caller pediu. */
export type CancelEffective = "immediate" | "at_period_end";

export type CancelTarget =
  | { kind: "provider"; provider: "stripe" | "asaas"; providerSubscriptionId: string }
  | { kind: "local_only"; provider: "manual" | "lifetime" }
  | { kind: "unroutable"; provider: string; reason: "missing_provider_id" | "unknown_provider" };

export interface CancelSubscriptionRow {
  provider: string | null;
  provider_subscription_id: string | null;
  stripe_subscription_id: string | null;
}

/** Provedores com contraparte externa a cancelar. */
const EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set(["stripe", "asaas"]);

/** Provedores sem contraparte externa — cancelar só no banco é legítimo. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["manual", "lifetime"]);

export function decideCancelTarget(sub: CancelSubscriptionRow): CancelTarget {
  // `provider` é NOT NULL com default 'stripe' no banco (migration 063), mas
  // chega null se o SELECT omitir a coluna. Tratar como desconhecido em vez de
  // assumir 'stripe' — assumir é exatamente como o bug original agia.
  const provider = sub.provider ?? "";

  if (LOCAL_PROVIDERS.has(provider)) {
    return { kind: "local_only", provider: provider as "manual" | "lifetime" };
  }

  if (!EXTERNAL_PROVIDERS.has(provider)) {
    return { kind: "unroutable", provider, reason: "unknown_provider" };
  }

  // Fallback SÓ para stripe: a migration 063 backfillou
  // provider_subscription_id a partir de stripe_subscription_id, e linhas
  // anteriores podem ter só a coluna velha. Usar um `sub_` da Stripe como id de
  // assinatura Asaas cancelaria o objeto errado — ou nenhum.
  const id = sub.provider_subscription_id ?? (provider === "stripe" ? sub.stripe_subscription_id : null);
  if (!id) {
    return { kind: "unroutable", provider, reason: "missing_provider_id" };
  }

  return { kind: "provider", provider: provider as "stripe" | "asaas", providerSubscriptionId: id };
}

export interface LocalCancelPatch {
  status?: "canceled";
  canceled_at?: string;
  cancel_at_period_end: boolean;
  updated_at: string;
}

/**
 * Colunas a gravar, derivadas do efeito REAL devolvido pelo provedor.
 *
 * `at_period_end` não escreve `status` de propósito: quem encerra o acesso
 * nesse caminho é o webhook `customer.subscription.deleted` da Stripe. Nenhum
 * provedor sem esse evento deve devolver `at_period_end`.
 */
export function localCancelPatch(effective: CancelEffective, nowIso: string): LocalCancelPatch {
  if (effective === "at_period_end") {
    return { cancel_at_period_end: true, updated_at: nowIso };
  }
  return {
    status: "canceled",
    canceled_at: nowIso,
    cancel_at_period_end: false,
    updated_at: nowIso,
  };
}

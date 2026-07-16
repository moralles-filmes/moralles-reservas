/**
 * resolveOrgEntitlements — carrega os dados da organização e delega ao núcleo
 * puro (entitlements-core.ts, testado via vitest).
 *
 * Fase 1 billing-asaas: read-only, nenhum guard consome ainda. A partir da
 * Fase 4 (flag entitlements_enforced), BillingGuard/EFs passam a usar isto no
 * lugar do billing_status binário.
 *
 * REDEPLOY: quando uma EF passar a importar este módulo, adicionar a linha
 * correspondente no checklist de redeploy do CLAUDE.md (entitlements.ts +
 * entitlements-core.ts mudam juntos).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  resolveEntitlements,
  type EntitlementOverrideInput,
  type EntitlementSubscriptionInput,
  type OrgEntitlements,
} from "./entitlements-core.ts";

export type { OrgEntitlements };

interface SubscriptionRow {
  status: string;
  current_period_end: string | null;
  billing_plans: { category: string | null } | { category: string | null }[] | null;
}

/**
 * @param aiWalletBalanceCents omitir até a Fase 7 (carteira). Quando a carteira
 *   existir, o caller injeta o saldo (evita SELECT extra aqui e mantém o core puro).
 */
export async function resolveOrgEntitlements(
  supabase: SupabaseClient,
  organizationId: string,
  aiWalletBalanceCents?: number | null,
): Promise<OrgEntitlements> {
  const [orgRes, overridesRes, subsRes] = await Promise.all([
    supabase
      .from("organizations")
      .select("billing_status, trial_ends_at")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("organization_entitlement_overrides")
      .select("feature, enabled, grant_type, starts_at, ends_at, revoked_at")
      .eq("organization_id", organizationId)
      .is("revoked_at", null),
    supabase
      .from("billing_subscriptions")
      .select("status, current_period_end, billing_plans(category)")
      .eq("organization_id", organizationId),
  ]);

  const org = orgRes.data as { billing_status: string; trial_ends_at: string | null } | null;

  const overrides = (overridesRes.data ?? []) as EntitlementOverrideInput[];

  const subscriptions: EntitlementSubscriptionInput[] = ((subsRes.data ?? []) as SubscriptionRow[]).map(
    (row) => {
      // PostgREST devolve relação aninhada como objeto OU array — normalizar
      const plan = Array.isArray(row.billing_plans) ? row.billing_plans[0] : row.billing_plans;
      return {
        status: row.status,
        category: plan?.category ?? "SYSTEM_SUBSCRIPTION",
        current_period_end: row.current_period_end,
      };
    },
  );

  return resolveEntitlements({
    billingStatus: org?.billing_status ?? "active",
    trialEndsAt: org?.trial_ends_at ?? null,
    overrides,
    subscriptions,
    aiWalletBalanceCents,
  });
}

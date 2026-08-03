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
 *
 * ORDEM: a migration 094 (included_features) precisa estar aplicada ANTES do
 * deploy desta versao. Coluna inexistente vira 400 do PostgREST -> readFailed.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import {
  resolveEntitlements,
  type AiFranchiseInput,
  type EntitlementOverrideInput,
  type EntitlementSubscriptionInput,
  type OrgEntitlements,
} from "./entitlements-core.ts";

export type { OrgEntitlements, AiFranchiseInput };

/**
 * `OrgEntitlements` + `readFailed`. Mudança ADITIVA (Rodada de correção 1,
 * Task 14 I1): `entitlements-core.ts` é núcleo puro testado por vitest e não
 * ganha o campo — o wrapper é montado aqui, fora do core.
 *
 * `readFailed=true` significa que uma ou mais das 3 leituras (organizations /
 * organization_entitlement_overrides / billing_subscriptions) falhou, e o
 * objeto abaixo foi resolvido com os defaults seguros de quem NÃO leu
 * (`overrides=[]`, `subscriptions=[]`, `billingStatus='active'`) — ou seja,
 * pode estar SUBESTIMANDO o acesso real (uma cortesia vitalícia real vira
 * `allowed:false` se a leitura de overrides falhar). Caller que usa o
 * resultado só para permitir/negar (fail-closed já é a direção segura) pode
 * ignorar o campo; caller que AFIRMA um número/estado pro cliente (ex.:
 * `get_service_status`) tem que checar antes de responder 200.
 */
export interface OrgEntitlementsResult extends OrgEntitlements {
  readFailed: boolean;
}

interface SubscriptionRow {
  status: string;
  current_period_end: string | null;
  billing_plans:
    | { category: string | null; included_features: string[] | null }
    | { category: string | null; included_features: string[] | null }[]
    | null;
}

/**
 * @param aiWalletBalanceCents carteira LEGADA. Omitir para organizações no
 *   modelo de dois planos.
 * @param aiFranchise Plano D: estado do orçamento do ciclo. Omitir quando o
 *   caller só precisa saber SE há IA (catálogo, painel) — ausente significa
 *   "não consultado", nunca "esgotado". O caller que vai gastar (webhook) lê o
 *   orçamento via ai-budget-gate.ts e injeta aqui, mantendo o núcleo puro.
 */
export async function resolveOrgEntitlements(
  supabase: SupabaseClient,
  organizationId: string,
  aiWalletBalanceCents?: number | null,
  aiFranchise?: AiFranchiseInput,
): Promise<OrgEntitlementsResult> {
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
      .select("status, current_period_end, billing_plans(category, included_features)")
      .eq("organization_id", organizationId),
  ]);

  // Nenhuma das 3 rejeita a Promise (supabase-js resolve {data:null, error}
  // em erro) — sem checar `.error` explicitamente, uma leitura que falha vira
  // silenciosamente "organização sem override/sem assinatura", o mesmo erro
  // de classe que subsRes.error engolido em get_service_status já corrigiu
  // uma camada acima.
  const readFailed = !!(orgRes.error || overridesRes.error || subsRes.error);
  if (readFailed) {
    jsonLog("warn", {
      evt: "entitlements_read_failed",
      org: organizationId,
      orgErr: orgRes.error?.message ?? null,
      overridesErr: overridesRes.error?.message ?? null,
      subsErr: subsRes.error?.message ?? null,
    });
  }

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
        // Coluna ausente (EF deployada antes da migration) vira [] = legado.
        // O fail-closed real desse caminho é `readFailed`, já tratado acima.
        includedFeatures: plan?.included_features ?? [],
      };
    },
  );

  return {
    ...resolveEntitlements({
      billingStatus: org?.billing_status ?? "active",
      trialEndsAt: org?.trial_ends_at ?? null,
      overrides,
      subscriptions,
      aiWalletBalanceCents,
      aiFranchise,
    }),
    readFailed,
  };
}

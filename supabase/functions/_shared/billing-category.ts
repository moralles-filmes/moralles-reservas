/**
 * "Essa fatura/assinatura é do SISTEMA?" — fonte única do sweep da Fase 5a.
 *
 * INVARIANTE que este módulo protege: só assinatura/fatura de categoria
 * SYSTEM_SUBSCRIPTION pode escrever organizations.billing_status. A coluna
 * representa o acesso ao sistema; a instância de WhatsApp tem estado próprio.
 *
 * Existe como módulo (e não como cópia em cada worker) porque a pergunta é a
 * mesma em cinco arquivos, e foi justamente a ausência dessa pergunta,
 * repetida, que criou o bug.
 *
 * REDEPLOY: qualquer mudança aqui exige redeploy de process-billing-overdue,
 * process-billing-reminders, process-billing-unblock, process-trial-expiry,
 * process-billing-reconcile e manage-billing.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseExternalReference } from "./asaas-billing-events.ts";
import { jsonLog } from "./security.ts";

export const SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION";

export async function planCategoryOf(
  supabase: SupabaseClient,
  planId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("billing_plans")
    .select("category")
    .eq("id", planId)
    .maybeSingle();
  if (error) {
    jsonLog("warn", { evt: "plan_category_read_failed", plan_id: planId, err: error.message });
    return null;
  }
  return (data?.category as string | undefined) ?? null;
}

export async function isSystemSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("billing_plans!inner(category)")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error || !data) {
    // Falha de leitura NÃO vira "é de sistema": errar para o lado de não mexer
    // em billing_status é o lado seguro (o pior caso é não bloquear alguém que
    // deveria ser bloqueado, e o worker roda de novo amanhã).
    jsonLog("warn", {
      evt: "subscription_category_read_failed",
      subscription_id: subscriptionId,
      err: error?.message ?? "not_found",
    });
    return false;
  }
  const plan = Array.isArray(data.billing_plans) ? data.billing_plans[0] : data.billing_plans;
  return (plan as { category?: string } | null)?.category === SYSTEM_CATEGORY;
}

export interface InvoiceCategoryInput {
  billing_subscription_id?: string | null;
  external_reference?: string | null;
  purpose?: string | null;
}

/**
 * Uma fatura é "de sistema" quando o plano por trás dela tem categoria
 * SYSTEM_SUBSCRIPTION. Três caminhos, nesta ordem:
 *
 *  1. billing_subscription_id → categoria do plano da assinatura (mais forte);
 *  2. external_reference → plan:<uuid> → categoria (o checkout hospedado grava
 *     esse texto; a primeira cobrança costuma nascer SEM billing_subscription_id);
 *  3. sem nenhum dos dois → TRUE, por compatibilidade.
 *
 * O default `true` é deliberado: toda fatura anterior à Fase 5a é de sistema, e
 * devolver false as tiraria da inadimplência em silêncio — trocaria um bug
 * (bloquear demais) por outro pior (nunca bloquear). Faturas de WhatsApp nascem
 * com purpose='subscription' e external_reference preenchido, então caem no
 * caminho 2.
 */
export async function isSystemInvoice(
  supabase: SupabaseClient,
  invoice: InvoiceCategoryInput,
): Promise<boolean> {
  // Implantação e recarga de IA nunca governam o acesso ao sistema.
  if (invoice.purpose === "implementation" || invoice.purpose === "ai_topup") {
    return false;
  }

  if (invoice.billing_subscription_id) {
    return await isSystemSubscription(supabase, invoice.billing_subscription_id);
  }

  const parsed = parseExternalReference(invoice.external_reference ?? null);
  if (parsed?.planId) {
    const category = await planCategoryOf(supabase, parsed.planId);
    // Categoria ilegível cai no default de compatibilidade, não em false.
    if (category !== null) return category === SYSTEM_CATEGORY;
  }

  return true;
}

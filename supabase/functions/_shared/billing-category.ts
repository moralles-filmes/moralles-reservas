/**
 * "Essa fatura/assinatura é do SISTEMA?" — fonte única do sweep da Fase 5a.
 *
 * INVARIANTE que este módulo protege: só obrigação inequivocamente classificada
 * como SYSTEM_SUBSCRIPTION pode escrever organizations.billing_status. A coluna
 * representa o acesso ao sistema; a instância de WhatsApp tem estado próprio.
 *
 * Existe como módulo (e não como cópia em cada worker) porque a pergunta é a
 * mesma em cinco arquivos, e foi justamente a ausência dessa pergunta,
 * repetida, que criou o bug.
 *
 * DIVISÃO DE RESPONSABILIDADE (hotfix pré-6b do Risco 7): a DECISÃO vive em
 * `billing-category-core.ts`, núcleo puro e testado. Este arquivo faz só I/O:
 * busca os fatos, normaliza, chama o núcleo e devolve o veredito. Antes a
 * decisão morava aqui, acoplada ao SupabaseClient, e por isso era o único
 * invariante de grande raio do billing sem um teste sequer.
 *
 * REDEPLOY: qualquer mudança aqui OU no núcleo exige redeploy de
 * process-billing-overdue, process-billing-reminders, process-billing-unblock,
 * process-trial-expiry, process-billing-reconcile e manage-billing.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseExternalReference } from "./asaas-billing-events.ts";
import { checkFlagString } from "./platform-flags.ts";
import { jsonLog } from "./security.ts";
import {
  decideInvoiceCategory,
  isLegacyInvoice,
  mayGovernSystemAccess,
  SYSTEM_CATEGORY,
  type FactRead,
  type InvoiceCategoryDecision,
} from "./billing-category-core.ts";

export { SYSTEM_CATEGORY, mayGovernSystemAccess };
export type { InvoiceCategoryDecision };

/**
 * Categoria do plano por id. Três desfechos distintos, cada um logado — o
 * módulo antigo colapsava "não existe" e "não deu pra ler" no mesmo `null`,
 * e sem a distinção um erro transitório de banco é indistinguível de um
 * `plan_id` órfão quando alguém investiga um incidente depois.
 */
export async function planCategoryRead(
  supabase: SupabaseClient,
  planId: string,
): Promise<FactRead<string>> {
  const { data, error } = await supabase
    .from("billing_plans")
    .select("category")
    .eq("id", planId)
    .maybeSingle();

  if (error) {
    jsonLog("warn", { evt: "plan_category_read_failed", plan_id: planId, err: error.message });
    return { kind: "READ_FAILED" };
  }
  if (!data) {
    jsonLog("warn", { evt: "plan_category_not_found", plan_id: planId });
    return { kind: "NOT_FOUND" };
  }
  const category = (data as { category?: string | null }).category;
  if (!category) {
    jsonLog("warn", { evt: "plan_category_null", plan_id: planId });
    return { kind: "NOT_FOUND" };
  }
  return { kind: "RESOLVED", value: category };
}

/** Compatibilidade: assinatura antiga da função, ainda usada por callers legados. */
export async function planCategoryOf(
  supabase: SupabaseClient,
  planId: string,
): Promise<string | null> {
  const read = await planCategoryRead(supabase, planId);
  return read.kind === "RESOLVED" ? read.value : null;
}

/**
 * Resolve se a assinatura é de categoria SYSTEM_SUBSCRIPTION.
 *
 * Continua devolvendo `boolean` porque os dois callers que restaram
 * (`manage-billing`, `process-billing-reconcile`) decidem sobre a ASSINATURA,
 * não sobre uma fatura: lá, `false` significa "não trate como sistema", e o
 * caso "não sabemos" tem o mesmo efeito prático seguro (não escalar, não
 * desbloquear agora). A classificação de FATURA — que é onde o dano mora — usa
 * `resolveInvoiceCategory` e o veredito de três valores.
 */
export async function isSystemSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
): Promise<boolean> {
  const read = await subscriptionFacts(supabase, subscriptionId);
  return read.category.kind === "RESOLVED" && read.category.value === SYSTEM_CATEGORY;
}

/** Categoria + status local da assinatura, numa leitura só. */
async function subscriptionFacts(
  supabase: SupabaseClient,
  subscriptionId: string,
): Promise<{ category: FactRead<string>; status: FactRead<string> }> {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("status, billing_plans!inner(category)")
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error) {
    jsonLog("warn", {
      evt: "subscription_category_read_failed",
      subscription_id: subscriptionId,
      err: error.message,
    });
    return { category: { kind: "READ_FAILED" }, status: { kind: "READ_FAILED" } };
  }
  if (!data) {
    jsonLog("warn", {
      evt: "subscription_category_not_found",
      subscription_id: subscriptionId,
    });
    return { category: { kind: "NOT_FOUND" }, status: { kind: "NOT_FOUND" } };
  }

  const planRaw = (data as { billing_plans?: unknown }).billing_plans;
  const plan = Array.isArray(planRaw) ? planRaw[0] : planRaw;
  const category = (plan as { category?: string | null } | null)?.category ?? null;
  const status = (data as { status?: string | null }).status ?? null;

  return {
    category: category ? { kind: "RESOLVED", value: category } : { kind: "NOT_FOUND" },
    status: status ? { kind: "RESOLVED", value: status } : { kind: "NOT_FOUND" },
  };
}

export interface InvoiceCategoryInput {
  billing_subscription_id?: string | null;
  external_reference?: string | null;
  purpose?: string | null;
  /**
   * Necessários para decidir se a fatura é LEGADA por fato objetivo. Ausentes,
   * a fatura é tratada como MODERNA — fail-closed deliberado: presumir legado
   * por falta de informação reintroduziria o default que este hotfix remove.
   * Todo caller que varre `billing_invoices` deve selecioná-los.
   */
  provider?: string | null;
  created_at?: string | null;
}

/**
 * O veredito completo de uma fatura: SYSTEM | NON_SYSTEM | NEEDS_REVIEW.
 *
 * Quem escreve `organizations.billing_status` DEVE usar esta função (ou
 * `mayGovernSystemAccess` sobre o resultado) e tratar `NEEDS_REVIEW`
 * explicitamente — retendo a fatura e avisando o administrador —, nunca
 * silenciando-o como "não é de sistema".
 */
export async function resolveInvoiceCategory(
  supabase: SupabaseClient,
  invoice: InvoiceCategoryInput,
): Promise<InvoiceCategoryDecision> {
  // Marco de ingestão. Falha de leitura devolve "" e, sem marco, só a Stripe
  // conta como legada — a direção segura.
  const since = await checkFlagString("billing_invoice_ingestion_since", "");

  const legacy = isLegacyInvoice({
    provider: invoice.provider,
    createdAt: invoice.created_at,
    ingestionSince: since.value,
  });

  const subscription = invoice.billing_subscription_id
    ? await subscriptionFacts(supabase, invoice.billing_subscription_id)
    : undefined;

  const parsed = parseExternalReference(invoice.external_reference ?? null);
  const externalReferencePlanCategory = parsed?.planId
    ? await planCategoryRead(supabase, parsed.planId)
    : undefined;

  const decision = decideInvoiceCategory({
    purpose: invoice.purpose,
    legacy,
    subscription,
    externalReferencePlanCategory,
  });

  if (decision.verdict === "NEEDS_REVIEW") {
    jsonLog("warn", {
      evt: "invoice_category_needs_review",
      reason: decision.reason,
      subscription_id: invoice.billing_subscription_id ?? null,
      provider: invoice.provider ?? null,
      legacy,
    });
  }

  return decision;
}

/**
 * Açúcar retrocompatível: `true` só quando o veredito é inequivocamente
 * SYSTEM. `NEEDS_REVIEW` devolve `false`, o que basta para NÃO escalar — mas
 * o caller que escreve `billing_status` deve preferir `resolveInvoiceCategory`
 * e reter/avisar em vez de apenas pular em silêncio.
 */
export async function isSystemInvoice(
  supabase: SupabaseClient,
  invoice: InvoiceCategoryInput,
): Promise<boolean> {
  return mayGovernSystemAccess(await resolveInvoiceCategory(supabase, invoice));
}

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

/**
 * Categoria do plano por id. Duas respostas possíveis, cada uma logada
 * separadamente do "resolveu com sucesso":
 *
 *  (a) resolveu → a categoria (string);
 *  (b) erro de leitura OU plano não encontrado (zero linhas) → null, e
 *      LOGADO nos dois casos — sem o log, um erro transitório de leitura é
 *      indistinguível de um `plan_id` órfão/apagado quando alguém investiga
 *      um incidente depois. O caller (`isSystemInvoice`) decide o que fazer
 *      com `null`; esta função não escolhe lado nenhum.
 */
export async function planCategoryOf(
  supabase: SupabaseClient,
  planId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("billing_plans")
    .select("category")
    .eq("id", planId)
    .maybeSingle();
  if (error || !data) {
    jsonLog("warn", {
      evt: "plan_category_read_failed",
      plan_id: planId,
      err: error?.message ?? "not_found",
    });
    return null;
  }
  return (data.category as string | undefined) ?? null;
}

/**
 * Resolve se a assinatura é de categoria SYSTEM_SUBSCRIPTION. Três respostas
 * possíveis, sem eufemismo sobre o motivo de cada uma:
 *
 *  (a) resolveu e o plano é SYSTEM_SUBSCRIPTION → true;
 *  (b) resolveu e o plano é outra categoria (WHATSAPP_*, AI_CREDIT_PACKAGE...)
 *      → false;
 *  (c) erro de leitura OU assinatura/plano não encontrado → false,
 *      DELIBERADAMENTE. Isto NÃO é "resolvemos que não é de sistema" — é
 *      "não sabemos". `false` é a resposta que não decide em nenhuma direção
 *      nos dois callers que importam: em `process-billing-overdue`, `false`
 *      pula a escalada pra bloqueado (não bloqueia mais); em
 *      `process-billing-unblock`, `false` pula o desbloqueio por ESSA
 *      assinatura, não a organização inteira (não desbloqueia agora, mas o
 *      worker roda de novo em 5min e tenta outra vez — reversível). Devolver
 *      `true` aqui reintroduziria o bug original da fase pelo lado do
 *      bloqueio automático: uma fatura de instância cuja categoria não pôde
 *      ser lida bloquearia o sistema inteiro. Fica como está mesmo que um
 *      revisor sugira inverter — as duas direções foram avaliadas.
 */
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
    // (c) — ver docstring acima. Loga pra não deixar a falha muda: sem isso,
    // um erro transitório de leitura é indistinguível de um "não é de
    // sistema" legítimo quando alguém investiga um incidente depois.
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
 * SYSTEM_SUBSCRIPTION. Três caminhos, nesta ordem. A regra pro caso "não deu
 * pra saber" é uma só, e não é "erro versus sucesso" — é HAVIA VÍNCULO DE
 * PLANO OU NÃO: quando não dá pra resolver a categoria, `false` — EXCETO
 * quando não havia vínculo nenhum, onde o default de compatibilidade dá
 * `true`.
 *
 *  1. `billing_subscription_id` (caso comum: fatura de renovação) → delega
 *     pra `isSystemSubscription()`, que devolve `false` em erro de leitura
 *     (ver docstring lá — vínculo presente, categoria ilegível, `false`
 *     deliberado).
 *  2. `external_reference` → `plan:<uuid>` → `planCategoryOf()` (o checkout
 *     hospedado grava esse texto; a primeira cobrança costuma nascer SEM
 *     `billing_subscription_id`). Vínculo também presente aqui — se
 *     `planCategoryOf` não resolver (erro de leitura OU plano órfão/
 *     apagado), a comparação `categoria === SYSTEM_CATEGORY` dá `false`
 *     naturalmente (`null !== SYSTEM_CATEGORY`). NÃO cai no default de
 *     compatibilidade do item 3 — esse default é só pra ausência de vínculo,
 *     nunca pra vínculo ilegível. Faturas de instância de WhatsApp nascem com
 *     `purpose='subscription'` e `external_reference` preenchido, então
 *     passam por aqui: se a leitura falhar, a fatura de R$149 da instância
 *     NÃO pode ser lida como "de sistema" e escalar o bloqueio da org
 *     inteira — seria o bug original da fase, alcançável por um erro
 *     transitório de banco.
 *  3. sem nenhum dos dois (fatura legada, sem `subscription_id` nem
 *     `external_reference` com plano — ausência real de vínculo) → TRUE,
 *     por compatibilidade: toda fatura anterior à Fase 5a é de sistema, e
 *     devolver `false` as tiraria da inadimplência em silêncio — trocaria um
 *     bug (bloquear demais) por outro pior (nunca bloquear).
 *
 * Resumo sem eufemismo: (a) resolveu e é do sistema → true; (b) resolveu e
 * não é → false; (c) não deu pra resolver → false se havia vínculo (1 e 2),
 * true só se não havia vínculo nenhum (3).
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
    // Vínculo de plano EXISTE (veio do external_reference) — categoria
    // ilegível (erro de leitura OU plano órfão, `planCategoryOf` devolve
    // null nos dois casos, já logado lá) NÃO cai no default de
    // compatibilidade do caminho 3. `null === SYSTEM_CATEGORY` é `false`
    // naturalmente, igual ao caminho 1: vínculo presente e ilegível nunca
    // autoriza presumir sistema.
    const category = await planCategoryOf(supabase, parsed.planId);
    return category === SYSTEM_CATEGORY;
  }

  return true;
}

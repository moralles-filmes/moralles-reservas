/**
 * Abre a cobrança avulsa da implantação do WhatsApp (R$ 750) e cria a linha de
 * whatsapp_implementations correspondente.
 *
 * COMPARTILHADO de propósito entre a contratação pelo cliente
 * (create-billing-checkout, purpose=implementation) e o painel administrativo
 * (manage-whatsapp-implementations, action create_asaas_charge): as duas
 * precisam da MESMA cobrança, do mesmo valor e da mesma linha. Duplicar isso
 * criaria dois formatos de externalReference e duas verdades sobre o preço.
 *
 * O valor vem SEMPRE de billing_plans. Nenhum caller passa preço.
 *
 * REDEPLOY: create-billing-checkout, manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { getBillingProvider } from "./billing-provider.ts";
import { buildExternalReference } from "./asaas-billing-events.ts";

export const IMPLEMENTATION_PLAN_SLUG = "implementacao-whatsapp";

export interface ImplementationPlan {
  id: string;
  name: string;
  amount_cents: number | null;
  category: string | null;
  billing_type: string | null;
  active: boolean;
}

export type ImplementationCheckoutResult =
  | { ok: true; url: string; providerCheckoutId: string; implementationId: string }
  | { ok: false; status: number; error: string };

/** Carrega o plano da implantação pelo slug e valida que ele é o que dizemos ser. */
export async function loadImplementationPlan(
  supabase: SupabaseClient,
): Promise<ImplementationPlan | null> {
  const { data } = await supabase
    .from("billing_plans")
    .select("id, name, amount_cents, category, billing_type, active")
    .eq("slug", IMPLEMENTATION_PLAN_SLUG)
    .maybeSingle();
  return (data as ImplementationPlan | null) ?? null;
}

/**
 * Fluxo completo. A ORDEM importa e cada passo desfaz o anterior no erro:
 *
 *  1. valida o plano (categoria e modalidade vêm do banco, não do caller);
 *  2. recusa se a organização já tem implantação aberta (o UNIQUE parcial é o
 *     backstop; aqui damos a mensagem decente);
 *  3. reserva a sessão de checkout ('creating');
 *  4. abre o checkout DETACHED no Asaas (cartão + PIX);
 *  5. promove a sessão a 'pending' — se falhar, aborta: checkout pagável sem
 *     linha correlacionável é pagamento perdido;
 *  6. cria whatsapp_implementations (origin=ASAAS, payment_status=PENDING).
 *
 * O passo 6 por último de propósito: só depois de existir um checkout de
 * verdade é que a linha tem sentido. Falha nele NÃO desfaz o checkout no Asaas
 * (não há como) — devolve erro e loga alto, para conferência manual, em vez de
 * fingir sucesso.
 */
export async function openImplementationCheckout(args: {
  supabase: SupabaseClient;
  reqId: string;
  organizationId: string;
  plan: ImplementationPlan;
  asaasCustomerId: string;
  successUrl: string;
  cancelUrl: string;
  minutesToExpire: number;
  createdBy: string | null;
  reserve: (a: {
    reqId: string;
    organizationId: string;
    planId: string;
    purpose: "implementation";
    externalReference: string;
  }) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; reuse: true; url: string; providerCheckoutId: string | null }
    | { ok: false; reuse?: false; status: number; error: string }
  >;
  finalize: (sessionId: string, a: { providerCheckoutId: string; checkoutUrl: string }) => Promise<boolean>;
  fail: (sessionId: string) => Promise<void>;
}): Promise<ImplementationCheckoutResult> {
  const { supabase, plan } = args;

  if (!plan.active) return { ok: false, status: 400, error: "Produto indisponível no momento." };
  if (plan.category !== "WHATSAPP_IMPLEMENTATION" || plan.billing_type !== "one_time") {
    // Configuração errada no catálogo — não é erro do cliente, mas não dá para
    // cobrar: um checkout RECURRENT aqui viraria mensalidade de R$750.
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_plan_misconfigured",
      planId: plan.id,
      category: plan.category,
      billingType: plan.billing_type,
    });
    return { ok: false, status: 500, error: "Produto mal configurado. Fale com o suporte." };
  }
  if (!plan.amount_cents || plan.amount_cents <= 0) {
    return { ok: false, status: 500, error: "Produto sem valor configurado." };
  }

  const { data: open, error: openErr } = await supabase
    .from("whatsapp_implementations")
    .select("id, payment_status, operational_status")
    .eq("organization_id", args.organizationId)
    .neq("operational_status", "CANCELED")
    .maybeSingle();
  if (openErr) {
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_open_check_failed",
      orgId: args.organizationId,
      err: openErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar a implantação da empresa." };
  }
  if (open) {
    return {
      ok: false,
      status: 409,
      error: open.payment_status === "PENDING"
        ? "Já existe uma implantação aguardando pagamento para esta empresa."
        : "Esta empresa já tem uma implantação registrada.",
    };
  }

  const externalReference = buildExternalReference({
    orgId: args.organizationId,
    planId: plan.id,
    purpose: "implementation",
  });

  const reserved = await args.reserve({
    reqId: args.reqId,
    organizationId: args.organizationId,
    planId: plan.id,
    purpose: "implementation",
    externalReference,
  });
  if (!reserved.ok && reserved.reuse) {
    // Sessão viva: devolve a MESMA url. A linha de implantação já existe (foi
    // criada na primeira tentativa) e o `open` acima teria barrado — este ramo
    // só é alcançável numa corrida, e reusar é o comportamento correto.
    return {
      ok: false,
      status: 409,
      error: "Já existe um checkout aberto para esta implantação. Use o link enviado ou aguarde a expiração.",
    };
  }
  if (!reserved.ok) return { ok: false, status: reserved.status, error: reserved.error };

  const asaas = getBillingProvider("asaas");
  const checkout = await asaas.createCheckout({
    providerCustomerId: args.asaasCustomerId,
    amountCents: plan.amount_cents,
    description: plan.name,
    externalReference,
    // DETACHED: cobrança única. Habilita cartão E PIX (o RECURRENT do Asaas só
    // aceita cartão; aqui deixar a escolha com o pagador aumenta a conversão).
    mode: "one_time",
    minutesToExpire: args.minutesToExpire,
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
  });

  if (!checkout.ok || !checkout.data?.checkoutId) {
    await args.fail(reserved.sessionId);
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_checkout_error",
      orgId: args.organizationId,
      err: checkout.error ?? "checkout sem id",
    });
    return {
      ok: false,
      status: 502,
      error: "Não foi possível abrir o checkout de pagamento. Tente novamente em instantes.",
    };
  }

  const finalized = await args.finalize(reserved.sessionId, {
    providerCheckoutId: checkout.data.checkoutId,
    checkoutUrl: checkout.data.url,
  });
  if (!finalized) {
    return { ok: false, status: 500, error: "Falha ao registrar o checkout. Tente novamente em instantes." };
  }

  const { data: created, error: implErr } = await supabase
    .from("whatsapp_implementations")
    .insert({
      organization_id: args.organizationId,
      origin: "ASAAS",
      payment_status: "PENDING",
      operational_status: "NOT_STARTED",
      amount_cents: plan.amount_cents,
      billing_plan_id: plan.id,
      provider_checkout_id: checkout.data.checkoutId,
      created_by: args.createdBy,
    })
    .select("id")
    .maybeSingle();

  if (implErr || !created) {
    // O checkout EXISTE no Asaas e não há como desfazê-lo. Loga alto: se o
    // cliente pagar, o webhook não vai achar linha para confirmar (cai em
    // implementation_confirm_noop) e isso precisa ser resolvido à mão.
    jsonLog("error", {
      reqId: args.reqId,
      evt: "implementation_row_insert_failed",
      orgId: args.organizationId,
      checkout: checkout.data.checkoutId,
      err: implErr?.message ?? "insert sem linha",
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao registrar a implantação. Fale com o suporte antes de pagar.",
    };
  }

  jsonLog("info", {
    reqId: args.reqId,
    evt: "implementation_checkout_created",
    orgId: args.organizationId,
    implementationId: created.id,
    checkout: checkout.data.checkoutId,
  });

  return {
    ok: true,
    url: checkout.data.url,
    providerCheckoutId: checkout.data.checkoutId,
    implementationId: created.id as string,
  };
}

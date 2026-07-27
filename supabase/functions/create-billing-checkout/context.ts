// Prelúdio comum dos handlers de checkout: organização, plano (do banco),
// cliente Asaas, gate de flag e o ciclo de vida da sessão.
//
// Existe como arquivo separado porque os três purposes precisam exatamente das
// mesmas cinco coisas antes de divergir, e porque o painel administrativo
// (manage-whatsapp-implementations) reusa a mesma reserva de sessão.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const APP_BASE_URL =
  Deno.env.get("APP_BASE_URL") ?? "https://reservas.moralles.com.br";

export type CheckoutPurpose = "subscription" | "implementation" | "payment_method_update";

export interface PlanRow {
  id: string;
  name: string;
  amount_cents: number | null;
  provider: string | null;
  billing_type: string | null;
  /** NOT NULL no banco (CHECK month|year). Tipado nullable por segurança de
   *  leitura e validado no provider — assumir mensal cobraria o valor anual
   *  todo mês. */
  interval: string | null;
  category: string | null;
  active: boolean;
  stripe_price_id_card: string | null;
  trial_days: number | null;
}

export interface OrgRow {
  slug: string | null;
  name: string | null;
  billing_email: string | null;
}

export interface CheckoutContext {
  reqId: string;
  organizationId: string;
  callerId: string;
  callerEmail: string | null;
  org: OrgRow | null;
  plan: PlanRow | null;
  successBase: string;
}

export interface HandlerFailure {
  ok: false;
  status: number;
  error: string;
}

export async function loadPlan(planId: string): Promise<PlanRow | null> {
  const { data } = await supabase
    .from("billing_plans")
    .select(
      "id, name, amount_cents, provider, billing_type, interval, category, active, stripe_price_id_card, trial_days",
    )
    .eq("id", planId)
    .maybeSingle();
  return (data as PlanRow | null) ?? null;
}

export async function resolveOrg(organizationId: string): Promise<OrgRow | null> {
  const { data } = await supabase
    .from("organizations")
    .select("slug, name, billing_email")
    .eq("id", organizationId)
    .maybeSingle();
  return (data as OrgRow | null) ?? null;
}

export async function resolveUnitSlug(organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("units")
    .select("slug")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.slug ?? null;
}

/**
 * Gate CRÍTICO de simetria com o webhook — texto integral do raciocínio no
 * comentário original da EF: o asaas-webhook fail-closa em `asaas_enabled` e
 * DESCARTA o evento com a flag OFF. Abrir um checkout aqui nesse estado geraria
 * cobrança REAL cuja confirmação seria jogada fora, sem nem billing_events para
 * o reconcile recuperar. Checado ANTES de qualquer I/O no Asaas: criar o
 * customer e então abortar deixaria um `cus_...` órfão (o Asaas não deduplica).
 * Leitura falha e OFF genuíno caem no MESMO fail-closed — só o nível do log os
 * distingue.
 */
export async function requireAsaasEnabled(
  reqId: string,
  organizationId: string,
  planId: string | null,
): Promise<{ ok: true } | HandlerFailure> {
  const flag = await checkFlagEnabled("asaas_enabled");
  if (flag.enabled) return { ok: true };
  jsonLog(flag.readFailed ? "error" : "warn", {
    reqId,
    evt: "checkout_asaas_disabled",
    orgId: organizationId,
    planId,
    readFailed: flag.readFailed,
  });
  return {
    ok: false,
    status: 503,
    error:
      "A cobrança pelo Asaas está temporariamente indisponível. Tente novamente em instantes ou fale com o suporte.",
  };
}

/**
 * Cliente Asaas da organização, criando se ainda não existe e persistindo o id.
 * Abortar quando o INSERT do id falha é deliberado: o cliente EXISTE lá, e a
 * próxima tentativa criaria um duplicado.
 */
export async function resolveAsaasCustomer(
  ctx: CheckoutContext,
  createCustomer: (args: {
    organizationId: string;
    name?: string;
    email?: string;
    taxId: string;
  }) => Promise<{ ok: boolean; data?: { customerId: string }; error?: string }>,
): Promise<{ ok: true; customerId: string } | HandlerFailure> {
  const { data: customerRow, error: customerErr } = await supabase
    .from("billing_customers")
    .select("id, asaas_customer_id, name, email, tax_id")
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (customerErr) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_billing_customer_read_error",
      orgId: ctx.organizationId,
      err: customerErr.message,
    });
    return { ok: false, status: 500, error: "Falha ao carregar o cadastro de cobrança." };
  }
  if (!customerRow?.tax_id) {
    return {
      ok: false,
      status: 400,
      error:
        "CPF/CNPJ da empresa não está cadastrado. Preencha o cadastro fiscal antes de contratar.",
    };
  }
  if (customerRow.asaas_customer_id) {
    return { ok: true, customerId: customerRow.asaas_customer_id };
  }

  const created = await createCustomer({
    organizationId: ctx.organizationId,
    name: customerRow.name ?? ctx.org?.name ?? undefined,
    email: customerRow.email ?? ctx.org?.billing_email ?? ctx.callerEmail ?? undefined,
    taxId: customerRow.tax_id,
  });
  if (!created.ok || !created.data) {
    // Mensagem FIXA: created.error carrega texto de validação cru do Asaas, que
    // o dono do restaurante não deve ler. O detalhe fica no log.
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_customer_error",
      orgId: ctx.organizationId,
      err: created.error ?? null,
    });
    return {
      ok: false,
      status: 502,
      error: "Não foi possível cadastrar a empresa no provedor de pagamento. Tente novamente em instantes.",
    };
  }

  const { error: persistErr } = await supabase
    .from("billing_customers")
    .update({ asaas_customer_id: created.data.customerId })
    .eq("id", customerRow.id);
  if (persistErr) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "checkout_asaas_customer_persist_error",
      orgId: ctx.organizationId,
      err: persistErr.message,
    });
    return {
      ok: false,
      status: 500,
      error: "Falha ao salvar o cadastro no provedor. Tente novamente em instantes.",
    };
  }
  return { ok: true, customerId: created.data.customerId };
}

// O ciclo de vida da sessão mora em _shared/checkout-sessions.ts — reexportado
// aqui para os handlers importarem de um lugar só. CHECKOUT_EXPIRY_MINUTES tem
// UMA ÚNICA declaração (lá); aqui é só passthrough.
export {
  CHECKOUT_EXPIRY_MINUTES,
  reserveCheckoutSession,
  finalizeCheckoutSession,
  failCheckoutSession,
  type ReserveResult,
} from "../_shared/checkout-sessions.ts";

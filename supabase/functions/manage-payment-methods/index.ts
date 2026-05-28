// Edge Function: manage-payment-methods
// CRUD de cartões salvos no Stripe Customer da organization.
//
// Actions:
//   - list { organization_id }            — owner/gerente da org OU platform_admin
//   - set_default { organization_id, pm } — owner/gerente OU platform_admin
//   - delete { payment_method_id }        — APENAS platform_admin (cliente não remove)
//
// Restrição central: o action `delete` valida is_platform_admin antes de chamar Stripe.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getStripeSecretKey } from "../_shared/stripe-config.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const STRIPE_API = "https://api.stripe.com/v1";

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

async function stripeRequest(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) throw new Error("Stripe não configurado.");
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`${STRIPE_API}${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function canManageOrgBilling(userId: string, organizationId: string): Promise<boolean> {
  if (await isPlatformAdmin(userId)) return true;
  const { data } = await supabase
    .from("unit_members")
    .select("role, units!inner(organization_id)")
    .eq("user_id", userId)
    .in("role", ["owner", "gerente"])
    .eq("units.organization_id", organizationId)
    .limit(1);
  return !!(data && data.length > 0);
}

async function getStripeCustomerId(organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data?.stripe_customer_id ?? null;
}

async function resolveOrgIdFromPaymentMethod(paymentMethodId: string): Promise<string | null> {
  // Retrieve pm no Stripe pra pegar customer; depois mapeia customer → org.
  const res = await stripeRequest(`/payment_methods/${paymentMethodId}`);
  if (!res.ok) return null;
  const customerId = res.data.customer as string | null;
  if (!customerId) return null;

  const { data } = await supabase
    .from("billing_customers")
    .select("organization_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.organization_id ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeadersFor(req) });
  }

  const reqId = genRequestId();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) {
      return jsonResponse(req, { error: "Sessão inválida." }, 401);
    }
    const callerId = callerData.user.id;

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    // ─── list ─────────────────────────────────────────────────────────────
    if (action === "list") {
      const { organization_id } = body as { organization_id?: string };
      if (!organization_id) {
        return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
      }
      if (!(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão." }, 403);
      }

      const stripeCustomerId = await getStripeCustomerId(organization_id);
      if (!stripeCustomerId) {
        return jsonResponse(req, { success: true, payment_methods: [], default_payment_method_id: null });
      }

      // Lista cartões
      const listRes = await stripeRequest(`/customers/${stripeCustomerId}/payment_methods?type=card&limit=20`);
      if (!listRes.ok) {
        jsonLog("error", { reqId, evt: "pm_list_stripe_error", status: listRes.status });
        return jsonResponse(req, { error: "Falha ao listar cartões." }, 500);
      }

      // Customer pra pegar default_payment_method
      const custRes = await stripeRequest(`/customers/${stripeCustomerId}`);
      const defaultPm =
        ((custRes.data?.invoice_settings as Record<string, unknown> | undefined)?.default_payment_method as string | null) ?? null;

      const items = ((listRes.data.data as Record<string, unknown>[]) ?? []).map((pm) => {
        const card = pm.card as Record<string, unknown> | undefined;
        return {
          id: pm.id as string,
          brand: (card?.brand as string) ?? null,
          last4: (card?.last4 as string) ?? null,
          exp_month: (card?.exp_month as number) ?? null,
          exp_year: (card?.exp_year as number) ?? null,
          is_default: pm.id === defaultPm,
        };
      });

      return jsonResponse(req, {
        success: true,
        payment_methods: items,
        default_payment_method_id: defaultPm,
      });
    }

    // ─── set_default ──────────────────────────────────────────────────────
    if (action === "set_default") {
      const { organization_id, payment_method_id } = body as {
        organization_id?: string;
        payment_method_id?: string;
      };
      if (!organization_id || !payment_method_id) {
        return jsonResponse(req, { error: "organization_id e payment_method_id são obrigatórios." }, 400);
      }
      if (!(await canManageOrgBilling(callerId, organization_id))) {
        return jsonResponse(req, { error: "Sem permissão." }, 403);
      }

      const stripeCustomerId = await getStripeCustomerId(organization_id);
      if (!stripeCustomerId) {
        return jsonResponse(req, { error: "Customer Stripe não encontrado." }, 404);
      }

      // Defesa: payment method tem que pertencer a esse customer
      const pmRes = await stripeRequest(`/payment_methods/${payment_method_id}`);
      if (!pmRes.ok || pmRes.data.customer !== stripeCustomerId) {
        return jsonResponse(req, { error: "Cartão não pertence a esta organização." }, 403);
      }

      const updateRes = await stripeRequest(`/customers/${stripeCustomerId}`, "POST", {
        "invoice_settings[default_payment_method]": payment_method_id,
      });
      if (!updateRes.ok) {
        jsonLog("error", { reqId, evt: "pm_set_default_stripe_error", status: updateRes.status });
        return jsonResponse(req, { error: "Falha ao definir cartão padrão." }, 500);
      }

      jsonLog("info", { reqId, evt: "pm_set_default", orgId: organization_id, pmId: payment_method_id, callerId });
      return jsonResponse(req, { success: true });
    }

    // ─── delete ───────────────────────────────────────────────────────────
    // EXCLUSIVO de platform_admin — cliente não pode remover cartão
    if (action === "delete") {
      const { payment_method_id } = body as { payment_method_id?: string };
      if (!payment_method_id) {
        return jsonResponse(req, { error: "payment_method_id é obrigatório." }, 400);
      }

      if (!(await isPlatformAdmin(callerId))) {
        jsonLog("warn", { reqId, evt: "pm_delete_denied", callerId, pmId: payment_method_id });
        return jsonResponse(req, { error: "Apenas administradores da plataforma podem remover cartões." }, 403);
      }

      // Pra log: identifica a org
      const orgId = await resolveOrgIdFromPaymentMethod(payment_method_id);

      const detachRes = await stripeRequest(`/payment_methods/${payment_method_id}/detach`, "POST");
      if (!detachRes.ok) {
        jsonLog("error", { reqId, evt: "pm_detach_stripe_error", status: detachRes.status, pmId: payment_method_id });
        return jsonResponse(req, { error: "Falha ao remover cartão no Stripe." }, 500);
      }

      jsonLog("info", { reqId, evt: "pm_deleted", orgId, pmId: payment_method_id, callerId });
      return jsonResponse(req, { success: true });
    }

    return jsonResponse(req, { error: "Action desconhecida." }, 400);
  } catch (err) {
    jsonLog("error", { reqId, evt: "pm_unexpected_error", err: err instanceof Error ? err.message : String(err) });
    return jsonResponse(req, { error: "Erro inesperado." }, 500);
  }
});

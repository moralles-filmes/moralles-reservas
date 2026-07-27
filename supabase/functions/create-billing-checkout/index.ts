// Edge Function: create-billing-checkout
// Abre o checkout hospedado, roteado por PURPOSE (Fase 5a).
//
// Auth: JWT obrigatório. Caller precisa ser platform_admin OU member
// (owner|gerente) de alguma unit da organization_id alvo.
//
// purpose=subscription           → assinatura (sistema R$449 ou instância R$149)
// purpose=implementation         → cobrança avulsa da implantação (R$750)
// purpose=payment_method_update  → troca de cartão (só Stripe, legado)
//
// O SERVIDOR resolve categoria, modalidade, preço e intervalo a partir de
// billing_plans. O navegador manda apenas organization_id, plan_id e purpose.
// Nada aqui ativa acesso — quem ativa é o webhook do provedor.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { genRequestId, jsonLog } from "../_shared/security.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import {
  supabase,
  loadPlan,
  resolveOrg,
  resolveUnitSlug,
  APP_BASE_URL,
  type CheckoutContext,
  type CheckoutPurpose,
} from "./context.ts";
import { handleSubscription } from "./subscription.ts";
import { handleImplementation } from "./implementation.ts";

const PURPOSES: ReadonlySet<string> = new Set([
  "subscription",
  "implementation",
  "payment_method_update",
]);

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
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

/**
 * `mode` saiu do contrato. Aceito por UMA release porque o frontend em produção
 * ainda manda `mode:'setup'` para trocar cartão, e derrubar isso quebraria a
 * troca de cartão entre o deploy da EF e o do frontend. A remoção do compat é
 * item da Fase 5b.
 */
function resolvePurpose(body: { purpose?: string; mode?: string }, reqId: string): string | null {
  if (body.purpose) return body.purpose;
  if (body.mode) {
    jsonLog("warn", { reqId, evt: "checkout_legacy_mode_param", mode: body.mode });
    if (body.mode === "setup") return "payment_method_update";
    if (body.mode === "subscription") return "subscription";
    return null;
  }
  return "subscription";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "Método não permitido." }, 405);

  const reqId = genRequestId();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse(req, { error: "Não autenticado." }, 401);

    const { data: callerData, error: callerErr } = await supabase.auth.getUser(jwt);
    if (callerErr || !callerData.user) return jsonResponse(req, { error: "Sessão inválida." }, 401);

    const body = (await req.json().catch(() => ({}))) as {
      organization_id?: string;
      plan_id?: string;
      purpose?: string;
      mode?: string;
    };

    if (!body.organization_id) {
      return jsonResponse(req, { error: "organization_id é obrigatório." }, 400);
    }

    const purpose = resolvePurpose(body, reqId);
    if (!purpose || !PURPOSES.has(purpose)) {
      return jsonResponse(req, { error: "Tipo de checkout inválido." }, 400);
    }
    if (purpose !== "payment_method_update" && !body.plan_id) {
      return jsonResponse(req, { error: "plan_id é obrigatório." }, 400);
    }

    if (!(await canManageOrgBilling(callerData.user.id, body.organization_id))) {
      return jsonResponse(req, { error: "Sem permissão para esta organização." }, 403);
    }

    const plan = body.plan_id ? await loadPlan(body.plan_id) : null;
    if (body.plan_id && !plan) return jsonResponse(req, { error: "Plano não encontrado." }, 404);

    const [org, unitSlug] = await Promise.all([
      resolveOrg(body.organization_id),
      resolveUnitSlug(body.organization_id),
    ]);

    const ctx: CheckoutContext = {
      reqId,
      organizationId: body.organization_id,
      callerId: callerData.user.id,
      callerEmail: callerData.user.email ?? null,
      org,
      plan,
      successBase: unitSlug
        ? `${APP_BASE_URL}/g/${unitSlug}/cobranca`
        : `${APP_BASE_URL}/platform/billing/${body.organization_id}`,
    };

    const result = purpose === "implementation"
      ? await handleImplementation(ctx)
      : await handleSubscription(ctx, purpose as CheckoutPurpose);

    return jsonResponse(req, result.body, result.status);
  } catch (err) {
    jsonLog("error", {
      reqId,
      evt: "checkout_unexpected_error",
      err: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(req, { error: "Erro inesperado ao criar checkout." }, 500);
  }
});

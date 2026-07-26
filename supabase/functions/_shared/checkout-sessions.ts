/**
 * Ciclo de vida de billing_checkout_sessions (Fase 5a).
 *
 * O Asaas não tem Idempotency-Key: dois cliques abrem duas cobranças reais. A
 * linha 'creating' reservada ANTES da chamada, mais o UNIQUE parcial
 * (organization_id, plan_id, purpose) restrito a ('creating','pending'), são o
 * que serializa isso.
 *
 * REDEPLOY: create-billing-checkout, manage-whatsapp-implementations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";

/** Janela do checkout hospedado. Dentro do intervalo aceito pelo Asaas (10–1440)
 *  e curta o bastante para uma sessão abandonada não travar o botão por horas. */
export const CHECKOUT_EXPIRY_MINUTES = 30;

export type CheckoutSessionPurpose = "subscription" | "implementation";

export type ReserveResult =
  | { ok: true; sessionId: string }
  /** Já existe checkout pagável para este produto — devolve a MESMA url. */
  | { ok: false; reuse: true; url: string; providerCheckoutId: string | null }
  | { ok: false; reuse?: false; status: number; error: string };

/**
 * Reserva a intenção de checkout ANTES de chamar o Asaas.
 *
 * O Asaas não tem Idempotency-Key: dois cliques abrem duas cobranças reais. A
 * linha 'creating' + o UNIQUE parcial (organization_id, plan_id, purpose) são o
 * que serializa isso. Sequência:
 *   1. varre sessões vencidas do mesmo produto para 'expired';
 *   2. tenta inserir a reserva;
 *   3. no 23505, lê a viva: 'pending' com url → reusa; 'creating' → 409.
 */
export async function reserveCheckoutSession(
  supabase: SupabaseClient,
  args: {
    reqId: string;
    organizationId: string;
    planId: string;
    purpose: CheckoutSessionPurpose;
    externalReference: string;
  },
): Promise<ReserveResult> {
  const nowIso = new Date().toISOString();
  // Sessão vencida não pode travar o botão. `expires_at is null` cobre as
  // reservas órfãs (isolate morto entre a reserva e a resposta do Asaas), que
  // nunca chegaram a ter data.
  const staleCutoff = new Date(Date.now() - CHECKOUT_EXPIRY_MINUTES * 60_000).toISOString();
  await supabase
    .from("billing_checkout_sessions")
    .update({ status: "expired" })
    .eq("organization_id", args.organizationId)
    .eq("plan_id", args.planId)
    .eq("purpose", args.purpose)
    .in("status", ["creating", "pending"])
    .or(`expires_at.lt.${nowIso},and(expires_at.is.null,created_at.lt.${staleCutoff})`);

  const { data: reserved, error: insErr } = await supabase
    .from("billing_checkout_sessions")
    .insert({
      provider: "asaas",
      organization_id: args.organizationId,
      plan_id: args.planId,
      purpose: args.purpose,
      external_reference: args.externalReference,
      status: "creating",
    })
    .select("id")
    .maybeSingle();

  if (!insErr && reserved) return { ok: true, sessionId: reserved.id as string };

  if (insErr && insErr.code === "23505") {
    const { data: live } = await supabase
      .from("billing_checkout_sessions")
      .select("status, checkout_url, provider_checkout_id")
      .eq("organization_id", args.organizationId)
      .eq("plan_id", args.planId)
      .eq("purpose", args.purpose)
      .in("status", ["creating", "pending"])
      .maybeSingle();

    if (live?.status === "pending" && live.checkout_url) {
      jsonLog("info", {
        reqId: args.reqId,
        evt: "checkout_session_reused",
        orgId: args.organizationId,
        purpose: args.purpose,
      });
      return {
        ok: false,
        reuse: true,
        url: live.checkout_url as string,
        providerCheckoutId: (live.provider_checkout_id as string | null) ?? null,
      };
    }
    // Irmão ainda em 'creating': a chamada ao Asaas dele está em voo. Devolver
    // 409 é melhor que abrir uma segunda cobrança real.
    return {
      ok: false,
      status: 409,
      error: "Já existe um checkout sendo aberto para este produto. Aguarde alguns segundos e tente de novo.",
    };
  }

  jsonLog("error", {
    reqId: args.reqId,
    evt: "checkout_session_reserve_error",
    orgId: args.organizationId,
    err: insErr?.message ?? "insert sem linha",
  });
  return { ok: false, status: 500, error: "Falha ao registrar o checkout. Tente novamente em instantes." };
}

/**
 * Promove a reserva a 'pending'. Devolve false quando a escrita falha — e o
 * caller ABORTA: um checkout pagável sem linha correlacionável é pagamento
 * perdido em silêncio (o webhook resolve a org pelo checkoutSession).
 */
export async function finalizeCheckoutSession(
  supabase: SupabaseClient,
  sessionId: string,
  args: { providerCheckoutId: string; checkoutUrl: string },
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from("billing_checkout_sessions")
    .update({
      status: "pending",
      provider_checkout_id: args.providerCheckoutId,
      checkout_url: args.checkoutUrl,
      expires_at: expiresAt,
    })
    .eq("id", sessionId);
  if (error) {
    jsonLog("error", {
      evt: "checkout_session_finalize_error",
      sessionId,
      err: error.message,
    });
    return false;
  }
  return true;
}

/** Libera o UNIQUE quando o Asaas recusou — sem isto o cliente ficaria 30min
 *  sem conseguir tentar de novo por causa de um erro que não foi dele. */
export async function failCheckoutSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from("billing_checkout_sessions")
    .update({ status: "failed" })
    .eq("id", sessionId);
  if (error) jsonLog("warn", { evt: "checkout_session_fail_mark_error", sessionId, err: error.message });
}

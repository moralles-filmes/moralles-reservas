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
 *   1. varre sessões vencidas do mesmo produto para 'expired' (falha aqui é
 *      só logada — não aborta a reserva, ver comentário no corpo);
 *   2. tenta inserir a reserva;
 *   3. no 23505, lê a viva: 'pending' com url e AINDA VÁLIDA → reusa; 'pending'
 *      vencida (a varredura do passo 1 pode ter falhado) → marca 'expired' e
 *      pede retry; 'creating' → 409.
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
  const { error: sweepError } = await supabase
    .from("billing_checkout_sessions")
    .update({ status: "expired" })
    .eq("organization_id", args.organizationId)
    .eq("plan_id", args.planId)
    .eq("purpose", args.purpose)
    .in("status", ["creating", "pending"])
    .or(`expires_at.lt.${nowIso},and(expires_at.is.null,created_at.lt.${staleCutoff})`);
  if (sweepError) {
    // NÃO abortamos a reserva por causa disso: na esmagadora maioria das
    // chamadas não existe linha nenhuma pra varrer, e travar aqui bloquearia
    // uma compra saudável por um problema que provavelmente não existe
    // (Global Constraint 1 — nada nesta fase bloqueia serviço). O preço de
    // deixar passar é coberto pela revalidação no caminho 23505 abaixo, que
    // não confia cegamente numa linha 'pending' só porque ela existe.
    jsonLog("warn", {
      reqId: args.reqId,
      evt: "checkout_session_sweep_failed",
      orgId: args.organizationId,
      planId: args.planId,
      purpose: args.purpose,
      err: sweepError.message,
    });
  }

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
      .select("id, status, checkout_url, provider_checkout_id, expires_at, created_at")
      .eq("organization_id", args.organizationId)
      .eq("plan_id", args.planId)
      .eq("purpose", args.purpose)
      .in("status", ["creating", "pending"])
      .maybeSingle();

    if (live?.status === "pending" && live.checkout_url) {
      // Revalida a linha ANTES de devolvê-la — não é redundante com a
      // varredura lá em cima, é o backstop pra quando ela falha (logada
      // acima): sem isto, uma falha transitória de UPDATE bem no instante em
      // que esta linha específica venceu faria o cliente reusar uma URL morta
      // no Asaas e cair numa página de erro do provedor sem saber que precisa
      // tentar de novo. Mesmo critério da varredura, aplicado à linha única
      // que está prestes a ser entregue.
      const stillValid = live.expires_at
        ? new Date(live.expires_at as string).getTime() > Date.now()
        : Date.now() - new Date(live.created_at as string).getTime() < CHECKOUT_EXPIRY_MINUTES * 60_000;

      if (stillValid) {
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

      // Exatamente a linha morta que a varredura deveria ter capturado (e não
      // capturou, por causa da falha logada acima). Fecha o ciclo aqui em vez
      // de devolver a URL: marca 'expired' e pede retry — o próximo clique
      // encontra a UNIQUE livre e reserva limpo.
      const { error: expireErr } = await supabase
        .from("billing_checkout_sessions")
        .update({ status: "expired" })
        .eq("id", live.id as string);
      // Erro aqui não muda a resposta (já é retriável) — só logado pra não
      // repetir o mesmo silêncio do Achado 1 se esta segunda escrita falhar
      // também. Sem sucesso, a linha se autocura na próxima tentativa via a
      // varredura do topo (mesmo predicado, próxima chamada).
      jsonLog("warn", {
        reqId: args.reqId,
        evt: "checkout_session_stale_reuse_blocked",
        orgId: args.organizationId,
        purpose: args.purpose,
        expireMarkFailed: !!expireErr,
        expireMarkErr: expireErr?.message ?? null,
      });
      return {
        ok: false,
        status: 409,
        error: "O checkout anterior expirou. Tente novamente em instantes.",
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

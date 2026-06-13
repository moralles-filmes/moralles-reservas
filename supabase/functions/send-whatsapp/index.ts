import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsApp, type SendMessagePayload } from "../_shared/whatsapp-send.ts";
import { jsonLog, requireInternalAuth, sanitizePhone } from "../_shared/security.ts";
import {
  appendOutboundToConversation,
  type OutboundKind,
} from "../_shared/conversation-log.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
};

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Re-exporta o helper para compatibilidade com imports existentes.
export { sendWhatsApp };
export type { SendMessagePayload };

/**
 * Notification kinds aceitos. Quando passado, gravamos uma linha em
 * `notifications_sent` após o envio. Sem kind, mantém comportamento
 * "fire-and-forget" original (testes, manual-message).
 */
const VALID_KINDS = new Set([
  "waitlist_entered",
  "waitlist_table_ready",
  "waitlist_feedback",
  "voucher_issued",
  "reminder_d1",
  "survey_d1",
]);

interface ExtendedPayload extends SendMessagePayload {
  /** Quando presente, grava notifications_sent. */
  kind?: string;
  // Quando presente junto com kind, grava `notifications_sent.reservation_id`
  // — necessário pra reminder_d1/survey_d1, cuja idempotência depende da
  // UNIQUE (reservation_id, kind). Para waitlist e voucher_issued, deixe nulo.
  reservation_id?: string | null;
  // Quando presente junto com kind=waitlist_*, grava
  // `notifications_sent.waitlist_id`. Idempotência por UNIQUE parcial
  // (waitlist_id, kind) (migration 048).
  waitlist_id?: string | null;
}

/**
 * Verifica autorização: aceita
 *   1. `x-internal-key` (uso interno por outras Edge Functions, cron)
 *   2. JWT de um membro da unit (chamada do painel)
 *
 * Quando autorizado por JWT, valida que o caller é membro da `unit_id` enviada
 * no body. Sem unit_id, JWT é insuficiente e rejeitamos.
 */
async function authorize(
  req: Request,
  unitId: string | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  if (requireInternalAuth(req)) return { ok: true };

  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return { ok: false, reason: "missing_auth" };

  if (!unitId) {
    return { ok: false, reason: "unit_id_required_for_jwt_auth" };
  }

  const { data: userRes, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !userRes.user) return { ok: false, reason: "invalid_jwt" };

  const userId = userRes.user.id;

  // Platform admin sempre passa
  const { data: pa } = await supabaseAdmin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (pa) return { ok: true };

  // Membro da unit?
  const { data: member } = await supabaseAdmin
    .from("unit_members")
    .select("role")
    .eq("user_id", userId)
    .eq("unit_id", unitId)
    .maybeSingle();
  if (member) return { ok: true };

  return { ok: false, reason: "not_unit_member" };
}

async function recordNotification(
  unitId: string,
  kind: string,
  status: "sent" | "failed",
  error: string | null,
  reservationId: string | null,
  waitlistId: string | null,
  providerMessageId: string | null,
) {
  const sentAt = new Date().toISOString();
  // provider_message_id correlaciona o callback de status (entregue/lido).
  // delivered_at/read_at/failed_at começam null e são preenchidos pelo webhook.
  const { error: insErr } = await supabaseAdmin.from("notifications_sent").insert({
    unit_id: unitId,
    kind,
    status,
    error,
    reservation_id: reservationId,
    waitlist_id: waitlistId,
    provider_message_id: providerMessageId,
    sent_at: sentAt,
  });
  if (!insErr) return;

  // 23505 = a linha já existe (UNIQUE (reservation_id,kind) OU parcial
  // (waitlist_id,kind)). É um REENVIO: atualiza o registro com o novo messageId
  // e RESETA o rastreio de entrega, pra a UI voltar a "enviado" e reconfirmar
  // entrega quando o novo callback chegar. (PostgREST não faz upsert em índice
  // parcial → insert-then-update manual, service_role.)
  if ((insErr as { code?: string }).code === "23505") {
    let q = supabaseAdmin
      .from("notifications_sent")
      .update({
        status,
        error,
        provider_message_id: providerMessageId,
        sent_at: sentAt,
        delivered_at: null,
        read_at: null,
        failed_at: null,
      })
      .eq("kind", kind);
    if (waitlistId) q = q.eq("waitlist_id", waitlistId);
    else if (reservationId) q = q.eq("reservation_id", reservationId);
    else {
      jsonLog("warn", { evt: "record_notification_conflict_no_key", unit_id: unitId, kind });
      return;
    }
    const { error: updErr } = await q;
    if (updErr) {
      jsonLog("warn", { evt: "record_notification_update_failed", unit_id: unitId, kind, err: updErr.message });
    }
    return;
  }

  jsonLog("warn", { evt: "record_notification_failed", unit_id: unitId, kind, err: insErr.message });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let body: ExtendedPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { phone, message, channel_id, unit_id, kind, reservation_id, waitlist_id } = body;

  const authResult = await authorize(req, unit_id);
  if (!authResult.ok) {
    return new Response(
      JSON.stringify({ error: "unauthorized", reason: authResult.reason }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (!phone || !message) {
    return new Response(
      JSON.stringify({ error: "phone e message são obrigatórios" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const normalizedKind = kind && VALID_KINDS.has(kind) ? kind : null;

  try {
    const result = await sendWhatsApp(phone, message, { channel_id, unit_id });

    if (!result.ok) {
      jsonLog("warn", {
        evt: "send_whatsapp_failed",
        phone: sanitizePhone(phone),
        unit_id,
        channel_id,
        kind: normalizedKind,
        error: result.error,
        status: result.status,
        missingCreds: result.missingCreds,
      });
    }

    if (normalizedKind && unit_id) {
      await recordNotification(
        unit_id,
        normalizedKind,
        result.ok ? "sent" : "failed",
        result.ok ? null : result.error ?? "unknown_error",
        reservation_id ?? null,
        waitlist_id ?? null,
        result.providerMessageId ?? null,
      );
    }

    if (result.ok && normalizedKind && unit_id) {
      let customerId: string | null = null;
      try {
        if (reservation_id) {
          const { data: r } = await supabaseAdmin
            .from("reservations")
            .select("customer_id")
            .eq("id", reservation_id)
            .maybeSingle();
          customerId = (r?.customer_id as string | undefined) ?? null;
        } else if (waitlist_id) {
          const { data: w } = await supabaseAdmin
            .from("waitlist")
            .select("customer_id")
            .eq("id", waitlist_id)
            .maybeSingle();
          customerId = (w?.customer_id as string | undefined) ?? null;
        }
      } catch (err) {
        jsonLog("warn", {
          evt: "conversation_log_customer_lookup_failed",
          kind: normalizedKind,
          err: String(err).slice(0, 200),
        });
      }
      await appendOutboundToConversation({
        supabase: supabaseAdmin,
        unitId: unit_id,
        customerId,
        phone,
        content: message,
        kind: normalizedKind as OutboundKind,
      });
    }

    return new Response(
      JSON.stringify({
        success: result.ok,
        error: result.error,
        status: result.status,
        bodySnippet: result.bodySnippet,
        missingCreds: result.missingCreds,
      }),
      {
        status: result.ok ? 200 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    jsonLog("error", { evt: "send_whatsapp_error", err: String(err) });
    if (normalizedKind && unit_id) {
      await recordNotification(
        unit_id,
        normalizedKind,
        "failed",
        String(err).slice(0, 200),
        reservation_id ?? null,
        waitlist_id ?? null,
        null,
      );
    }
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

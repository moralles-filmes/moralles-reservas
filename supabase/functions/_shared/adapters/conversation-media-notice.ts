/**
 * Adapter de banco do aviso de mídia na rajada: os únicos `.rpc(` de
 * `record_conversation_media` e `claim_conversation_media_notices`. Valida o
 * contrato da resposta e lança em qualquer desvio (erro de leitura nunca vira
 * "permitido").
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  MEDIA_BURST_SECONDS,
  MEDIA_DEBOUNCE_GRACE_SECONDS,
} from "../media-reply-text.ts";

export type MediaDecision = "deferred" | "notice_now" | "suppressed" | "duplicate";

const DECISIONS: readonly string[] = ["deferred", "notice_now", "suppressed", "duplicate"];

export async function recordInboundMedia(
  supabase: SupabaseClient,
  input: { conversationId: string; message: Record<string, unknown>; noticeAllowed: boolean },
): Promise<{ decision: MediaDecision; variant: boolean }> {
  const { data, error } = await supabase.rpc("record_conversation_media", {
    p_conversation_id: input.conversationId,
    p_message: input.message,
    p_notice_allowed: input.noticeAllowed,
    p_burst_seconds: MEDIA_BURST_SECONDS,
    p_debounce_grace_seconds: MEDIA_DEBOUNCE_GRACE_SECONDS,
  });
  if (error) throw new Error("media_message_persist_failed");
  const row = data as { decision?: unknown; variant?: unknown } | null;
  if (
    !row || typeof row !== "object" ||
    typeof row.decision !== "string" || !DECISIONS.includes(row.decision) ||
    typeof row.variant !== "boolean"
  ) {
    throw new Error("media_message_persist_failed");
  }
  return { decision: row.decision as MediaDecision, variant: row.variant };
}

export async function claimDeferredMediaNotices(
  supabase: SupabaseClient,
  conversationId: string,
  sinceIso: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("claim_conversation_media_notices", {
    p_conversation_id: conversationId,
    p_since: sinceIso,
  });
  if (error) throw new Error("media_notice_claim_failed");
  return Array.isArray(data) ? data.filter((k): k is string => typeof k === "string") : [];
}

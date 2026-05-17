// Helper compartilhado para appendar mensagens outbound automáticas
// (confirmação, lembrete, pesquisa, cancelamento, voucher, waitlist) na
// timeline de `conversations.messages`. Best-effort: nunca lança — falha
// no log não pode interromper o envio do WhatsApp.
//
// Quando o cliente não tem `conversation` ainda (nunca conversou pelo
// WhatsApp), cria uma com status `ai_active` para que o operador veja o
// histórico completo desde a primeira interação automática.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";

export type OutboundKind =
  | "confirmation"
  | "reminder_d1"
  | "survey_d1"
  | "cancellation"
  | "voucher_issued"
  | "waitlist_entered"
  | "waitlist_table_ready"
  | "waitlist_feedback";

export interface AppendOutboundParams {
  supabase: SupabaseClient;
  unitId: string;
  customerId: string | null;
  phone: string | null;
  content: string;
  kind: OutboundKind;
}

export async function appendOutboundToConversation(
  params: AppendOutboundParams,
): Promise<void> {
  try {
    const { supabase, unitId, content, kind } = params;
    let customerId = params.customerId;

    if (!customerId && params.phone) {
      const { data: unit } = await supabase
        .from("units")
        .select("organization_id")
        .eq("id", unitId)
        .maybeSingle();
      if (unit?.organization_id) {
        const { data: cust } = await supabase
          .from("customers")
          .select("id")
          .eq("organization_id", unit.organization_id)
          .eq("phone", params.phone)
          .maybeSingle();
        customerId = cust?.id ?? null;
      }
    }

    if (!customerId) {
      jsonLog("info", {
        evt: "conversation_log_skipped",
        reason: "no_customer_id",
        kind,
        unit_id: unitId,
      });
      return;
    }

    const now = new Date().toISOString();
    const msg = {
      role: "assistant" as const,
      content,
      timestamp: now,
      kind,
    };

    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("unit_id", unitId)
      .eq("customer_id", customerId)
      .maybeSingle();

    if (conv) {
      const { error } = await supabase.rpc("append_conversation_message", {
        p_conversation_id: conv.id,
        p_message: msg,
      });
      if (error) {
        jsonLog("warn", {
          evt: "conversation_log_update_failed",
          kind,
          conversation_id: conv.id,
          err: error.message,
        });
      }
    } else {
      const { error } = await supabase.from("conversations").insert({
        unit_id: unitId,
        customer_id: customerId,
        messages: [msg],
        status: "ai_active",
        last_message_at: now,
      });
      if (error) {
        jsonLog("warn", {
          evt: "conversation_log_insert_failed",
          kind,
          customer_id: customerId,
          unit_id: unitId,
          err: error.message,
        });
      }
    }
  } catch (err) {
    jsonLog("warn", {
      evt: "conversation_log_error",
      kind: params.kind,
      err: String(err).slice(0, 200),
    });
  }
}

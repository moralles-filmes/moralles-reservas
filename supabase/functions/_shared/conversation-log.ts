// Helper compartilhado para appendar mensagens outbound automáticas
// (confirmação, lembrete, pesquisa, cancelamento, voucher, waitlist) na
// timeline de `conversations.messages`. Não lança depois do envio externo;
// devolve `persisted:false` para o caller expor reconciliação necessária.
//
// Quando o cliente não tem `conversation` ainda (nunca conversou pelo
// WhatsApp), cria uma com status `ai_active` para que o operador veja o
// histórico completo desde a primeira interação automática. A criação passa
// pela RPC serializada por unit+customer, nunca por SELECT→INSERT local.

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
  eventId?: string;
}

export interface AppendOutboundResult {
  persisted: boolean;
  reason?: string;
}

export async function appendOutboundToConversation(
  params: AppendOutboundParams,
): Promise<AppendOutboundResult> {
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
      return { persisted: false, reason: "no_customer_id" };
    }

    const now = new Date().toISOString();
    const msg = {
      event_id: params.eventId ?? crypto.randomUUID(),
      role: "assistant" as const,
      author: "automation" as const,
      content,
      timestamp: now,
      kind,
    };

    const { data: conversationId, error: conversationError } = await supabase.rpc(
      "get_or_create_whatsapp_conversation",
      {
        p_customer_id: customerId,
        p_unit_id: unitId,
        p_contact_name: null,
        p_chat_lid: null,
      },
    );
    if (conversationError || !conversationId) {
      jsonLog("warn", { evt: "conversation_log_resolve_failed", kind, unit_id: unitId });
      return { persisted: false, reason: "conversation_resolve_failed" };
    }

    let error: { message: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await supabase.rpc("append_conversation_message", {
        p_conversation_id: conversationId,
        p_message: msg,
      });
      error = result.error;
      if (!error) break;
    }
    if (error) {
      jsonLog("warn", {
        evt: "conversation_log_update_failed",
        kind,
        conversation_id: conversationId,
        err: error.message,
      });
      return { persisted: false, reason: "conversation_append_failed" };
    }
    return { persisted: true };
  } catch (err) {
    jsonLog("warn", {
      evt: "conversation_log_error",
      kind: params.kind,
      err: String(err).slice(0, 200),
    });
    return { persisted: false, reason: "conversation_log_error" };
  }
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { instagramKeys } from "@/features/instagram/types";
import { INSTAGRAM_WINDOW_MESSAGE } from "@/lib/conversation-channel";
import type { Conversation, ConversationMessage } from "@/types/reserva";

export interface ManualMessageSendResult {
  success: boolean;
  external_success?: boolean;
  local_success?: boolean;
  warning?: string;
}

export const OUTSIDE_SERVICE_WINDOW_MESSAGE =
  "A janela de 24 horas da Meta terminou. Aguarde uma nova mensagem do cliente para responder.";

export { INSTAGRAM_WINDOW_MESSAGE };

const INSTAGRAM_ERROR_MESSAGES: Record<string, string> = {
  INSTAGRAM_NOT_CONNECTED:
    "A conta do Instagram desta loja não está conectada. Conecte a conta na página do Instagram para responder.",
  INSTAGRAM_MODULE_DISABLED: "O módulo do Instagram está desativado para esta loja.",
  INSTAGRAM_REAUTH_REQUIRED:
    "A conexão com o Instagram expirou. Reconecte a conta na página do Instagram para responder.",
  INSTAGRAM_ACCOUNT_RECONNECTED: "A conta do Instagram foi reconectada. Tente enviar de novo.",
};

export type ManualSendErrorBody = {
  error?: string;
  reason?: string;
  code?: string;
  sent?: number;
  total?: number;
  outcome_unknown?: boolean;
} | null;

function partialSendMessage(body: NonNullable<ManualSendErrorBody>): string {
  const head =
    typeof body.sent === "number" && typeof body.total === "number"
      ? `Enviadas ${body.sent} de ${body.total} partes da mensagem.`
      : "Só parte da mensagem foi enviada.";
  return body.outcome_unknown === true
    ? `${head} A parte seguinte pode ter sido entregue: confira a conversa e não reenvie a mensagem.`
    : `${head} Confira a conversa antes de tentar enviar o restante.`;
}

export function manualMessageErrorMessage(
  reason: string,
  channel: "whatsapp" | "instagram" = "whatsapp",
  body: ManualSendErrorBody = null,
): string {
  if (reason === "OUTSIDE_SERVICE_WINDOW") {
    return channel === "instagram" ? INSTAGRAM_WINDOW_MESSAGE : OUTSIDE_SERVICE_WINDOW_MESSAGE;
  }
  if (reason === "PARTIAL_SEND" && body) return partialSendMessage(body);
  return Object.prototype.hasOwnProperty.call(INSTAGRAM_ERROR_MESSAGES, reason) ? INSTAGRAM_ERROR_MESSAGES[reason] : reason;
}

export function useSendManualMessage(unitId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ conversationId, message, channel = "whatsapp" }: { conversationId: string; message: string; channel?: "whatsapp" | "instagram" }) => {
      const { data, error } = await supabase.functions.invoke("send-manual-message", {
        body: { conversation_id: conversationId, message },
      });
      if (error) {
        // supabase-js v2 envolve qualquer non-2xx num FunctionsHttpError cuja .message é
        // sempre "Edge Function returned a non-2xx status code" — body real fica em
        // error.context.json(). Lemos pra surfar a mensagem útil ("conversa não está em
        // atendimento humano", "telefone do cliente não encontrado", etc.) e anexamos o
        // status pro onError decidir se precisa ressincronizar o cache.
        if (error instanceof FunctionsHttpError) {
          const body = (await error.context.json().catch(() => null)) as ManualSendErrorBody;
          const reason = body?.error ?? body?.reason ?? `HTTP ${error.context.status}`;
          throw Object.assign(new Error(manualMessageErrorMessage(reason, channel, body)), {
            httpStatus: error.context.status,
            code: body?.code ?? (reason === "PARTIAL_SEND" ? reason : undefined),
            reason,
          });
        }
        throw error;
      }
      if (!data?.success) throw new Error(data?.error ?? "Falha ao enviar mensagem");
      return data as ManualMessageSendResult;
    },
    onMutate: async ({ conversationId, message }) => {
      // Optimistic: empurra a mensagem na thread imediatamente. Se a Edge Function
      // falhar, onError restaura o snapshot anterior.
      await queryClient.cancelQueries({ queryKey: ["conversation-detail", conversationId] });
      const previous = queryClient.getQueryData<Conversation>(["conversation-detail", conversationId]);
      if (previous) {
        const optimistic: ConversationMessage = {
          event_id: crypto.randomUUID(),
          role: "human",
          author: "human",
          content: message,
          timestamp: new Date().toISOString(),
          human_user_id: user?.id,
        };
        queryClient.setQueryData<Conversation>(["conversation-detail", conversationId], {
          ...previous,
          messages: [...(previous.messages ?? []), optimistic],
          status: "human_active",
          last_message_at: optimistic.timestamp,
        });
      }
      return { previous };
    },
    onError: (err, { conversationId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["conversation-detail", conversationId], context.previous);
      }
      // 409 = backend rejeitou por status mismatch (conversa não está mais em mãos humanas).
      // Cache local ficou stale — forçar refetch traz o status real do banco, esconde o
      // input de envio e revela o botão "Assumir" condicional em Conversas.tsx.
      const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
      // Conta mudou de estado no servidor: a tela não pode seguir mostrando "conectada".
      const reason = (err as { reason?: string } | null)?.reason;
      if (reason === "INSTAGRAM_NOT_CONNECTED" || reason === "INSTAGRAM_REAUTH_REQUIRED" || reason === "INSTAGRAM_ACCOUNT_RECONNECTED") {
        queryClient.invalidateQueries({ queryKey: instagramKeys.connection(unitId) });
      }
      if (httpStatus === 409) {
        queryClient.invalidateQueries({ queryKey: ["conversation-detail", conversationId] });
        queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
        queryClient.invalidateQueries({ queryKey: ["whatsapp-templates", unitId] });
      }
    },
    onSettled: (_data, _err, { conversationId }) => {
      // Refetch real do servidor — substitui a mensagem optimistic pela versão canônica
      // (com human_user_id confirmado e timestamp do banco).
      queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
      queryClient.invalidateQueries({ queryKey: ["conversation-detail", conversationId] });
    },
  });
}

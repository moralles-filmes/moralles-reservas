import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import type { Conversation, ConversationMessage } from "@/types/reserva";

export function useSendManualMessage(unitId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ conversationId, message }: { conversationId: string; message: string }) => {
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
          const body = (await error.context.json().catch(() => null)) as
            | { error?: string; reason?: string }
            | null;
          const reason = body?.error ?? body?.reason ?? `HTTP ${error.context.status}`;
          throw Object.assign(new Error(reason), { httpStatus: error.context.status });
        }
        throw error;
      }
      if (!data?.success) throw new Error(data?.error ?? "Falha ao enviar mensagem");
    },
    onMutate: async ({ conversationId, message }) => {
      // Optimistic: empurra a mensagem na thread imediatamente. Se a Edge Function
      // falhar, onError restaura o snapshot anterior.
      await queryClient.cancelQueries({ queryKey: ["conversation-detail", conversationId] });
      const previous = queryClient.getQueryData<Conversation>(["conversation-detail", conversationId]);
      if (previous) {
        const optimistic: ConversationMessage = {
          role: "human",
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
      if (httpStatus === 409) {
        queryClient.invalidateQueries({ queryKey: ["conversation-detail", conversationId] });
        queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
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

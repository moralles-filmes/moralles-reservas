import { useMutation, useQueryClient } from "@tanstack/react-query";
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
      if (error) throw error;
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
    onError: (_err, { conversationId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["conversation-detail", conversationId], context.previous);
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

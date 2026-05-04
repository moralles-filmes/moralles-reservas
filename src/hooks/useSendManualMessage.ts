import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export function useSendManualMessage(unitId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ conversationId, message }: { conversationId: string; message: string }) => {
      const { data, error } = await supabase.functions.invoke("send-manual-message", {
        body: { conversation_id: conversationId, message },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "Falha ao enviar mensagem");
    },
    onSuccess: (_data, { conversationId }) => {
      queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
      queryClient.invalidateQueries({ queryKey: ["conversation-detail", conversationId] });
    },
  });
}

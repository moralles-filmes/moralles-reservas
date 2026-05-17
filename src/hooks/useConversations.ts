import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import type { Conversation, ConversationStatus } from "@/types/reserva";

export type ConversationFilter = ConversationStatus | "all";

export function useConversations(unitId: string, filter: ConversationFilter = "all") {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["conversations", unitId, filter],
    queryFn: async () => {
      let q = supabase
        .from("conversations")
        .select("*, customer:customers(*)")
        .eq("unit_id", unitId)
        .order("last_message_at", { ascending: false })
        .limit(200);

      if (filter !== "all") {
        q = q.eq("status", filter);
      }

      const { data, error } = await q;
      if (error) throw error;
      return data as Conversation[];
    },
    enabled: !!unitId,
  });

  // Realtime: invalidate when any conversation in this unit changes
  useEffect(() => {
    if (!unitId) return;
    const channel = supabase
      .channel(`conversations-unit-${unitId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `unit_id=eq.${unitId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
          queryClient.invalidateQueries({ queryKey: ["awaiting-human-count", unitId] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [unitId, queryClient]);

  return query;
}

export function useConversationActions(unitId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["conversations", unitId] });
    queryClient.invalidateQueries({ queryKey: ["awaiting-human-count", unitId] });
  }

  const assumeConversation = useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("conversations")
        .update({ status: "human_active", assigned_to: user?.id ?? null, updated_at: new Date().toISOString() })
        .eq("id", conversationId);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const releaseToAI = useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("conversations")
        .update({
          status: "ai_active",
          assigned_to: null,
          handoff_reason: null,
          handoff_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationId);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const markResolved = useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("conversations")
        .update({ status: "resolved", updated_at: new Date().toISOString() })
        .eq("id", conversationId);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { assumeConversation, releaseToAI, markResolved };
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import type { Conversation, ConversationStatus } from "@/types/reserva";

export type ConversationFilter = ConversationStatus | "all";

// Lista NÃO usa a coluna `messages` (JSONB grande): renderiza nome/telefone/
// status/handoff/last_message_at. O detalhe busca a conversa completa por id
// numa query separada (["conversation-detail", id]). Selecionar colunas
// explícitas sem `messages` derruba o payload por linha e viabiliza carregar
// TODAS as conversas (sem o antigo cap de 200) sem custo proibitivo.
const LIST_COLUMNS =
  "id, unit_id, customer_id, status, contact_name, assigned_to, handoff_reason, handoff_at, last_message_at, updated_at, created_at, customer:customers(*)";
const PAGE = 1000;

export function useConversations(unitId: string, filter: ConversationFilter = "all") {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["conversations", unitId, filter],
    queryFn: async () => {
      // PostgREST trunca em db-max-rows (1000) por request — paginar com
      // .range() em loop até esgotar pra não esconder conversas silenciosamente.
      const all: Conversation[] = [];
      for (let from = 0; ; from += PAGE) {
        let q = supabase
          .from("conversations")
          .select(LIST_COLUMNS)
          .eq("unit_id", unitId)
          .order("last_message_at", { ascending: false })
          .range(from, from + PAGE - 1);

        if (filter !== "all") {
          q = q.eq("status", filter);
        }

        const { data, error } = await q;
        if (error) throw error;
        // Cast via unknown: a lista omite `messages`/`reservation_id` de propósito
        // (detalhe busca a conversa completa por id), então o shape não sobrepõe.
        const chunk = (data ?? []) as unknown as Conversation[];
        all.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      return all;
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

  // "Resolver" é alias semântico de releaseToAI: ambos encerram o handoff e
  // devolvem pra IA. Mantemos o nome do método e o botão na UI pelo vocabulário
  // que o operador já usa, mas mecanicamente é o mesmo update — sem isso
  // sobravam `handoff_reason`/`handoff_at` no banco e a próxima mensagem do
  // cliente saía com a IA achando que ainda estava em handoff.
  const markResolved = useMutation({
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

  return { assumeConversation, releaseToAI, markResolved };
}

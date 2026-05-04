import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

export function useAwaitingHumanCount(unitId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["awaiting-human-count", unitId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("unit_id", unitId)
        .eq("status", "awaiting_human");
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!unitId,
    staleTime: 30_000,
  });

  // Realtime: keep badge in sync
  useEffect(() => {
    if (!unitId) return;
    const channel = supabase
      .channel(`awaiting-human-${unitId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `unit_id=eq.${unitId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["awaiting-human-count", unitId] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [unitId, queryClient]);

  return query.data ?? 0;
}

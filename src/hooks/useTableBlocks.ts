import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { TableBlock } from "@/types/reserva";

export function useTableBlocks(unitId: string, tableId?: string) {
  return useQuery({
    queryKey: ["table-blocks", unitId, tableId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("table_blocks")
        .select("*, table:tables!inner(id, unit_id, number, capacity, location, active)")
        .eq("tables.unit_id", unitId)
        .order("blocked_from", { ascending: false });
      if (tableId) query = query.eq("table_id", tableId);
      const { data, error } = await query;
      if (error) throw error;
      return data as TableBlock[];
    },
    enabled: !!unitId,
  });
}

export function useCreateTableBlock(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      table_id: string;
      blocked_from: string;
      blocked_to: string;
      reason?: string | null;
    }) => {
      const { data, error } = await supabase
        .from("table_blocks")
        .insert(input)
        .select("*, table:tables(*)")
        .single();
      if (error) throw error;
      return data as TableBlock;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["table-blocks", unitId] });
    },
  });
}

export function useDeleteTableBlock(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("table_blocks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["table-blocks", unitId] });
    },
  });
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { TableBlock } from "@/types/reserva";

export function useTableBlocks(tableId?: string) {
  return useQuery({
    queryKey: ["table-blocks", tableId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("table_blocks")
        .select("*, table:tables(*)")
        .order("blocked_from", { ascending: false });
      if (tableId) query = query.eq("table_id", tableId);
      const { data, error } = await query;
      if (error) throw error;
      return data as TableBlock[];
    },
  });
}

export function useCreateTableBlock() {
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
      queryClient.invalidateQueries({ queryKey: ["table-blocks"] });
    },
  });
}

export function useDeleteTableBlock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("table_blocks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["table-blocks"] });
    },
  });
}

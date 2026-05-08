import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { TableBlock } from "@/types/reserva";

export type TableBlockFilters = {
  /** ISO date (YYYY-MM-DD) — bloqueios cujo `blocked_to` é >= esse valor. */
  from?: string;
  /** ISO date (YYYY-MM-DD) — bloqueios cujo `blocked_from` é <= esse valor. */
  to?: string;
  hallId?: string;
};

export function useTableBlocks(unitId: string, filters?: TableBlockFilters) {
  return useQuery({
    queryKey: [
      "table-blocks",
      unitId,
      filters?.from ?? "",
      filters?.to ?? "",
      filters?.hallId ?? "",
    ],
    queryFn: async () => {
      let q = supabase
        .from("table_blocks")
        .select(
          "*, table:tables(id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active)",
        )
        .eq("unit_id", unitId)
        .order("blocked_from", { ascending: false });
      if (filters?.from) q = q.gte("blocked_to", `${filters.from}T00:00:00`);
      if (filters?.to) q = q.lte("blocked_from", `${filters.to}T23:59:59`);
      if (filters?.hallId) q = q.eq("hall_id", filters.hallId);
      const { data, error } = await q;
      if (error) throw error;
      return data as TableBlock[];
    },
    enabled: !!unitId,
  });
}

export type CreateTableBlockInput = {
  title: string;
  blocked_from: string;
  blocked_to: string;
  hall_id?: string | null;
  table_id?: string | null;
};

export function useCreateTableBlock(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTableBlockInput) => {
      const { data, error } = await supabase
        .from("table_blocks")
        .insert({
          unit_id: unitId,
          title: input.title,
          blocked_from: input.blocked_from,
          blocked_to: input.blocked_to,
          hall_id: input.hall_id ?? null,
          table_id: input.table_id ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return data as TableBlock;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["table-blocks", unitId] });
    },
  });
}

export function useUpdateTableBlock(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string } & Partial<Omit<CreateTableBlockInput, never>>,
    ) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("table_blocks")
        .update(patch)
        .eq("id", id)
        .select()
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

// ─── Overbooking flag (settings.allow_overbooking) ───────────────────────────

export function useOverbookingFlag(unitId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["setting", unitId, "allow_overbooking"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("value")
        .eq("unit_id", unitId)
        .eq("key", "allow_overbooking")
        .maybeSingle();
      if (error) throw error;
      const raw = data?.value;
      return raw === true || raw === "true" || raw === 1;
    },
    enabled: !!unitId,
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase
        .from("settings")
        .upsert(
          { unit_id: unitId, key: "allow_overbooking", value: enabled },
          { onConflict: "unit_id,key" },
        );
      if (error) throw error;
      return enabled;
    },
    onSuccess: (enabled) => {
      queryClient.setQueryData(["setting", unitId, "allow_overbooking"], enabled);
    },
  });

  return { value: query.data ?? false, isLoading: query.isLoading, set: mutation.mutate };
}

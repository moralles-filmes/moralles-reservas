import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { WalkIn, WalkInStatus } from "@/types/reserva";

export function useWalkIns(unitId: string, onlyActive = true) {
  return useQuery({
    queryKey: ["walk-ins", unitId, onlyActive],
    queryFn: async () => {
      let query = supabase
        .from("walk_ins")
        .select("*, table:tables(number)")
        .eq("unit_id", unitId)
        .order("arrived_at", { ascending: true });

      if (onlyActive) {
        query = query.in("status", ["waiting", "seated"]);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as WalkIn[];
    },
    enabled: !!unitId,
    refetchInterval: 30_000,
  });
}

export function useCreateWalkIn(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_name: string;
      customer_phone?: string | null;
      party_size: number;
      notes?: string | null;
    }) => {
      const { error } = await supabase.from("walk_ins").insert({
        unit_id: unitId,
        ...payload,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] });
      toast.success("Walk-in registrado.");
    },
    onError: () => toast.error("Erro ao registrar walk-in."),
  });
}

export function useUpdateWalkInStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, table_id }: { id: string; status: WalkInStatus; table_id?: string | null }) => {
      const updates: Record<string, unknown> = { status };
      if (status === "seated") updates.seated_at = new Date().toISOString();
      if (table_id !== undefined) updates.table_id = table_id;

      const { error } = await supabase.from("walk_ins").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] }),
    onError: () => toast.error("Erro ao atualizar status."),
  });
}

export function useDeleteWalkIn(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("walk_ins").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["walk-ins", unitId] }),
    onError: () => toast.error("Erro ao remover."),
  });
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Hall, HallSchedule } from "@/types/reserva";

export interface HallWithSchedules extends Hall {
  schedules: HallSchedule[];
}

/**
 * Halls ativos com seus hall_schedules aninhados (contexto autenticado).
 * RLS `unit_member_all_hall_schedules` / `platform_admin_all_hall_schedules`
 * permite ao membro/super-admin ler hall_schedules direto, então o select
 * aninhado funciona no painel. Usado pra derivar horários disponíveis numa data
 * via `getSlotsForDate` (mesma fonte do wizard público).
 */
export function useHallsWithSchedules(unitId: string) {
  return useQuery({
    queryKey: ["halls-with-schedules", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("halls")
        .select("*, schedules:hall_schedules(*)")
        .eq("unit_id", unitId)
        .eq("active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as HallWithSchedules[];
    },
    enabled: !!unitId,
  });
}

export function useHalls(unitId: string, { includeInactive = false } = {}) {
  return useQuery({
    queryKey: ["halls", unitId, includeInactive ? "all" : "active"],
    queryFn: async () => {
      let q = supabase
        .from("halls")
        .select("*")
        .eq("unit_id", unitId)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data as Hall[];
    },
    enabled: !!unitId,
  });
}

export function useHall(hallId: string | undefined) {
  return useQuery({
    queryKey: ["hall", hallId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("halls")
        .select("*")
        .eq("id", hallId!)
        .single();
      if (error) throw error;
      return data as Hall;
    },
    enabled: !!hallId,
  });
}

export function useCreateHall(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string | null;
      allow_empty_seat?: boolean;
      sort_order?: number;
    }) => {
      const { data, error } = await supabase
        .from("halls")
        .insert({ ...input, unit_id: unitId })
        .select()
        .single();
      if (error) throw error;
      return data as Hall;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["halls", unitId] });
    },
  });
}

export function useUpdateHall(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & Partial<Omit<Hall, "id" | "unit_id" | "created_at" | "updated_at">>) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("halls")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Hall;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["halls", unitId] });
      qc.invalidateQueries({ queryKey: ["hall", variables.id] });
    },
  });
}

export function useDeleteHall(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("halls").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["halls", unitId] });
    },
  });
}

import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Hall, HallSchedule } from "@/types/reserva";
import { HALL_NOT_IN_UNIT_MESSAGE, assertWrote } from "@/lib/layout-errors";

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

/**
 * Salão da unidade ativa. A RLS libera todas as unidades do membro, então o
 * filtro de `unit_id` é o que impede abrir o salão de outra unidade dentro desta
 * tela; salão alheio ou inexistente volta `null`.
 */
export function useHall(unitId: string, hallId: string | undefined) {
  return useQuery({
    queryKey: ["hall", unitId, hallId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("halls")
        .select("*")
        .eq("id", hallId!)
        .eq("unit_id", unitId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Hall | null;
    },
    enabled: !!unitId && !!hallId,
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
    onSuccess: () => invalidateHallLists(qc, unitId),
  });
}

/** Listas de salão da unidade (tela de salões, horários agregados, faixa de horário, reserva manual). */
function invalidateHallLists(qc: QueryClient, unitId: string) {
  for (const entity of ["halls", "halls-with-schedules", "all-hall-schedules", "unit-hour-range"]) {
    qc.invalidateQueries({ queryKey: [entity, unitId] });
  }
}

export function useUpdateHall(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & Partial<Omit<Hall, "id" | "unit_id" | "created_at" | "updated_at">>) => {
      // `unit_id` fora do patch também em tempo de execução: mover salão de unidade não é desta tela.
      const { id, unit_id: _unit, ...patch } = input as typeof input & { unit_id?: unknown };
      const { data, error } = await supabase
        .from("halls")
        .update(patch)
        .eq("id", id)
        .eq("unit_id", unitId)
        .select();
      if (error) throw error;
      assertWrote(data, HALL_NOT_IN_UNIT_MESSAGE);
      return data![0] as Hall;
    },
    onSettled: (_data, _err, variables) => {
      invalidateHallLists(qc, unitId);
      qc.invalidateQueries({ queryKey: ["hall", unitId, variables.id] });
    },
  });
}

export function useDeleteHall(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("halls")
        .delete()
        .eq("id", id)
        .eq("unit_id", unitId)
        .select("id");
      if (error) throw error;
      assertWrote(data, HALL_NOT_IN_UNIT_MESSAGE);
    },
    onSettled: (_data, _err, id) => {
      invalidateHallLists(qc, unitId);
      // A cascata apaga os horários e solta as mesas do salão.
      qc.invalidateQueries({ queryKey: ["hall", unitId, id] });
      qc.invalidateQueries({ queryKey: ["hall-tables", unitId, id] });
      qc.invalidateQueries({ queryKey: ["hall-schedules", unitId, id] });
      qc.invalidateQueries({ queryKey: ["unit-tables", unitId] });
    },
  });
}

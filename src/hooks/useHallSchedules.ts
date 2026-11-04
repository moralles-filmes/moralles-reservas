import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { HallSchedule } from "@/types/reserva";
import { HALL_NOT_IN_UNIT_MESSAGE, assertWrote } from "@/lib/layout-errors";

/**
 * Horários de um salão da unidade ativa. `hall_schedules` não tem `unit_id`:
 * o filtro é pelo salão embutido (`halls!inner`), e o embed sai do resultado.
 */
export function useHallSchedules(unitId: string, hallId: string | undefined) {
  return useQuery({
    queryKey: ["hall-schedules", unitId, hallId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hall_schedules")
        .select("*, halls!inner(unit_id)")
        .eq("hall_id", hallId!)
        .eq("halls.unit_id", unitId)
        .order("day_of_week", { ascending: true })
        .order("open_time", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<HallSchedule & { halls?: unknown }>).map(({ halls: _halls, ...s }) => s as HallSchedule);
    },
    enabled: !!unitId && !!hallId,
  });
}

export type HallScheduleInput = {
  /** Salão já conferido como da unidade ativa pela tela (`useHall`). */
  hall_id: string;
  days: number[]; // 0=domingo … 6=sábado
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_advance_minutes?: number;
  discount_percent?: number;
  charge_enabled?: boolean;
  charge_amount_cents?: number | null;
};

export function useCreateHallSchedules(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: HallScheduleInput) => {
      const rows = input.days.map((dow) => ({
        hall_id: input.hall_id,
        day_of_week: dow,
        open_time: input.open_time,
        close_time: input.close_time,
        slot_minutes: input.slot_minutes,
        min_advance_minutes: input.min_advance_minutes ?? 0,
        discount_percent: input.discount_percent ?? 0,
        charge_enabled: input.charge_enabled ?? false,
        charge_amount_cents: input.charge_amount_cents ?? null,
      }));
      const { data, error } = await supabase
        .from("hall_schedules")
        .insert(rows)
        .select();
      if (error) throw error;
      return data as HallSchedule[];
    },
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", unitId, variables.hall_id] });
    },
  });
}

/**
 * O PostgREST não filtra UPDATE/DELETE por recurso embutido: o predicado é o
 * `hall_id`, já conferido como da unidade ativa pela tela, e o retorno é conferido.
 */
export function useUpdateHallSchedule(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hall_id: string } & Partial<Omit<HallSchedule, "id" | "hall_id" | "created_at">>) => {
      const { id, hall_id, ...patch } = input;
      const { data, error } = await supabase
        .from("hall_schedules")
        .update(patch)
        .eq("id", id)
        .eq("hall_id", hall_id)
        .select();
      if (error) throw error;
      assertWrote(data, HALL_NOT_IN_UNIT_MESSAGE);
      return data![0] as HallSchedule;
    },
    onSettled: (_data, _err, input) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", unitId, input.hall_id] });
    },
  });
}

export function useDeleteHallSchedule(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hall_id: string }) => {
      const { data, error } = await supabase
        .from("hall_schedules")
        .delete()
        .eq("id", input.id)
        .eq("hall_id", input.hall_id)
        .select("id");
      if (error) throw error;
      assertWrote(data, HALL_NOT_IN_UNIT_MESSAGE);
      return input;
    },
    onSettled: (_data, _err, input) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", unitId, input.hall_id] });
    },
  });
}

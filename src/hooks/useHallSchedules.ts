import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { HallSchedule } from "@/types/reserva";

export function useHallSchedules(hallId: string | undefined) {
  return useQuery({
    queryKey: ["hall-schedules", hallId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hall_schedules")
        .select("*")
        .eq("hall_id", hallId!)
        .order("day_of_week", { ascending: true })
        .order("open_time", { ascending: true });
      if (error) throw error;
      return data as HallSchedule[];
    },
    enabled: !!hallId,
  });
}

export type HallScheduleInput = {
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

export function useCreateHallSchedules() {
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
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", variables.hall_id] });
    },
  });
}

export function useUpdateHallSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & Partial<Omit<HallSchedule, "id" | "hall_id" | "created_at">>) => {
      const { id, ...patch } = input;
      const { data, error } = await supabase
        .from("hall_schedules")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as HallSchedule;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", data.hall_id] });
    },
  });
}

export function useDeleteHallSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; hall_id: string }) => {
      const { error } = await supabase
        .from("hall_schedules")
        .delete()
        .eq("id", input.id);
      if (error) throw error;
      return input;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["hall-schedules", data.hall_id] });
    },
  });
}

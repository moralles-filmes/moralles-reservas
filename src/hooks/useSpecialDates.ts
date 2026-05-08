import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { SpecialDate } from "@/types/reserva";

export function useSpecialDates(
  unitId: string,
  filters?: { from?: string; to?: string },
) {
  return useQuery({
    queryKey: ["special-dates", unitId, filters?.from ?? "", filters?.to ?? ""],
    queryFn: async () => {
      let q = supabase
        .from("special_dates")
        .select("*")
        .eq("unit_id", unitId)
        .order("date", { ascending: true });
      // Filtro por range: traz overrides que se sobrepõem com [from, to]
      if (filters?.from) q = q.gte("end_date", filters.from);
      if (filters?.to) q = q.lte("date", filters.to);
      const { data, error } = await q;
      if (error) throw error;
      return data as SpecialDate[];
    },
    enabled: !!unitId,
  });
}

export type SpecialDateInput = {
  id?: string;
  hall_id?: string | null;
  date: string;
  end_date: string;
  name: string;
  is_closed?: boolean;
  open_time?: string | null;
  close_time?: string | null;
  max_party_size?: number | null;
  slot_minutes?: number | null;
  min_advance_minutes?: number | null;
  discount_percent?: number | null;
  charge_enabled?: boolean;
  charge_amount_cents?: number | null;
  notes?: string | null;
};

export function useUpsertSpecialDate(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SpecialDateInput) => {
      const payload = { ...input, unit_id: unitId };
      const { data, error } = await supabase
        .from("special_dates")
        .upsert(payload)
        .select()
        .single();
      if (error) throw error;
      return data as SpecialDate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["special-dates", unitId] });
    },
  });
}

export function useDeleteSpecialDate(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("special_dates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["special-dates", unitId] });
    },
  });
}

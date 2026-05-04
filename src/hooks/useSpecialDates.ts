import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { SpecialDate } from "@/types/reserva";

export function useSpecialDates(unitId: string) {
  return useQuery({
    queryKey: ["special-dates", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("special_dates")
        .select("*")
        .eq("unit_id", unitId)
        .order("date", { ascending: true });
      if (error) throw error;
      return data as SpecialDate[];
    },
    enabled: !!unitId,
  });
}

export function useUpsertSpecialDate(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<SpecialDate> & { date: string; name: string }) => {
      const payload = { ...input, unit_id: unitId };
      const { data, error } = await supabase
        .from("special_dates")
        .upsert(payload, { onConflict: "unit_id,date" })
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

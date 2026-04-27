import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { SpecialDate } from "@/types/reserva";

export function useSpecialDates() {
  return useQuery({
    queryKey: ["special-dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("special_dates")
        .select("*")
        .order("date", { ascending: true });
      if (error) throw error;
      return data as SpecialDate[];
    },
  });
}

export function useUpsertSpecialDate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<SpecialDate> & { date: string; name: string }) => {
      const { data, error } = await supabase
        .from("special_dates")
        .upsert(input, { onConflict: "date" })
        .select()
        .single();
      if (error) throw error;
      return data as SpecialDate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["special-dates"] });
    },
  });
}

export function useDeleteSpecialDate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("special_dates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["special-dates"] });
    },
  });
}

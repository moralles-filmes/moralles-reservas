import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Customer, CustomerStats } from "@/types/reserva";

export function useUpdateCustomer(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<
        Pick<
          Customer,
          | "name"
          | "phone"
          | "email"
          | "allergies"
          | "dietary_restrictions"
          | "vip_notes"
          | "preferred_table_location"
          | "do_not_contact"
        >
      >;
    }) => {
      const { data, error } = await supabase
        .from("customers")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Customer;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", unitId] });
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

export function useAnonymizeCustomer(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (customerId: string) => {
      const { error } = await supabase.rpc("anonymize_customer", {
        p_id: customerId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", unitId] });
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

export function useCustomerStats(customerId: string | undefined, unitId?: string) {
  return useQuery({
    queryKey: ["customer-stats", customerId, unitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_customer_stats", {
        p_customer_id: customerId,
        ...(unitId ? { p_unit_id: unitId } : {}),
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? {
        total: 0,
        confirmed: 0,
        no_shows: 0,
        cancelled: 0,
        no_show_rate: 0,
        last_visit: null,
      }) as CustomerStats;
    },
    enabled: !!customerId,
  });
}

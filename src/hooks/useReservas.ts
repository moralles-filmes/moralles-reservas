import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Reserva, ReservaFormData, ReservaStatus } from "@/types/reserva";
import { generateReservationCode } from "@/lib/utils";

export function useReservas(filters?: {
  date?: string;
  status?: ReservaStatus;
  search?: string;
}) {
  return useQuery({
    queryKey: ["reservas", filters],
    queryFn: async () => {
      let query = supabase
        .from("reservations")
        .select("*, customer:customers(*), table:tables(*)")
        .order("date", { ascending: true })
        .order("time", { ascending: true });

      if (filters?.date) query = query.eq("date", filters.date);
      if (filters?.status) query = query.eq("status", filters.status);
      if (filters?.search) {
        query = query.or(
          `reservation_code.ilike.%${filters.search}%,customers.name.ilike.%${filters.search}%,customers.phone.ilike.%${filters.search}%`
        );
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as Reserva[];
    },
  });
}

export function useReservaByCode(code: string) {
  return useQuery({
    queryKey: ["reserva", code],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select("*, customer:customers(*), table:tables(*)")
        .eq("reservation_code", code.toUpperCase())
        .maybeSingle();
      if (error) throw error;
      return data as Reserva | null;
    },
    enabled: !!code,
  });
}

export function useReservasHoje() {
  const today = new Date().toISOString().split("T")[0];
  return useReservas({ date: today });
}

export function useCreateReserva() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: ReservaFormData) => {
      // Upsert customer by phone
      const { data: customer, error: custError } = await supabase
        .from("customers")
        .upsert(
          { name: data.name, phone: data.phone, email: data.email || null },
          { onConflict: "phone" }
        )
        .select()
        .single();
      if (custError) throw custError;

      const code = generateReservationCode();

      const { data: reserva, error } = await supabase
        .from("reservations")
        .insert({
          customer_id: customer.id,
          date: data.date,
          time: data.time,
          party_size: data.party_size,
          notes: data.notes || null,
          reservation_code: code,
          status: "pending",
        })
        .select("*, customer:customers(*)")
        .single();

      if (error) throw error;
      return reserva as Reserva;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas"] });
    },
  });
}

export function useUpdateReservaStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: ReservaStatus;
    }) => {
      const { data, error } = await supabase
        .from("reservations")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Reserva;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas"] });
    },
  });
}

export function useUpdateReserva() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<Pick<Reserva, "date" | "time" | "party_size" | "notes" | "table_id">>;
    }) => {
      const { data, error } = await supabase
        .from("reservations")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("*, customer:customers(*), table:tables(*)")
        .single();
      if (error) throw error;
      return data as Reserva;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas"] });
    },
  });
}

export function useReservaStats() {
  return useQuery({
    queryKey: ["reserva-stats"],
    queryFn: async () => {
      const today = new Date().toISOString().split("T")[0];
      const { data, error } = await supabase
        .from("reservations")
        .select("status, party_size, date")
        .gte("date", today);
      if (error) throw error;

      const hoje = data.filter((r) => r.date === today);
      return {
        total_hoje: hoje.length,
        confirmadas_hoje: hoje.filter((r) => r.status === "confirmed").length,
        pendentes_hoje: hoje.filter((r) => r.status === "pending").length,
        pessoas_hoje: hoje
          .filter((r) => r.status !== "cancelled")
          .reduce((acc, r) => acc + r.party_size, 0),
      };
    },
  });
}

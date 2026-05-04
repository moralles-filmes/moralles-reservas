import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Reserva, ReservaFormData, ReservaStatus } from "@/types/reserva";
import { generateReservationCode } from "@/lib/utils";

interface ReservationByCodeRow {
  id: string;
  reservation_code: string;
  date: string;
  time: string;
  party_size: number;
  status: ReservaStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
}

export function mapRpcRowToReserva(row: ReservationByCodeRow | null | undefined): Reserva | null {
  if (!row) return null;
  return {
    id: row.id,
    unit_id: "",
    customer_id: "",
    table_id: null,
    date: row.date,
    time: row.time,
    party_size: row.party_size,
    status: row.status,
    notes: row.notes,
    reservation_code: row.reservation_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer: {
      id: "",
      organization_id: "",
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
      created_at: row.created_at,
    },
  };
}

export function useReservas(
  unitId: string,
  filters?: {
    date?: string;
    status?: ReservaStatus;
    search?: string;
  }
) {
  return useQuery({
    queryKey: ["reservas", unitId, filters],
    queryFn: async () => {
      let query = supabase
        .from("reservations")
        .select("*, customer:customers(*), table:tables(*)")
        .eq("unit_id", unitId)
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
    enabled: !!unitId,
  });
}

export function useReservaByCode(code: string, unitId?: string) {
  return useQuery({
    queryKey: ["reserva", code, unitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_reservation_by_code", {
        p_code: code.toUpperCase(),
        ...(unitId ? { p_unit_id: unitId } : {}),
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return mapRpcRowToReserva(row as ReservationByCodeRow | null);
    },
    enabled: !!code,
  });
}

export function useReservasHoje(unitId: string) {
  const today = new Date().toISOString().split("T")[0];
  return useReservas(unitId, { date: today });
}

export interface CreateReservaParams extends ReservaFormData {
  unit_id: string;
  organization_id: string;
}

export function useCreateReserva() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateReservaParams) => {
      const { data: customer, error: custError } = await supabase
        .from("customers")
        .upsert(
          {
            name: data.name,
            phone: data.phone,
            email: data.email || null,
            organization_id: data.organization_id,
          },
          { onConflict: "organization_id,phone" }
        )
        .select()
        .single();
      if (custError) throw custError;

      const code = generateReservationCode();

      const { data: reserva, error } = await supabase
        .from("reservations")
        .insert({
          customer_id: customer.id,
          unit_id: data.unit_id,
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
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["reservas", vars.unit_id] });
    },
  });
}

export function useUpdateReservaStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ReservaStatus }) => {
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
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

export function useUpdateReserva(unitId: string) {
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
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

export function useReservaStats(unitId: string) {
  return useQuery({
    queryKey: ["reserva-stats", unitId],
    queryFn: async () => {
      const today = new Date().toISOString().split("T")[0];
      const { data, error } = await supabase
        .from("reservations")
        .select("status, party_size, date")
        .eq("unit_id", unitId)
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
    enabled: !!unitId,
  });
}

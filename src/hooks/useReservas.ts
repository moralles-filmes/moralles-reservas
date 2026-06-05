import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { todayLocalISO } from "@/lib/utils";
import type { Reserva, ReservaFormData, ReservaStatus } from "@/types/reserva";

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
      const term = filters?.search?.trim();

      // Path A — sem busca por termo: query direta com join.
      if (!term) {
        let query = supabase
          .from("reservations")
          .select("*, customer:customers(*), table:tables(*)")
          .eq("unit_id", unitId)
          .order("date", { ascending: true })
          .order("time", { ascending: true });

        if (filters?.date) query = query.eq("date", filters.date);
        if (filters?.status) query = query.eq("status", filters.status);

        const { data, error } = await query;
        if (error) throw error;
        return data as Reserva[];
      }

      // Path B — com busca: PostgREST não suporta `.or()` cross-table, então
      // usamos a RPC `search_reservations` (criada na migration 055) que faz
      // o JOIN no servidor e devolve o conjunto. O `.select(...)` em cima da
      // RPC adiciona o embedding de customer/table.
      const { data, error } = await supabase
        .rpc("search_reservations", {
          p_unit_id: unitId,
          p_term: term,
          p_date: filters?.date ?? null,
          p_status: filters?.status ?? null,
        })
        .select("*, customer:customers(*), table:tables(*)");
      if (error) throw error;
      return (data ?? []) as Reserva[];
    },
    enabled: !!unitId,
  });
}

export function useReservaByCode(code: string, unitId: string) {
  return useQuery({
    queryKey: ["reserva", code, unitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_reservation_by_code", {
        p_code: code.toUpperCase(),
        p_unit_id: unitId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return mapRpcRowToReserva(row as ReservationByCodeRow | null);
    },
    enabled: !!code && !!unitId,
  });
}

export function useReservasHoje(unitId: string) {
  const today = todayLocalISO();
  return useReservas(unitId, { date: today });
}

export interface CreateReservaParams extends ReservaFormData {
  unit_id: string;
  organization_id: string;
  hall_id?: string | null;
  widget_id?: string;
  custom_field_values?: Record<string, string>;
  birthday?: string | null;
}

interface CreateReservationFnResponse {
  success: boolean;
  reason?: string;
  message?: string;
  reservation_id?: string;
  reservation_code?: string;
  table_id?: string;
  requires_payment?: boolean;
  payment_amount_cents?: number | null;
  customer?: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
  };
}

const REASON_MESSAGES: Record<string, string> = {
  closed_day: "Estamos fechados nesta data.",
  outside_hours: "Este horário está fora do nosso atendimento.",
  no_capacity: "Não há mesa disponível para esse horário.",
  all_blocked: "Todas as mesas estão bloqueadas neste horário.",
  rate_limited: "Muitas tentativas. Aguarde um instante e tente novamente.",
  invalid_input: "Dados da reserva inválidos.",
  unit_invalid: "Unidade inválida.",
};

export function useCreateReserva() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateReservaParams) => {
      const { data: response, error } = await supabase.functions.invoke<CreateReservationFnResponse>(
        "create-reservation",
        {
          body: {
            unit_id: data.unit_id,
            organization_id: data.organization_id,
            hall_id: data.hall_id ?? null,
            widget_id: data.widget_id ?? null,
            custom_field_values: data.custom_field_values ?? null,
            customer: {
              name: data.name,
              phone: data.phone,
              email: data.email || null,
              birthday: data.birthday || null,
            },
            date: data.date,
            time: data.time,
            party_size: data.party_size,
            notes: data.notes || null,
          },
        }
      );

      if (error) {
        // Edge Function pode retornar erro estruturado em error.context.body
        type WithContext = { context?: { body?: string } };
        const ctx = (error as WithContext).context;
        if (ctx?.body) {
          try {
            const parsed = JSON.parse(ctx.body) as CreateReservationFnResponse;
            const fallback = parsed.reason ? REASON_MESSAGES[parsed.reason] : undefined;
            throw new Error(parsed.message || fallback || error.message);
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
          }
        }
        throw error;
      }

      if (!response || !response.success) {
        const reasonMsg = response?.reason ? REASON_MESSAGES[response.reason] : undefined;
        throw new Error(response?.message || reasonMsg || "Não foi possível criar a reserva.");
      }

      const now = new Date().toISOString();
      const reserva: Reserva = {
        id: response.reservation_id!,
        unit_id: data.unit_id,
        customer_id: response.customer!.id,
        table_id: response.table_id ?? null,
        date: data.date,
        time: data.time,
        party_size: data.party_size,
        status: "pending",
        notes: data.notes || null,
        reservation_code: response.reservation_code!,
        payment_status: response.requires_payment ? "pending_payment" : undefined,
        payment_amount_cents: response.payment_amount_cents ?? undefined,
        created_at: now,
        updated_at: now,
        customer: {
          id: response.customer!.id,
          organization_id: data.organization_id,
          name: response.customer!.name,
          phone: response.customer!.phone,
          email: response.customer!.email,
          created_at: now,
        },
      };

      // If payment required, create Stripe Checkout Session and attach URL
      if (response.requires_payment) {
        try {
          const { data: checkoutData, error: checkoutErr } =
            await supabase.functions.invoke("create-checkout-session", {
              body: { reservation_id: response.reservation_id },
            });
          if (!checkoutErr && checkoutData?.checkout_url) {
            (reserva as Reserva & { checkoutUrl?: string }).checkoutUrl =
              checkoutData.checkout_url;
          }
        } catch {
          // Payment session failed — reservation still created, user can retry
        }
      }

      return reserva as Reserva & { checkoutUrl?: string };
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["reservas", vars.unit_id] });
    },
  });
}

export interface CreateManualReservaParams {
  unit_id: string;
  organization_id: string;
  hall_id?: string | null;
  name: string;
  phone: string;
  email?: string | null;
  birthday?: string | null;
  date: string;
  time: string;
  party_size: number;
  notes?: string | null;
  /** Origem registrada na reserva — só pra relatório "Origem das reservas". */
  source: "web" | "whatsapp";
  status: "pending" | "confirmed";
  /** Disparar confirmação automática (desacoplado da origem). */
  notify: boolean;
  /** Forçar reserva mesmo sem mesa/fora de horário (cria flutuante). */
  override: boolean;
}

interface ManualReservationFnResponse {
  success: boolean;
  reason?: string;
  message?: string;
  reservation_id?: string;
  reservation_code?: string;
  table_id?: string | null;
  customer?: { id: string; name: string; phone: string; email: string | null };
}

/** Reserva manual lançada pelo operador no painel (EF autenticada). */
export function useCreateManualReserva(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateManualReservaParams) => {
      const { data: response, error } = await supabase.functions.invoke<ManualReservationFnResponse>(
        "create-manual-reservation",
        {
          body: {
            unit_id: data.unit_id,
            organization_id: data.organization_id,
            hall_id: data.hall_id ?? null,
            customer: {
              name: data.name,
              phone: data.phone,
              email: data.email || null,
              birthday: data.birthday || null,
            },
            date: data.date,
            time: data.time,
            party_size: data.party_size,
            notes: data.notes || null,
            source: data.source,
            status: data.status,
            notify: data.notify,
            override: data.override,
          },
        }
      );

      if (error) {
        // supabase.functions.invoke mascara o corpo non-2xx — extrair de context.body.
        type WithContext = { context?: { body?: string } };
        const ctx = (error as WithContext).context;
        if (ctx?.body) {
          try {
            const parsed = JSON.parse(ctx.body) as ManualReservationFnResponse;
            const fallback = parsed.reason ? REASON_MESSAGES[parsed.reason] : undefined;
            throw new Error(parsed.message || fallback || error.message);
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
          }
        }
        throw error;
      }

      if (!response || !response.success) {
        const reasonMsg = response?.reason ? REASON_MESSAGES[response.reason] : undefined;
        throw new Error(response?.message || reasonMsg || "Não foi possível criar a reserva.");
      }

      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
      queryClient.invalidateQueries({ queryKey: ["reserva-stats", unitId] });
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

      if (status === "cancelled") {
        // Fire-and-forget: não bloquear o fluxo de UI se a notificação WhatsApp falhar.
        supabase.functions
          .invoke("send-cancellation", { body: { reservation_id: id } })
          .then(({ error: fnErr }) => {
            if (fnErr) {
              console.error("send-cancellation failed", fnErr);
              toast.error("Reserva cancelada, mas falha ao notificar o cliente.");
            }
          });
      }

      return data as Reserva;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

interface UpdateReservaInput {
  id: string;
  updates: Partial<Pick<Reserva, "date" | "time" | "party_size" | "notes" | "table_id">> & {
    hall_id?: string | null;
  };
  /** Se true, pula a revalidação de disponibilidade (escape hatch para casos
   *  legítimos onde o gerente sabe o que está fazendo). Default false. */
  override?: boolean;
}

interface UpdateReservaResponse {
  success: boolean;
  reserva?: Reserva;
  error?: string;
  reason?: string;
}

export function useUpdateReserva(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates, override }: UpdateReservaInput) => {
      // Chama Edge Function `update-reservation` que revalida disponibilidade
      // antes de aplicar o UPDATE — evita deixar reservas em horário sem
      // capacidade ou em mesa bloqueada quando o gerente move uma reserva.
      const { data: response, error } = await supabase.functions.invoke<UpdateReservaResponse>(
        "update-reservation",
        {
          body: {
            reservation_id: id,
            updates,
            override: override ?? false,
          },
        }
      );

      if (error) {
        type WithContext = { context?: { body?: string } };
        const ctx = (error as WithContext).context;
        if (ctx?.body) {
          try {
            const parsed = JSON.parse(ctx.body) as UpdateReservaResponse;
            throw new Error(parsed.error || error.message);
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
          }
        }
        throw error;
      }

      if (!response?.success || !response.reserva) {
        throw new Error(response?.error || "Falha ao atualizar reserva.");
      }
      return response.reserva;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservas", unitId] });
    },
  });
}

export interface ReservaStatsToday {
  total_hoje: number;
  confirmadas_hoje: number;
  pendentes_hoje: number;
  canceladas_hoje: number;
  no_show_hoje: number;
  pessoas_hoje: number;
}

export function useReservaStats(unitId: string) {
  return useQuery<ReservaStatsToday>({
    queryKey: ["reserva-stats", unitId],
    queryFn: async () => {
      const today = todayLocalISO();
      const { data, error } = await supabase
        .from("reservations")
        .select("status, party_size, date")
        .eq("unit_id", unitId)
        .eq("date", today);
      if (error) throw error;

      const hoje = data ?? [];
      return {
        total_hoje: hoje.length,
        confirmadas_hoje: hoje.filter((r) => r.status === "confirmed").length,
        pendentes_hoje: hoje.filter((r) => r.status === "pending").length,
        canceladas_hoje: hoje.filter((r) => r.status === "cancelled").length,
        no_show_hoje: hoje.filter((r) => r.status === "no_show").length,
        // "Pessoas esperadas": apenas reservas que ainda podem comparecer.
        pessoas_hoje: hoje
          .filter((r) => r.status === "pending" || r.status === "confirmed")
          .reduce((acc, r) => acc + r.party_size, 0),
      };
    },
    enabled: !!unitId,
  });
}

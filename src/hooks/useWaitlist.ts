import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  WaitlistEntry,
  WaitlistPriorityCategory,
  WaitlistStatus,
} from "@/types/reserva";

export function useWaitlist(unitId: string, onlyActive = true) {
  return useQuery({
    queryKey: ["waitlist", unitId, onlyActive],
    queryFn: async () => {
      let query = supabase
        .from("waitlist")
        .select("*")
        .eq("unit_id", unitId)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true });

      if (onlyActive) {
        query = query.in("status", ["waiting", "notified"]);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as WaitlistEntry[];
    },
    enabled: !!unitId,
    refetchInterval: 30_000,
  });
}

export interface AnonWaitlistInput {
  customer_name: string;
  customer_phone: string;
  party_size: number;
  notes?: string | null;
  priority_category?: WaitlistPriorityCategory;
}

/** Resposta do hook de inserção anônima — inclui o código gerado pra exibir
 *  na confirmação. */
export interface AnonWaitlistResult {
  code: number | null;
}

/**
 * Resultado da RPC atômica `enter_waitlist`. Postgres retorna como array
 * (RETURNS TABLE) — pegamos o primeiro row.
 */
interface EnterWaitlistRow {
  waitlist_id: string;
  code: number | null;
}

export function useAnonAddToWaitlist(unitId: string) {
  return useMutation<AnonWaitlistResult, Error, AnonWaitlistInput>({
    mutationFn: async (payload) => {
      // RPC atômica (mig 053) — advisory lock por unit + next_code + INSERT
      // numa única transação. Elimina race do code entre clientes simultâneos.
      const { data, error } = await supabase.rpc("enter_waitlist", {
        p_unit_id: unitId,
        p_customer_name: payload.customer_name,
        p_customer_phone: payload.customer_phone,
        p_party_size: payload.party_size,
        p_notes: payload.notes ?? null,
        p_priority_category: payload.priority_category ?? "normal",
      });
      if (error) throw error;
      const row = Array.isArray(data) ? (data[0] as EnterWaitlistRow | undefined) : null;
      return { code: row?.code ?? null };
    },
    onError: () => {
      // Mensagem genérica — não vaza err.message do Supabase (RLS/schema/etc).
      toast.error("Não foi possível entrar na fila. Tente novamente.");
    },
  });
}

export function useAddToWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_name: string;
      customer_phone?: string | null;
      party_size: number;
      requested_for_time?: string | null;
      notes?: string | null;
      priority_category?: WaitlistPriorityCategory;
    }) => {
      const { error } = await supabase.rpc("enter_waitlist", {
        p_unit_id: unitId,
        p_customer_name: payload.customer_name,
        p_customer_phone: payload.customer_phone ?? null,
        p_party_size: payload.party_size,
        p_notes: payload.notes ?? null,
        p_priority_category: payload.priority_category ?? "normal",
        p_requested_for_time: payload.requested_for_time ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      toast.success("Adicionado à fila.");
    },
    onError: () => toast.error("Erro ao adicionar à fila."),
  });
}

export function useUpdateWaitlistStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: WaitlistStatus }) => {
      const updates: Record<string, unknown> = { status };
      if (status === "notified") updates.notified_at = new Date().toISOString();

      const { error } = await supabase.from("waitlist").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] }),
    onError: () => toast.error("Erro ao atualizar status."),
  });
}

export function useNotifyWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, phone, message }: { id: string; phone: string; message: string }) => {
      // Envia WhatsApp via send-whatsapp Edge Function. `kind` + `waitlist_id`
      // permitem que o backend grave notifications_sent com waitlist_id NÃO-null
      // → UNIQUE parcial (waitlist_id, kind) WHERE waitlist_id IS NOT NULL
      // (mig 048) protege contra duplicação em double-click.
      const { data, error: funcErr } = await supabase.functions.invoke("send-whatsapp", {
        body: {
          phone,
          message,
          unit_id: unitId,
          kind: "waitlist_table_ready",
          waitlist_id: id,
        },
      });
      if (funcErr) throw funcErr;
      const result = data as { success?: boolean; error?: string } | null;
      if (result && result.success === false) {
        throw new Error(result.error ?? "Falha ao enviar WhatsApp.");
      }

      // Marca como notificado
      const { error } = await supabase
        .from("waitlist")
        .update({ status: "notified", notified_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      toast.success("Notificação enviada via WhatsApp.");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao notificar."),
  });
}

export function useRemoveFromWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("waitlist")
        .update({ status: "cancelled" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] }),
    onError: () => toast.error("Erro ao remover da fila."),
  });
}

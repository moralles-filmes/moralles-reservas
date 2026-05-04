import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { WaitlistEntry, WaitlistStatus } from "@/types/reserva";

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

export function useAddToWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_name: string;
      customer_phone?: string | null;
      party_size: number;
      requested_for_time?: string | null;
      notes?: string | null;
    }) => {
      const { error } = await supabase.from("waitlist").insert({
        unit_id: unitId,
        ...payload,
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
      // Envia WhatsApp via send-whatsapp Edge Function
      const { error: funcErr } = await supabase.functions.invoke("send-whatsapp", {
        body: { phone, message, unit_id: unitId },
      });
      if (funcErr) throw funcErr;

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
    onError: () => toast.error("Erro ao notificar."),
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

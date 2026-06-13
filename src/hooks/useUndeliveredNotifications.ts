import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

/**
 * Linha do painel "Entregas" (Operacional) — mensagem WhatsApp NÃO entregue.
 * Vem da RPC `get_undelivered_notifications` (junta notifications_sent com
 * fila/reservas/clientes). Reusa o estado de entrega via `deriveDeliveryState`
 * de useNotificationDeliveries (os campos delivered_at/read_at/failed_at/etc.
 * têm o mesmo shape de DeliveryRow).
 */
export interface UndeliveredNotification {
  id: string;
  kind: string;
  status: string;
  provider_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  waitlist_id: string | null;
  reservation_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  ref_code: string | null;
  ref_date: string | null;
  ref_time: string | null;
}

// Pausa polling em aba background (padrão dos painéis operacionais).
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 30_000;

export function useUndeliveredNotifications(unitId: string) {
  return useQuery({
    queryKey: ["undelivered-notifications", unitId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_undelivered_notifications", {
        p_unit_id: unitId,
      });
      if (error) throw error;
      return (data ?? []) as UndeliveredNotification[];
    },
    enabled: !!unitId,
    refetchInterval: pollWhenVisible,
  });
}

const RESENDABLE_KINDS = new Set(["waitlist_entered", "waitlist_table_ready", "confirmation"]);
export function isResendableKind(kind: string): boolean {
  return RESENDABLE_KINDS.has(kind);
}

function friendlyResendError(code?: string | null): string {
  if (code === "no_phone") return "Este cliente não tem WhatsApp cadastrado.";
  if (code === "whatsapp_not_configured")
    return "Esta unidade não tem WhatsApp configurado. Configure o canal em Plataforma → Automação.";
  if (code === "not_found_or_cross_tenant") return "Registro não encontrado nesta unidade.";
  return "Falha ao reenviar a mensagem.";
}

/**
 * Reenvia uma mensagem (qualquer kind suportado) via a Edge Function
 * `resend-notification` — ponto único de reenvio. Invalida o painel E os badges
 * de entrega por-cartão (notification-deliveries) pra refletir o novo envio.
 */
export function useResendNotification(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { kind: string; waitlist_id?: string | null; reservation_id?: string | null }
  >({
    mutationFn: async ({ kind, waitlist_id, reservation_id }) => {
      const { data, error: funcErr } = await supabase.functions.invoke("resend-notification", {
        body: {
          kind,
          unit_id: unitId,
          waitlist_id: waitlist_id ?? undefined,
          reservation_id: reservation_id ?? undefined,
        },
      });
      if (funcErr) {
        if (funcErr instanceof FunctionsHttpError) {
          const b = (await funcErr.context.json().catch(() => null)) as { error?: string } | null;
          throw new Error(friendlyResendError(b?.error));
        }
        throw funcErr;
      }
      const result = data as { success?: boolean; error?: string } | null;
      if (result && result.success === false) {
        throw new Error(friendlyResendError(result.error));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["undelivered-notifications"] });
      queryClient.invalidateQueries({ queryKey: ["notification-deliveries"] });
      toast.success("Mensagem reenviada.");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao reenviar."),
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  WaitlistEntry,
  WaitlistPriorityCategory,
  WaitlistStatus,
} from "@/types/reserva";

/**
 * Traduz o código de erro técnico do send-whatsapp (`result.error`) numa
 * mensagem acionável pro operador. Sem isso, a UI mostrava o genérico
 * "Edge Function returned a non-2xx status code" (o `supabase.functions.invoke`
 * mascara o corpo num FunctionsHttpError).
 */
function friendlyWhatsAppError(code?: string | null): string {
  if (!code) return "Falha ao enviar WhatsApp.";
  if (code === "whatsapp_not_configured")
    return "Esta unidade não tem WhatsApp configurado. Configure o canal em Plataforma → Automação para enviar avisos.";
  if (code === "channel_mismatch")
    return "Canal de WhatsApp inválido para esta unidade.";
  if (code === "missing_credentials")
    return "As credenciais do WhatsApp estão incompletas. Revise a configuração do canal.";
  if (/http_4\d\d/.test(code))
    return "O WhatsApp recusou o envio — a conexão da conta pode ter caído. Reconecte o canal e tente de novo.";
  if (/http_5\d\d/.test(code))
    return "O provedor de WhatsApp está instável no momento. Tente novamente em instantes.";
  return "Falha ao enviar WhatsApp.";
}

// Pausa polling quando a aba está em background — tablets de salão deixam o
// painel aberto o dia inteiro; 30s × 8h = 960 requisições/dia ociosas.
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 30_000;

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
    refetchInterval: pollWhenVisible,
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
    onError: (err) => {
      // Mensagem genérica — não vaza err.message do Supabase (RLS/schema/etc).
      // Mas logamos o erro real no console pra debug em produção (DevTools).
      console.error("[anon waitlist] failed:", err);
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

interface NotifyResult {
  /** WhatsApp send result. Sempre `true` quando chega ao onSuccess (erros antes lançam). */
  sent: boolean;
  /** UPDATE de status pra "notified". Pode ser `false` se WhatsApp foi enviado mas
   *  o UPDATE subsequente falhou — operador precisa ser avisado e a tela vai
   *  reconciliar via refetch (pg_cron retry / refresh manual). */
  statusUpdated: boolean;
}

export function useNotifyWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<NotifyResult, Error, { id: string; phone: string; message: string }>({
    mutationFn: async ({ id, phone, message }) => {
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
      if (funcErr) {
        // send-whatsapp devolve 502 quando o envio falha; supabase-js empacota
        // num FunctionsHttpError cuja `.message` é sempre o genérico "non-2xx".
        // O motivo real (ex.: "whatsapp_not_configured") está em context.json().
        if (funcErr instanceof FunctionsHttpError) {
          const body = (await funcErr.context.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(friendlyWhatsAppError(body?.error));
        }
        throw funcErr;
      }
      const result = data as { success?: boolean; error?: string } | null;
      if (result && result.success === false) {
        throw new Error(friendlyWhatsAppError(result.error));
      }

      // Marca como notificado. Se o UPDATE falhar AGORA, o WhatsApp JÁ foi
      // enviado — não relançamos como erro pra não confundir o operador
      // ("Erro ao notificar" daria a impressão de que pode tentar de novo,
      // mas o UNIQUE PARTIAL no banco bloqueia o 2º envio).
      const { error } = await supabase
        .from("waitlist")
        .update({ status: "notified", notified_at: new Date().toISOString() })
        .eq("id", id);
      if (error) {
        console.error("[waitlist notify] send ok, update failed:", error);
        return { sent: true, statusUpdated: false };
      }
      return { sent: true, statusUpdated: true };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      if (result.statusUpdated) {
        toast.success("Notificação enviada via WhatsApp.");
      } else {
        toast.warning("Mensagem enviada, mas o estado da fila não atualizou. Recarregue a página.");
      }
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

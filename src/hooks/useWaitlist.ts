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
  if (code === "service_not_enabled")
    return "Aviso de mesa pronta desativado. Ative em WhatsApp → Modelos e avisos ou avise o cliente por outro meio.";
  if (code === "automation_dependency_unavailable" || code === "internal_error")
    return "Não foi possível confirmar o aviso. Atualize a fila e confira Entregas antes de tentar novamente.";
  if (code === "dependency_unavailable")
    return "Não foi possível conferir o reenvio. Atualize a fila e tente novamente.";
  if (code === "automation_resend_refused")
    return "Este aviso já tem um resultado registrado. Confira Entregas antes de tentar novamente.";
  if (code === "message_expired")
    return "Este aviso é antigo demais para ser reenviado.";
  if (code === "waitlist_status_changed" || code === "waitlist_fact_unavailable")
    return "O estado da fila mudou. Atualize a fila antes de tentar novamente.";
  if (code === "whatsapp_not_configured")
    return "Esta unidade não tem WhatsApp configurado. Configure o canal em Plataforma → Unidades para enviar avisos.";
  if (code === "whatsapp_service_suspended")
    return "Envio de WhatsApp suspenso por falta de pagamento da mensalidade da automação. Regularize em Cobrança para voltar a enviar.";
  // Passou a ser o retorno COMUM desde que o envio exige conexão confirmada:
  // antes o canal caído era mascarado como "não configurado" (ou nem checado,
  // no caso da Z-API). A frase precisa dizer o que resolve — reconectar — em
  // vez de mandar o operador configurar um canal que já existe.
  if (code === "whatsapp_not_connected")
    return "O WhatsApp desta unidade está desconectado. Reconecte o canal em Plataforma → Unidades e tente de novo.";
  if (code === "whatsapp_channel_inactive")
    return "O canal de WhatsApp desta unidade está inativo. Ative-o em Plataforma → Unidades.";
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
  marketing_opt_in?: boolean;
}

/** Resposta do hook de inserção anônima — inclui o código gerado pra exibir
 *  na confirmação. */
export interface AnonWaitlistResult {
  code: number | null;
  warning?: "registration_incomplete" | "consent_not_recorded";
}

export function useAnonAddToWaitlist(unitId: string) {
  return useMutation<AnonWaitlistResult, Error, AnonWaitlistInput>({
    mutationFn: async (payload) => {
      const { data, error } = await supabase.functions.invoke("public-waitlist", {
        body: { unit_id: unitId, ...payload, marketing_opt_in: payload.marketing_opt_in === true },
      });
      if (error) throw error;
      const result = data as { success?: boolean; code?: number; warning?: AnonWaitlistResult["warning"] } | null;
      if (!result || result.success !== true || !Number.isInteger(result.code))
        throw new Error("Não foi possível confirmar a entrada na fila.");
      return { code: result.code!, warning: result.warning };
    },
    onSuccess: (result) => {
      if (result.warning === "registration_incomplete")
        toast.warning("Sua entrada na fila foi confirmada, mas o cadastro precisa de conferência. Informe a senha ao restaurante; não envie o formulário novamente.");
      else if (result.warning === "consent_not_recorded")
        toast.warning("Sua entrada na fila foi confirmada, mas a autorização para ofertas não foi registrada. Informe a senha ao restaurante; não envie o formulário novamente.");
    },
    onError: async (err) => {
      // A RPC pode ter feito commit antes de a resposta se perder. Nunca
      // sugerir reenvio automático do formulário após falha incerta.
      if (err instanceof FunctionsHttpError) {
        const body = (await err.context.json().catch(() => null)) as { reason?: string } | null;
        if (body?.reason === "rate_limited") {
          toast.error("Muitas tentativas. Aguarde um instante antes de tentar novamente.");
          return;
        }
        if (body?.reason === "invalid_input") {
          toast.error("Confira os dados da fila e tente novamente.");
          return;
        }
        if (body?.reason === "unit_unavailable") {
          toast.error("Esta unidade não está aceitando entradas na fila.");
          return;
        }
      }
      toast.error("Não foi possível confirmar a entrada. Confira com o restaurante antes de enviar o formulário novamente.");
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

export function useUpdateWaitlistEntry(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      customer_name: string;
      customer_phone: string | null;
      party_size: number;
      requested_for_time: string | null;
      notes: string | null;
    }) => {
      // UPDATE direto na linha denormalizada da waitlist (mesmo padrão de
      // useUpdateWaitlistStatus). NÃO toca em `customers`: a notificação lê de
      // `waitlist.customer_phone`, e mexer em `customers` arriscaria o dedupe
      // UNIQUE (organization_id, phone).
      const { id, ...updates } = payload;
      const { error } = await supabase.from("waitlist").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      toast.success("Dados do cliente atualizados.");
    },
    onError: () => toast.error("Erro ao atualizar os dados."),
  });
}

export function useUpdateWaitlistStatus(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: WaitlistStatus }) => {
      const updates: Record<string, unknown> = { status };

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
  existing: boolean;
  automationState: string | null;
  conversationWarning: boolean;
}

export function useNotifyWaitlist(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<NotifyResult, Error, { id: string; message: string }>({
    mutationFn: async ({ id, message }) => {
      // O servidor decide adoção e deriva unidade, telefone e fact_at do recurso.
      // O texto só é usado no caminho legado comprovado.
      const { data, error: funcErr } = await supabase.functions.invoke("notify-waitlist-ready", {
        body: { waitlist_id: id, message },
      });
      if (funcErr) {
        // send-whatsapp devolve 502 quando o envio falha; supabase-js empacota
        // num FunctionsHttpError cuja `.message` é sempre o genérico "non-2xx".
        // O motivo real (ex.: "whatsapp_not_configured") está em context.json().
        if (funcErr instanceof FunctionsHttpError) {
          const body = (await funcErr.context.json().catch(() => null)) as
            | { error?: string; statusUpdated?: boolean; automation?: { state?: string } }
            | null;
          if (body?.statusUpdated === true && body.automation?.state === "not_enqueued")
            return { sent: false, statusUpdated: true, existing: false,
              automationState: "not_enqueued", conversationWarning: false };
          throw new Error(friendlyWhatsAppError(body?.error));
        }
        throw funcErr;
      }
      const result = data as { success?: boolean; sent?: boolean; statusUpdated?: boolean; existing?: boolean; error?: string; warning?: string; automation?: { state?: string } } | null;
      if (result?.success === false && (!result.automation || result.automation.state === "not_enqueued"))
        throw new Error(friendlyWhatsAppError(result.error));
      if (!result || typeof result.sent !== "boolean" || typeof result.statusUpdated !== "boolean")
        throw new Error("Não foi possível confirmar o resultado do aviso.");
      return { sent: result.sent, statusUpdated: result.statusUpdated,
        existing: result.existing === true, automationState: result.automation?.state ?? null,
        conversationWarning: result.warning === "CONVERSATION_RECONCILIATION_REQUIRED" };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      queryClient.invalidateQueries({ queryKey: ["notification-deliveries"] });
      if (!result.sent) {
        if (result.automationState === "not_enqueued")
          toast.warning("O estado da fila foi atualizado, mas o aviso não foi aceito. Confira Entregas antes de tentar novamente.");
        else if (result.automationState === "failed" || result.automationState === "rejected" || result.automationState === "expired")
          toast.warning("O aviso não foi entregue. Confira o motivo no painel de Entregas.");
        else toast.info("Aviso de mesa pronta registrado. Confira o estado no painel de Entregas.");
      } else if (result.existing) {
        toast.info("Este aviso já foi registrado. Confira o resultado no painel de Entregas.");
      } else if (result.conversationWarning) {
        toast.warning("Aviso enviado, mas o histórico da conversa precisa de reconciliação. Confira Entregas.");
      } else if (result.statusUpdated) {
        toast.success("Notificação enviada via WhatsApp.");
      } else {
        toast.warning("Mensagem enviada, mas o estado da fila não atualizou. Recarregue a página.");
      }
    },
    onError: (err: Error) => {
      // O fato pode ter sido persistido antes de uma falha de despacho.
      queryClient.invalidateQueries({ queryKey: ["waitlist", unitId] });
      queryClient.invalidateQueries({ queryKey: ["notification-deliveries"] });
      toast.error(err.message ?? "Erro ao notificar.");
    },
  });
}

/**
 * Reenvia a mensagem de ENTRADA na fila (kind `waitlist_entered`) — usado quando
 * o operador corrige o telefone ou a entrega não foi confirmada. NÃO muda o
 * status da entry (≠ useNotifyWaitlist, que é o aviso "mesa pronta" e marca
 * `notified`). O endpoint decide pelo job persistido ou pelo legado não adotado.
 */
export function useResendWaitlistEntered(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { id: string; phone: string; message: string }>({
    mutationFn: async ({ id }) => {
      const { data, error: funcErr } = await supabase.functions.invoke("resend-notification", {
        body: { kind: "waitlist_entered", waitlist_id: id, unit_id: unitId },
      });
      if (funcErr) {
        if (funcErr instanceof FunctionsHttpError) {
          const body = (await funcErr.context.json().catch(() => null)) as { error?: string } | null;
          throw new Error(friendlyWhatsAppError(body?.error));
        }
        throw funcErr;
      }
      const result = data as { success?: boolean; error?: string; message?: string } | null;
      if (!result || result.success !== true)
        throw new Error(result?.message ?? friendlyWhatsAppError(result?.error));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification-deliveries"] });
      toast.success("Aviso de entrada reenviado.");
    },
    onError: (err: Error) => toast.error(err.message ?? "Erro ao reenviar."),
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

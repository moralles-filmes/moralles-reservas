import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  WaitlistMessageTemplate,
  WaitlistTemplateEvent,
} from "@/types/reserva";

export interface WaitlistTemplateMeta {
  event: WaitlistTemplateEvent;
  label: string;
  description: string;
  defaultBody: string;
  maxLength: number;
}

/**
 * Templates default usados quando `customized = false` (ou não há linha em
 * `waitlist_message_templates`). Variáveis suportadas: {{cliente_nome}},
 * {{unidade_nome}}, {{party_size}}, {{codigo_fila}}, {{link_status}}.
 */
export const WAITLIST_TEMPLATES: WaitlistTemplateMeta[] = [
  {
    event: "entered",
    label: "Você entrou na fila",
    description:
      "Confirmação enviada quando o cliente entra na fila de espera.",
    defaultBody:
      "Oi {{cliente_nome}}! Você entrou na fila de espera em {{unidade_nome}}. Sua senha é #{{codigo_fila}}. Acompanhe em {{link_status}}",
    maxLength: 300,
  },
  {
    event: "table_ready",
    label: "Sua mesa está pronta",
    description:
      "Notificação enviada quando o restaurante chama o cliente da fila.",
    defaultBody:
      "🔔 {{cliente_nome}}, sua mesa em {{unidade_nome}} está pronta! Senha #{{codigo_fila}}. Por favor, dirija-se à recepção.",
    maxLength: 300,
  },
  {
    event: "feedback",
    label: "Conte pra gente sua experiência",
    description:
      "Pesquisa de satisfação enviada após a saída do cliente da fila.",
    defaultBody:
      "Obrigado por escolher {{unidade_nome}}, {{cliente_nome}}! Conte pra gente como foi sua experiência: {{link_status}}",
    maxLength: 300,
  },
];

export const WAITLIST_VARIABLES: Array<{ key: string; label: string }> = [
  { key: "cliente_nome", label: "Nome do cliente" },
  { key: "unidade_nome", label: "Nome da unidade" },
  { key: "party_size", label: "Quantidade de pessoas" },
  { key: "codigo_fila", label: "Senha da fila" },
  { key: "link_status", label: "Link de acompanhamento" },
];

export function getWaitlistTemplateMeta(
  event: WaitlistTemplateEvent,
): WaitlistTemplateMeta {
  return (
    WAITLIST_TEMPLATES.find((t) => t.event === event) ?? WAITLIST_TEMPLATES[0]
  );
}

export function useWaitlistTemplates(unitId: string) {
  return useQuery({
    queryKey: ["waitlist-templates", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("waitlist_message_templates")
        .select("*")
        .eq("unit_id", unitId);
      if (error) throw error;
      return data as WaitlistMessageTemplate[];
    },
    enabled: !!unitId,
  });
}

export interface UpsertWaitlistTemplateInput {
  event: WaitlistTemplateEvent;
  customized: boolean;
  body: string;
}

export function useUpsertWaitlistTemplate(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpsertWaitlistTemplateInput) => {
      const { error } = await supabase
        .from("waitlist_message_templates")
        .upsert(
          {
            unit_id: unitId,
            event: payload.event,
            customized: payload.customized,
            body: payload.body,
          },
          { onConflict: "unit_id,event" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["waitlist-templates", unitId] });
      toast.success("Mensagem salva.");
    },
    onError: (err: Error) =>
      toast.error(err.message ?? "Erro ao salvar mensagem."),
  });
}

/**
 * Renderiza um template substituindo as variáveis pelo conteúdo real. Usado pelo
 * preview no painel e pelo painel operacional ao notificar o cliente.
 */
export function renderWaitlistTemplate(
  body: string,
  vars: {
    cliente_nome?: string;
    unidade_nome?: string;
    party_size?: number;
    codigo_fila?: number | null;
    link_status?: string;
  },
): string {
  return body
    .replaceAll("{{cliente_nome}}", vars.cliente_nome ?? "")
    .replaceAll("{{unidade_nome}}", vars.unidade_nome ?? "")
    .replaceAll("{{party_size}}", String(vars.party_size ?? ""))
    .replaceAll(
      "{{codigo_fila}}",
      vars.codigo_fila != null ? String(vars.codigo_fila) : "",
    )
    .replaceAll("{{link_status}}", vars.link_status ?? "");
}

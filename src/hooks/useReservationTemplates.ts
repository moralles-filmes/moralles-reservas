import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  ReservationMessageTemplate,
  ReservationTemplateEvent,
} from "@/types/reserva";

export interface ReservationTemplateMeta {
  event: ReservationTemplateEvent;
  label: string;
  description: string;
  defaultBody: string;
  maxLength: number;
  /** Variáveis aceitas neste evento (subset de RESERVATION_VARIABLES). */
  variables: ReservationVariableKey[];
}

export type ReservationVariableKey =
  | "cliente_nome"
  | "horario"
  | "party_size"
  | "codigo"
  | "unidade_nome"
  | "link_acompanhamento";

/**
 * Templates default usados quando `customized = false` (ou não há linha em
 * `reservation_message_templates`). Os textos batem com os usados pelos
 * workers em supabase/functions/process-reservation-reminders e
 * process-satisfaction-surveys — mantenha em sincronia se editar.
 */
export const RESERVATION_TEMPLATES: ReservationTemplateMeta[] = [
  {
    event: "reminder_d1",
    label: "Lembrete (dia da reserva)",
    description:
      "Mensagem enviada no dia da reserva (10:00 BRT) confirmando horário.",
    defaultBody:
      "Olá, {{cliente_nome}}! 👋\n\nLembrete da sua reserva hoje às {{horario}} para {{party_size}} pessoa(s) em {{unidade_nome}}.\n\nCódigo: #{{codigo}}\n\nAcompanhe sua reserva: {{link_acompanhamento}}\n\nPara alterar ou cancelar, é só responder esta mensagem. Te esperamos! 🍽️",
    maxLength: 600,
    variables: [
      "cliente_nome",
      "horario",
      "party_size",
      "codigo",
      "unidade_nome",
      "link_acompanhamento",
    ],
  },
  {
    event: "survey_d1",
    label: "Pesquisa de satisfação (1 dia depois)",
    description:
      "Mensagem enviada no dia seguinte à reserva (14:00 BRT) pedindo nota de 1 a 5. A resposta é capturada automaticamente.",
    defaultBody:
      "Oi, {{cliente_nome}}! 🙂\n\nEsperamos que tenha gostado da sua visita ao {{unidade_nome}} ontem.\n\nDe 1 a 5, como você avalia sua experiência? (responda só o número)\n\nObrigado por nos ajudar a melhorar! 💛",
    maxLength: 600,
    variables: ["cliente_nome", "codigo", "unidade_nome"],
  },
];

export const RESERVATION_VARIABLES: Array<{
  key: ReservationVariableKey;
  label: string;
}> = [
  { key: "cliente_nome", label: "Nome do cliente" },
  { key: "horario", label: "Horário (HH:MM)" },
  { key: "party_size", label: "Quantidade de pessoas" },
  { key: "codigo", label: "Código da reserva" },
  { key: "unidade_nome", label: "Nome da unidade" },
  { key: "link_acompanhamento", label: "Link de acompanhamento" },
];

export function getReservationTemplateMeta(
  event: ReservationTemplateEvent,
): ReservationTemplateMeta {
  return (
    RESERVATION_TEMPLATES.find((t) => t.event === event) ??
    RESERVATION_TEMPLATES[0]
  );
}

export function useReservationTemplates(unitId: string) {
  return useQuery({
    queryKey: ["reservation-templates", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservation_message_templates")
        .select("*")
        .eq("unit_id", unitId);
      if (error) throw error;
      return data as ReservationMessageTemplate[];
    },
    enabled: !!unitId,
    refetchOnWindowFocus: false,
  });
}

export interface UpsertReservationTemplateInput {
  event: ReservationTemplateEvent;
  customized: boolean;
  body: string;
}

export function useUpsertReservationTemplate(unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpsertReservationTemplateInput) => {
      const { error } = await supabase
        .from("reservation_message_templates")
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
      queryClient.invalidateQueries({
        queryKey: ["reservation-templates", unitId],
      });
      toast.success("Mensagem salva.");
    },
    onError: (err: Error) =>
      toast.error(err.message ?? "Erro ao salvar mensagem."),
  });
}

/**
 * Renderiza um template substituindo as variáveis pelo conteúdo real. Usado
 * apenas pelo preview no painel — os workers (Edge Functions) renderizam o
 * próprio template lado-servidor.
 */
export function renderReservationTemplate(
  body: string,
  vars: {
    cliente_nome?: string;
    horario?: string;
    party_size?: number;
    codigo?: string;
    unidade_nome?: string;
    link_acompanhamento?: string;
  },
): string {
  return body
    .replaceAll("{{cliente_nome}}", vars.cliente_nome ?? "")
    .replaceAll("{{horario}}", vars.horario ?? "")
    .replaceAll("{{party_size}}", String(vars.party_size ?? ""))
    .replaceAll("{{codigo}}", vars.codigo ?? "")
    .replaceAll("{{unidade_nome}}", vars.unidade_nome ?? "")
    .replaceAll("{{link_acompanhamento}}", vars.link_acompanhamento ?? "");
}

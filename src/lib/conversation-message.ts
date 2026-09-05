import type { ConversationMessage, OutboundMessageKind } from "@/types/reserva";

const OUTBOUND_KIND_LABEL: Record<OutboundMessageKind, string> = {
  confirmation: "Confirmação",
  reminder_d1: "Lembrete",
  survey_d1: "Pesquisa",
  cancellation: "Cancelamento",
  voucher_issued: "Voucher",
  waitlist_entered: "Fila — entrada",
  waitlist_table_ready: "Fila — mesa pronta",
  waitlist_feedback: "Fila — feedback",
};

/**
 * Rótulo exibido no balão. `kind` é autoridade para automações conhecidas;
 * mensagens antigas sem `author` mantêm um rótulo explícito, sem inventar se
 * vieram de uma chamada de IA ou de uma resposta automática hardcoded.
 */
export function getConversationMessageAuthorLabel(msg: ConversationMessage): string {
  if (msg.kind) {
    return `Automação · ${OUTBOUND_KIND_LABEL[msg.kind] ?? msg.kind}`;
  }

  switch (msg.author) {
    case "customer":
      return "Cliente";
    case "ai":
      return "IA";
    case "automation":
      return "Automação";
    case "human":
      return "Atendente";
  }

  switch (msg.role) {
    case "user":
      return "Cliente";
    case "human":
      return "Atendente";
    case "assistant":
      return "IA/Automação (legado)";
  }
}

/**
 * Ordena cronologicamente sem alterar o array persistido/cacheado. O índice
 * original desempata timestamps iguais e mantém mensagens inválidas estáveis
 * no fim da timeline.
 */
export function sortConversationMessages(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  return messages
    .map((message, index) => {
      const parsed = new Date(message.timestamp).getTime();
      return {
        message,
        index,
        epoch: Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => a.epoch - b.epoch || a.index - b.index)
    .map(({ message }) => message);
}

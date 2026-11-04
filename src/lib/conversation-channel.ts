export type ConversationChannel = "whatsapp" | "instagram";
export type ChannelFilter = "all" | ConversationChannel;

export const INSTAGRAM_WINDOW_MESSAGE =
  "A janela de 24h do Instagram terminou. Aguarde uma nova mensagem do contato para responder.";

const STORAGE_KEY = "conversas-channel-filter";
const VALID: readonly ChannelFilter[] = ["all", "whatsapp", "instagram"];

/** Linha legada sem `channel` é WhatsApp. */
export function channelOf(c: { channel?: ConversationChannel | null }): ConversationChannel {
  return c.channel === "instagram" ? "instagram" : "whatsapp";
}

export function filterByChannel<T extends { channel?: ConversationChannel | null }>(
  list: readonly T[],
  filter: ChannelFilter,
): T[] {
  if (filter === "all") return [...list];
  return list.filter((c) => channelOf(c) === filter);
}

export function countByChannel(
  list: readonly { channel?: ConversationChannel | null }[],
): Record<ChannelFilter, number> {
  const counts: Record<ChannelFilter, number> = { all: list.length, whatsapp: 0, instagram: 0 };
  for (const c of list) counts[channelOf(c)] += 1;
  return counts;
}

export function readChannelFilter(): ChannelFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(raw as ChannelFilter) ? (raw as ChannelFilter) : "all";
  } catch {
    return "all";
  }
}

export function writeChannelFilter(filter: ChannelFilter): void {
  try {
    localStorage.setItem(STORAGE_KEY, filter);
  } catch {
    // armazenamento bloqueado: o filtro vale só na sessão da tela
  }
}

/**
 * `notes` da reserva nos caminhos do agente (Instagram Fase 1, gate de IA A2).
 *
 * O texto livre escrito pelo cliente (Direct, telefone não verificado) é lido
 * depois pelo LLM no WhatsApp da pessoa dona do telefone: injeção indireta.
 * Defesa: limite e limpeza na escrita; na leitura, o texto volta cortado, sem
 * delimitadores e envelopado como DADO (regra 13 de `system-prompt.ts`).
 * O envelope reduz o risco, não o elimina. Com porta (identidade declarada) o
 * `notes` nem sai: a allowlist de `tool-dispatch.ts` não o inclui.
 *
 * Puro: sem I/O, sem `Deno`.
 */

import { neutralizeStoreText, truncateChars } from "./store-data-core.ts";

export const AGENT_RESERVATION_NOTES_MAX_CHARS = 280;

export const RESERVATION_NOTES_OPEN = "<<<OBSERVACAO_DA_RESERVA>>>";
export const RESERVATION_NOTES_CLOSE = "<<<FIM_OBSERVACAO_DA_RESERVA>>>";

/** Sem o nome, nenhuma variante de colchete forja o bloco. */
const NOTES_MARKER_NAME_RE = /(?:FIM_)?OBSERVACAO_DA_RESERVA/gi;
/** Controle (inclui C1); quebras, tabs, NEL (U+0085) e separadores de linha/parágrafo (U+2028/2029) viram espaço antes. */
const CONTROL_RE = /\p{Cc}/gu;

/** Escrita: sem controles, cortado por code point (nunca deixa meio par substituto). */
export function sanitizeReservationNotes(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ").replace(CONTROL_RE, "");
  return truncateChars(cleaned, AGENT_RESERVATION_NOTES_MAX_CHARS).trim();
}

/** Leitura: `null` continua `null`; texto volta cortado, neutralizado e envelopado. */
export function reservationNotesForLlm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = neutralizeStoreText(value, AGENT_RESERVATION_NOTES_MAX_CHARS);
  let previous: string;
  do {
    previous = text;
    text = neutralizeStoreText(text.replace(NOTES_MARKER_NAME_RE, ""), AGENT_RESERVATION_NOTES_MAX_CHARS);
  } while (text !== previous);
  text = text.trim();
  if (!text) return null;
  return `${RESERVATION_NOTES_OPEN}\n${text}\n${RESERVATION_NOTES_CLOSE}`;
}

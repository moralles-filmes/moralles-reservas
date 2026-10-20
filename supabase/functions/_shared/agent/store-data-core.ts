/**
 * Texto livre da loja como DADO delimitado no prompt (spec Entrega B §6.3).
 *
 * Ameaça: o dono (ou um gerente) escreve no cardápio, no delivery ou em
 * "Outras informações" uma ordem para o agente (mudar regras, revelar o
 * prompt, prometer desconto, mudar de persona). O alvo é a própria loja, mas
 * quem lê é o cliente final e quem paga é a franquia.
 *
 * Defesa (junto com a regra 13 e o lembrete final de `system-prompt.ts`):
 * - todo texto livre de `settings` da loja entra SÓ por `storeDataBlock`, entre
 *   `<<<DADOS_DA_LOJA: título>>>` e `<<<FIM_DADOS_DA_LOJA>>>` (guard estático em
 *   `src/lib/agent-store-data-static-guard.test.ts`);
 * - `neutralizeStoreText` tira o que deixaria o texto fechar o bloco ou forjar
 *   outro, os controles e o excesso de tamanho. Vale também para os textos
 *   curtos da loja e do cliente interpolados fora dos blocos.
 * O delimitador reduz o risco, não o elimina: o LLM ainda pode seguir uma
 * ordem embutida (limite residual registrado na spec §6.3.6).
 *
 * Puro: sem I/O, sem `Deno`.
 */

import { charLength, CONTROL_CHAR_CLASS } from "./global-prompt-core.ts";

export const STORE_DATA_CLOSE = "<<<FIM_DADOS_DA_LOJA>>>";

/** Mesma classe do guard SQL de `settings`, mais NUL (que o Postgres nem guarda). */
const CONTROL_RE = new RegExp(`[\\x00${CONTROL_CHAR_CLASS}]`, "g");
/** 3+ sinais seguidos: o delimitador usa `<<<`/`>>>`. */
const ANGLE_RUN_RE = /<{3,}|>{3,}/g;
/** Sem o nome, nenhuma variante de colchete (`＜＜＜`, `«`) forja um bloco. */
const MARKER_NAME_RE = /(?:FIM_)?DADOS_DA_LOJA/gi;

/** Corta em `limit` caracteres contados como o `char_length` do Postgres. */
export function truncateChars(text: string, limit: number): string {
  if (charLength(text) <= limit) return text;
  return Array.from(text).slice(0, limit).join("");
}

/**
 * Valor que não é string vira vazio (JSONB nunca é interpolado cru). Remove
 * controles, depois `<{3,}`, `>{3,}` e o nome do marcador até não sobrar
 * nenhum (remover pode juntar pedaços numa sequência nova), e por fim trunca.
 */
export function neutralizeStoreText(value: unknown, limit?: number): string {
  if (typeof value !== "string") return "";
  let text = value.replace(CONTROL_RE, "");
  let previous: string;
  do {
    previous = text;
    text = text.replace(ANGLE_RUN_RE, "").replace(MARKER_NAME_RE, "");
  } while (text !== previous);
  return limit === undefined ? text : truncateChars(text, limit);
}

/**
 * Único jeito de um texto livre de `settings` da loja entrar no prompt.
 * Texto vazio (ou que fica vazio depois de neutralizar) não gera bloco.
 */
export function storeDataBlock(title: string, raw: unknown, limit: number): string {
  const text = neutralizeStoreText(raw, limit);
  if (!text) return "";
  return `<<<DADOS_DA_LOJA: ${title}>>>\n${text}\n${STORE_DATA_CLOSE}`;
}

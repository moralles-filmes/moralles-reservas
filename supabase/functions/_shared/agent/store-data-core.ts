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
/**
 * Invisíveis que esconderiam um marcador do regex ou passariam instrução sem
 * aparecer: formato (`\p{Cf}`: zero-width, bidi, tags, BOM, soft hyphen), CGJ,
 * seletores de variação e C1. Efeito colateral aceito: emoji composto por ZWJ
 * se separa. Homóglifos (`Ο` grego) ficam como risco residual (spec §6.3.6).
 */
const INVISIBLE_RE = new RegExp("[\\p{Cf}\\u034F\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u0080-\\u009F]", "gu");
/** NEL e separadores de linha/parágrafo Unicode viram `\n` (antes de tirar o C1), o único que o resto trata. */
const LINE_SEPARATOR_RE = new RegExp("[\\u0085\\u2028\\u2029]", "g");
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
 * Valor que não é string vira vazio (JSONB nunca é interpolado cru). Trunca
 * PRIMEIRO no limite (o laço abaixo é quadrático no pior caso: marcadores
 * aninhados custam uma passada por nível, e um campo sem teto derrubaria o
 * turno por CPU), depois remove controles e invisíveis e, até não sobrar
 * nenhum, `<{3,}`, `>{3,}` e o nome do marcador (remover pode juntar pedaços
 * numa sequência nova). Só remove: o resultado nunca passa do limite.
 */
export function neutralizeStoreText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  let text = truncateChars(value, limit)
    .replace(LINE_SEPARATOR_RE, "\n")
    .replace(CONTROL_RE, "")
    .replace(INVISIBLE_RE, "");
  let previous: string;
  do {
    previous = text;
    text = text.replace(ANGLE_RUN_RE, "").replace(MARKER_NAME_RE, "");
  } while (text !== previous);
  return text;
}

/**
 * Texto curto da loja ou do cliente interpolado FORA dos blocos (nome de salão,
 * título de bloqueio, descrição, nome, alergia): neutralizado, com toda quebra
 * e todo espaço colapsados em um espaço, aparado e com teto. Sem `\n`, o campo
 * não abre linha nova no prompt, e por isso não forja uma seção ("Preços e
 * condições do restaurante:") nem uma linha de voucher do cliente.
 */
export function shortStoreText(value: unknown, limit: number): string {
  return neutralizeStoreText(value, limit).replace(/\s+/g, " ").trim();
}

/**
 * Tetos do texto curto (o banco não limita esses campos). Generosos para não
 * cortar dado legítimo; existem para conter custo e forja.
 */
export const SHORT_TEXT_LIMITS = {
  /** Nomes e títulos: salão, data especial, bloqueio, loja, endereço, rede social. */
  name: 200,
  /** Descrições e listas livres: descrição da loja e do salão, pagamento, horário, cliente. */
  description: 1000,
  /** Primeiro nome do cliente e nome do agente (`agent_name` tem 40 no guard). */
  personName: 40,
} as const;

/**
 * Único jeito de um texto livre de `settings` da loja entrar no prompt.
 * Texto vazio (ou que fica vazio depois de neutralizar) não gera bloco.
 */
export function storeDataBlock(title: string, raw: unknown, limit: number): string {
  const text = neutralizeStoreText(raw, limit);
  if (!text) return "";
  return `<<<DADOS_DA_LOJA: ${title}>>>\n${text}\n${STORE_DATA_CLOSE}`;
}

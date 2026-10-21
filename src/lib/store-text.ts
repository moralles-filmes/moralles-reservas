import {
  CONTROL_CHAR_CLASS,
  STORE_TEXT_LIMITS,
  charLength,
} from "../../supabase/functions/_shared/agent/global-prompt-core";

export type StoreTextKey = keyof typeof STORE_TEXT_LIMITS;

/** Código do erro local de gravação que não casou nenhuma linha (PostgREST devolve `error: null`). */
export const SETTINGS_NOT_WRITTEN_CODE = "settings_not_written";

/** Erro para o `upsert(...).select()` que voltou menos linhas do que as enviadas. */
export function settingsNotWrittenError(): Error & { code: string } {
  return Object.assign(new Error("settings_not_written"), { code: SETTINGS_NOT_WRITTEN_CODE });
}

// Mesma classe do guard de valor do banco (`CONTROL_CHAR_CLASS`), mais NUL: o Postgres o recusa antes.
const CONTROL_CHAR_RE = new RegExp(`[\x00${CONTROL_CHAR_CLASS}]`);

/**
 * Mensagem curta do que impede gravar o texto de `settings`; `null` quando vale.
 * Gêmea do `settings_write_value_guard`: string, até `STORE_TEXT_LIMITS[key]`
 * code points e sem controle além de `\n`/`\t`. O chamador normaliza `\r` antes
 * (`normalizeNewlines`): aqui `\r` é recusado como no banco.
 */
export function storeTextError(key: StoreTextKey, value: unknown): string | null {
  if (typeof value !== "string") return "Texto inválido.";
  const limit = STORE_TEXT_LIMITS[key];
  if (charLength(value) > limit) return `Passou de ${limit} caracteres.`;
  if (CONTROL_CHAR_RE.test(value)) return "Use só texto, sem caracteres de controle.";
  return null;
}

export function isValidStoreText(key: StoreTextKey, value: unknown): boolean {
  return storeTextError(key, value) === null;
}

/** `aria-describedby` do campo: o contador sempre, a mensagem só enquanto o texto é inválido (ids de `StoreTextCounter`). */
export function storeTextDescribedBy(id: string, invalid: boolean): string {
  return invalid ? `${id}-counter ${id}-problem` : `${id}-counter`;
}

/**
 * Cópia para o usuário de um erro de gravação em `settings`. Decide por
 * `error.code` do PostgREST: `error.message` nunca vai para a tela (pode
 * carregar a linha rejeitada, com o texto da loja).
 */
export function settingsWriteErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "42501") return "Sem permissão para editar estes textos.";
  if (code === "22023") return "Texto acima do limite ou com caracteres inválidos.";
  if (code === SETTINGS_NOT_WRITTEN_CODE) return "Nenhuma alteração foi gravada.";
  return "Não foi possível salvar. Tente novamente.";
}

/**
 * Mensagens da escrita de mesas, salões e horários. O banco recusa com 42501
 * quem não é owner, gerente ou platform_admin (trigger `guard_layout_write`), e
 * os hooks recusam no cliente a escrita por id que não casou nenhuma linha da
 * unidade ativa (AGENTS §8: UPDATE de zero linhas volta `error: null`).
 */
export const LAYOUT_ROLE_MESSAGE = "Só owner ou gerente podem alterar mesas e salões.";
export const HALL_NOT_IN_UNIT_MESSAGE = "Salão não encontrado nesta unidade.";
export const TABLE_NOT_IN_UNIT_MESSAGE = "Mesa não encontrada nesta unidade.";

const OWN_MESSAGES = new Set([HALL_NOT_IN_UNIT_MESSAGE, TABLE_NOT_IN_UNIT_MESSAGE]);

export function layoutErrorMessage(err: unknown, fallback: string): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  // Também 42501, mas é integridade (salão de outra unidade), não papel.
  if (e.code === "42501" && e.message === "hall_unit_mismatch") return HALL_NOT_IN_UNIT_MESSAGE;
  if (e.code === "42501") return LAYOUT_ROLE_MESSAGE;
  if (typeof e.message === "string" && OWN_MESSAGES.has(e.message)) return e.message;
  return fallback;
}

/** Lança quando a escrita por id não devolveu nenhuma linha. */
export function assertWrote(rows: unknown[] | null | undefined, message: string): void {
  if (!rows || rows.length === 0) throw new Error(message);
}

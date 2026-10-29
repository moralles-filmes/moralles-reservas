/**
 * Helper sem I/O para o `readRow` dos segredos do Instagram (S5/S6, R2-c, D3).
 *
 * A consulta a `platform_secrets` mora no `index.ts` de cada EF consumidora
 * (o adapter, decisão D3); a decisão e o cache moram em
 * `instagram-config-core.ts`. Aqui só se converte o `{ data, error }` do
 * PostgREST no contrato do núcleo: erro → loga só a chave e o `code` (quando é
 * string) e lança (o núcleo devolve `read_failed`); sem erro → a linha ou `null`.
 * Nunca a mensagem do erro nem o erro convertido em texto (guarda estática em
 * `src/lib/instagram-config-core.test.ts`). Não há fallback para ambiente.
 *
 * Exemplo de `readRow` completo no JSDoc de `createInstagramSecretReader`.
 */

// Mesmo formato do `jsonLog` de `security.ts`, sem importá-lo: aquele módulo
// referencia o runtime da EF e quebraria o `tsc -b` do Vitest que testa este.
function warnLine(payload: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", ts: new Date().toISOString(), ...payload }));
}

export function platformSecretRowOrThrow(
  key: string,
  result: { data: unknown; error: unknown },
): { value: string } | null {
  if (result.error !== null && result.error !== undefined) {
    const code = (result.error as { code?: unknown }).code;
    warnLine({
      evt: "instagram_secret_read_failed",
      key,
      code: typeof code === "string" ? code : undefined,
    });
    throw new Error("platform_secrets_read_failed");
  }
  // O núcleo confere `typeof value === "string"`; aqui não há coerção.
  return (result.data ?? null) as { value: string } | null;
}

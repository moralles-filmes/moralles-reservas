// Leitura paginada para Edge Functions. Gêmeo de src/lib/fetch-all-pages.ts
// (o backend não importa src/); a sincronia é o teste que importa os dois.
//
// PostgREST trunca em 1000 linhas sem avisar (AGENTS.md §8, "Lote").

/**
 * Lê uma consulta inteira em páginas. `build` deve ordenar por coluna estável
 * (`.order("id")`) e aplicar `.range(from, to)`. Erro de qualquer página sobe;
 * nunca devolve resultado parcial.
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}

/**
 * Lê uma consulta inteira por keyset (`id > último`), para tabela viva lida por
 * worker: offset pula ou repete linha quando outra escrita entra entre páginas.
 * `build(afterId, limit)` aplica `.gt("id", afterId)` quando afterId não é null,
 * `.order("id")` e `.limit(limit)`. Para só na página vazia, então um `max_rows`
 * menor que `pageSize` no PostgREST não trunca em silêncio. Erro sobe.
 */
export async function fetchAllByIdKeyset<T extends { id: string }>(
  build: (afterId: string | null, limit: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await build(afterId, pageSize);
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) return all;
    all.push(...rows);
    const last = rows[rows.length - 1].id;
    if (afterId !== null && last <= afterId) throw new Error("fetchAllByIdKeyset: id não avançou");
    afterId = last;
  }
}

/**
 * Divide `items` em lotes de até `size`. Usado em `.in(col, lote)`: lista longa
 * de uuid estoura o tamanho de URL do PostgREST.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("chunk: size inválido");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Tamanho de lote para `.in()` com uuid (36 chars): ~7 KB de URL por lote. */
export const IN_BATCH_SIZE = 200;

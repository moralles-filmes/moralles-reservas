/**
 * Lê uma consulta PostgREST inteira em páginas (o servidor trunca em 1000 linhas sem avisar).
 * `build` deve ordenar por coluna estável (`.order("id")`) e aplicar `.range(from, to)`.
 * Erro de qualquer página sobe; nunca devolve resultado parcial.
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

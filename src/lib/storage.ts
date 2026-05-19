import { supabase } from "@/lib/supabase";
import { extractStoragePath } from "@/lib/utils";

const BUCKET = "unit-assets";

/**
 * Apaga um arquivo do bucket `unit-assets` a partir da sua URL pública.
 * Silencioso em erro — cleanup secundário não deve quebrar fluxo do usuário.
 * Retorna void; em falha, faz console.warn (não toast).
 *
 * Se `unitId` for fornecido, valida que o path começa com `<unit_id>/` antes
 * de deletar — defesa contra apagar arquivo de outra unit por acidente.
 */
export async function deleteUnitAssetByUrl(
  url: string | null | undefined,
  unitId?: string,
): Promise<void> {
  const path = extractStoragePath(url, BUCKET);
  if (!path) return;
  if (unitId && !path.startsWith(`${unitId}/`)) {
    // eslint-disable-next-line no-console
    console.warn("[storage] path fora da unit, ignorando delete", { path, unitId });
    return;
  }
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[storage] falha ao apagar asset", path, error.message);
  }
}

/**
 * Versão em lote — mais eficiente quando há múltiplos arquivos pra apagar
 * (ex: deletar um cardápio inteiro e suas páginas).
 */
export async function deleteUnitAssetsByUrls(
  urls: Array<string | null | undefined>,
  unitId?: string,
): Promise<void> {
  const paths = urls
    .map((u) => extractStoragePath(u, BUCKET))
    .filter((p): p is string => p !== null)
    .filter((p) => !unitId || p.startsWith(`${unitId}/`));
  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[storage] falha ao apagar assets em lote", paths, error.message);
  }
}

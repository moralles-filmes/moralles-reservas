import { supabase } from "@/lib/supabase";

/** Linha de `settings` como a tela usa: chave e valor. */
export interface SettingRow {
  key: string;
  value: unknown;
}

/** Linhas de `settings` da unidade para as chaves dadas. O erro do PostgREST sobe como está. */
export async function fetchSettingRows(unitId: string, keys: readonly string[]): Promise<SettingRow[]> {
  const { data, error } = await supabase
    .from("settings")
    .select("key, value")
    .eq("unit_id", unitId)
    .in("key", [...keys]);
  if (error) throw error;
  return (data ?? []) as SettingRow[];
}

/**
 * `upsert` em lote com `.select()`: devolve as linhas gravadas, para o chamador
 * conferir o tamanho (UPDATE que casa zero linhas volta `error: null`). O erro do
 * PostgREST sobe como está, com `code`.
 */
export async function upsertSettingRows(
  rows: Array<{ unit_id: string; key: string; value: unknown }>,
): Promise<unknown[]> {
  const { data, error } = await supabase.from("settings").upsert(rows, { onConflict: "unit_id,key" }).select();
  if (error) throw error;
  return data ?? [];
}

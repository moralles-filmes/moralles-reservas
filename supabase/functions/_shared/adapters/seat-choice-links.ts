// Adapter de `seat_choice_links` (links de escolha de mesa do WhatsApp e do Instagram).
// Também a lista de salões ativos usada para achar a mesa escolhida.
// FORCE RLS sem policy: só service role, e toda escrita leva o `unit_id` do turno.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface SeatChoiceLinkRow {
  unit_id: string;
  hall_id: string;
  /** Canal do WhatsApp; nulo no link do Instagram (um canal só por link). */
  channel_id: string | null;
  /** Conta do Instagram (`instagram_accounts.id`); nula no link do WhatsApp. */
  instagram_account_id: string | null;
  date: string;
  time: string;
  party_size: number;
  token_hash: string;
  expires_at: string;
}

/** Apaga os links vencidos da unidade. Devolve o `code` do erro, sem lançar. */
export async function purgeExpiredSeatLinks(
  supabase: SupabaseClient,
  unitId: string,
  nowIso: string,
): Promise<{ errorCode: string | null; failed: boolean }> {
  const { error } = await supabase
    .from("seat_choice_links")
    .delete()
    .eq("unit_id", unitId)
    .lt("expires_at", nowIso);
  return { failed: !!error, errorCode: error?.code ?? null };
}

/** Grava um link (só o hash do token). Devolve o `code` do erro, sem lançar. */
export async function insertSeatLink(
  supabase: SupabaseClient,
  row: SeatChoiceLinkRow,
): Promise<{ errorCode: string | null; failed: boolean }> {
  const { error } = await supabase.from("seat_choice_links").insert(row);
  return { failed: !!error, errorCode: error?.code ?? null };
}

/** Salões ativos da unidade, em `sort_order` (nunca de outra unidade). Lança em erro de leitura. */
export async function activeHallIds(supabase: SupabaseClient, unitId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("halls")
    .select("id")
    .eq("unit_id", unitId)
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((h) => h.id);
}

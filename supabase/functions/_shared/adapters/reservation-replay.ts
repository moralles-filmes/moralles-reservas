// Leitura do reenvio (F-002B): a busca com service role da reserva do mesmo
// pedido. Decisão e polaridade em ../reservation-replay.ts.
import { type ExistingReservation, pickSameRequest, REPLAY_WINDOW_MINUTES, type ReplayRow, type SameRequestParams } from "../reservation-replay.ts";

// Tipo estrutural mínimo: o helper roda no Deno e no Vitest sem importar o SDK.
// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };

/**
 * Service role: filtra SEMPRE unit_id e customer_id (o tenant vem do recurso já
 * validado pelo chamador, nunca de id livre do payload).
 */
export async function findRecentSameRequest(
  supabase: Client,
  params: SameRequestParams,
  nowMs = Date.now(),
): Promise<ExistingReservation | null> {
  if (params.reservationIds && params.reservationIds.length === 0) return null;
  const cutoffIso = new Date(nowMs - REPLAY_WINDOW_MINUTES * 60_000).toISOString();
  try {
    let query = supabase
      .from("reservations")
      .select("id, reservation_code, status, payment_status, table_id, time, party_size, created_at, occupant_tables(table_id)")
      .eq("unit_id", params.unitId)
      .eq("customer_id", params.customerId)
      .eq("date", params.date)
      .eq("party_size", params.partySize)
      .in("status", ["pending", "confirmed"])
      .gte("created_at", cutoffIso);
    if (params.reservationIds) query = query.in("id", [...params.reservationIds]);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(10);
    if (error || !Array.isArray(data)) {
      console.error(JSON.stringify({ evt: "reservation_replay_lookup_failed", code: error?.code ?? null }));
      return null;
    }
    return pickSameRequest(data as ReplayRow[], params, nowMs);
  } catch (err) {
    console.error(JSON.stringify({
      evt: "reservation_replay_lookup_failed",
      errorClass: err instanceof Error ? err.name : typeof err,
    }));
    return null;
  }
}

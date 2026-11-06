// Reenvio do mesmo pedido devolve a reserva que já existe (F-002B).
//
// Mesmo pedido = mesmo cliente + unidade + data + horário (HH:MM) + pessoas,
// reserva pending/confirmed criada há até REPLAY_WINDOW_MINUTES. Mesa e salão
// não entram: uma pessoa não senta em duas mesas no mesmo horário, e a troca de
// mesa continua com a equipe. Spec: docs/superpowers/specs/2026-11-06-reenvio-reserva-design.md
//
// Polaridade: erro de leitura devolve `null` (segue o fluxo normal e pode criar
// a reserva). Falhar fechado aqui recusaria reserva nova por soluço de leitura;
// o pior caso de falhar aberto é a duplicata que já existia antes deste helper.
//
// Caução: nenhum caminho do cliente cria reserva com caução hoje. Se voltar a
// existir, o reaproveitamento tem de devolver o MESMO pagamento pendente.

export const REPLAY_WINDOW_MINUTES = 15;

export interface SameRequestParams {
  unitId: string;
  customerId: string;
  date: string;
  time: string;
  partySize: number;
  /**
   * Identidade declarada (Instagram): só reservas do ledger do contato.
   * Lista vazia = nenhuma reserva elegível, sem consulta.
   */
  reservationIds?: readonly string[];
}

export interface ExistingReservation {
  id: string;
  reservationCode: string;
  status: string;
  paymentStatus: string | null;
  tableId: string | null;
  tableIds: string[];
  /** HH:MM gravado, para a mensagem ao cliente. */
  time: string;
}

export interface ReplayRow {
  id: string;
  reservation_code: string;
  status: string;
  payment_status: string | null;
  table_id: string | null;
  time: string;
  party_size: number;
  created_at: string;
  occupant_tables?: Array<{ table_id: string }> | null;
}

/** Decisão pura: a mais recente que casa com o pedido dentro da janela. */
export function pickSameRequest(
  rows: readonly ReplayRow[],
  params: Pick<SameRequestParams, "time" | "partySize" | "reservationIds">,
  nowMs: number,
): ExistingReservation | null {
  const cutoff = nowMs - REPLAY_WINDOW_MINUTES * 60_000;
  const hhmm = params.time.slice(0, 5);
  const allowed = params.reservationIds ? new Set(params.reservationIds) : null;
  const match = rows
    .filter(r =>
      (r.status === "pending" || r.status === "confirmed")
      && typeof r.time === "string" && r.time.slice(0, 5) === hhmm
      && r.party_size === params.partySize
      && Date.parse(r.created_at) >= cutoff
      && (!allowed || allowed.has(r.id)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!match) return null;
  const extra = (match.occupant_tables ?? []).map(o => o.table_id).filter(id => typeof id === "string");
  const tableIds = [...new Set([...(match.table_id ? [match.table_id] : []), ...extra])];
  return {
    id: match.id,
    reservationCode: match.reservation_code,
    status: match.status,
    paymentStatus: match.payment_status,
    tableId: match.table_id,
    tableIds,
    time: match.time.slice(0, 5),
  };
}

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

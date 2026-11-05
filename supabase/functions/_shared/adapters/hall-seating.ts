// Adapter de I/O da escolha de mesa: leituras de ocupação, combinações e
// salão, e a gravação de reserva com várias mesas. Consumido por
// _shared/availability.ts (regras) e pelas EFs de edição de reserva.
// Toda query filtra a unidade recebida; erro de leitura falha fechado.

// deno-lint-ignore-file no-explicit-any

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { SeatCombination, SeatTable } from "../availability-core.ts";
import type { ReservationInsertRow } from "../availability.ts";

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

// ─── Ocupação do salão no horário pedido ─────────────────────────────────────

/** Leitura nova (ocupação, combinações) que falha: recusa em vez de "livre". */
export function readFailed(where: string): never {
  console.error(JSON.stringify({ evt: "availability_read_failed", where }));
  throw new Error("availability_read_failed");
}

/** Início de ontem em BRT (ms), igual a `v_since_day` de set_occupant_tables. */
function brtYesterdayStartMs(nowMs: number): number {
  const todayBrt = new Date(nowMs - 3 * 3_600_000).toISOString().slice(0, 10);
  return Date.parse(`${todayBrt}T00:00:00-03:00`) - 86_400_000;
}

export interface SeatingTableRow {
  id: string;
  number: number | null;
  min_capacity: number;
  max_capacity: number;
  bookable?: boolean | null;
  plan_x?: number | null;
  plan_y?: number | null;
  plan_w?: number | null;
  plan_h?: number | null;
  plan_rotation?: number | null;
  plan_shape?: string | null;
}

export interface HallSeating {
  rows: SeatingTableRow[];
  tables: SeatTable[];
  combinations: SeatCombination[];
  /** Mesas com bloqueio próprio na janela. */
  blocked: Set<string>;
  /** Mesas ocupadas por reserva com mesa, reserva que já chegou, passante ou fila sentados. */
  pinned: Set<string>;
  /** Pessoas das reservas flutuantes (sem mesa) que cruzam a janela. */
  floating: number[];
}

/**
 * Mesas, combinações e ocupação do salão na janela `[date time, + duração)`.
 * A ocupação vem de `occupant_tables` (todas as mesas de cada reserva, inclusive
 * as juntadas) mais o `table_id` legado; passante, fila e reserva que já chegou
 * ocupam de quando sentaram até `+ duração`, estendido até agora (mesma regra
 * de `set_occupant_tables`, só desde ontem BRT).
 */
export async function loadHallSeating(supabase: SupabaseClient, args: {
  unitId: string;
  hallId: string;
  date: string;
  time: string;
  requestedMin: number;
  duration: number;
  excludeReservationId?: string;
  singleTableOnly?: boolean;
}): Promise<HallSeating> {
  const { unitId, hallId, date, time, requestedMin, duration, excludeReservationId } = args;
  const startMs = new Date(`${date}T${time}:00-03:00`).getTime();
  const endMs = startMs + duration * 60_000;
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();
  const nowMs = Date.now();
  const sinceDayMs = brtYesterdayStartMs(nowMs);
  const occupiesWindow = (fromMs: number) =>
    fromMs >= sinceDayMs && fromMs < endMs && Math.max(fromMs + duration * 60_000, nowMs + 60_000) > startMs;

  const { data: tablesRaw, error: tablesErr } = await supabase
    .from("tables")
    .select("id, number, min_capacity, max_capacity, bookable, plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape")
    .eq("unit_id", unitId)
    .eq("hall_id", hallId)
    .eq("active", true);
  if (tablesErr) readFailed("tables");
  const rows = (tablesRaw ?? []) as SeatingTableRow[];
  const hallTableIds = new Set(rows.map((t) => t.id));
  const empty: HallSeating = { rows, tables: [], combinations: [], blocked: new Set(), pinned: new Set(), floating: [] };
  if (rows.length === 0) return empty;

  // Combinações ativas do salão (desativadas pela mesa ou pelo editor não valem).
  let combinations: SeatCombination[] = [];
  if (!args.singleTableOnly) {
    const { data: combosRaw, error: combosErr } = await supabase
      .from("table_combinations")
      .select("id, min_capacity, max_capacity")
      .eq("unit_id", unitId)
      .eq("hall_id", hallId)
      .eq("active", true);
    if (combosErr) readFailed("table_combinations");
    const combos = (combosRaw ?? []) as Array<{ id: string; min_capacity: number; max_capacity: number }>;
    if (combos.length > 0) {
      const { data: membersRaw, error: membersErr } = await supabase
        .from("table_combination_members")
        .select("combination_id, table_id")
        .eq("unit_id", unitId)
        .in("combination_id", combos.map((c) => c.id));
      if (membersErr) readFailed("table_combination_members");
      const byCombo = new Map<string, string[]>();
      for (const m of (membersRaw ?? []) as Array<{ combination_id: string; table_id: string }>) {
        byCombo.set(m.combination_id, [...(byCombo.get(m.combination_id) ?? []), m.table_id]);
      }
      combinations = combos.map((c) => ({
        id: c.id,
        // Membro fora do salão (ou inativo) fica na lista e derruba a combinação no núcleo.
        tableIds: byCombo.get(c.id) ?? [],
        minCapacity: c.min_capacity,
        maxCapacity: c.max_capacity,
      }));
    }
  }
  const inCombination = new Set(combinations.flatMap((c) => c.tableIds));
  const tables: SeatTable[] = rows.map((t) => ({
    id: t.id,
    number: Number(t.number) || 0,
    minCapacity: t.min_capacity,
    maxCapacity: t.max_capacity,
    // Coluna NOT NULL DEFAULT true; ausente só em linha antiga de teste.
    bookable: t.bookable !== false,
    inCombination: inCombination.has(t.id),
  }));

  // Bloqueios da própria mesa na janela (o macro de salão/unidade já recusou antes).
  const { data: blocksRaw, error: blocksErr } = await supabase
    .from("table_blocks")
    .select("table_id")
    .eq("unit_id", unitId)
    .in("table_id", [...hallTableIds])
    .lt("blocked_from", endISO)
    .gt("blocked_to", startISO);
  // Mesa bloqueada que aparece livre não tem trava no banco depois: falha fechado.
  if (blocksErr) readFailed("table_blocks");
  const blocked = new Set<string>((blocksRaw ?? []).map((b: any) => b.table_id));

  const pinned = new Set<string>();
  const floating: number[] = [];
  const addTables = (ids: Iterable<string | null | undefined>) => {
    for (const id of ids) if (id && hallTableIds.has(id)) pinned.add(id);
  };

  // Reservas ativas do dia: cruzam pela janela da reserva ou pela ocupação de quem já chegou.
  const { data: resRaw, error: resErr } = await supabase
    .from("reservations")
    .select("id, time, party_size, table_id, arrived_at")
    .eq("unit_id", unitId)
    .eq("date", date)
    .in("status", ["pending", "confirmed"])
    .is("released_at", null);
  if (resErr) readFailed("reservations");
  const conflicting = ((resRaw ?? []) as Array<{ id: string; time: string; party_size: number; table_id: string | null; arrived_at: string | null }>)
    .filter((r) => {
      if (r.id === excludeReservationId) return false;
      if (Math.abs(parseTimeToMinutes(r.time) - requestedMin) < duration) return true;
      return r.arrived_at != null && occupiesWindow(new Date(r.arrived_at).getTime());
    });
  if (conflicting.length > 0) {
    const { data: occRaw, error: occErr } = await supabase
      .from("occupant_tables")
      .select("reservation_id, table_id")
      .eq("unit_id", unitId)
      .in("reservation_id", conflicting.map((r) => r.id));
    if (occErr) readFailed("occupant_tables");
    const byRes = new Map<string, string[]>();
    for (const o of (occRaw ?? []) as Array<{ reservation_id: string; table_id: string }>) {
      byRes.set(o.reservation_id, [...(byRes.get(o.reservation_id) ?? []), o.table_id]);
    }
    for (const r of conflicting) {
      const ids = new Set([...(byRes.get(r.id) ?? []), ...(r.table_id ? [r.table_id] : [])]);
      if (ids.size === 0) floating.push(r.party_size);
      else addTables(ids);
    }
  }

  // Passante e fila sentados só ocupam se a janela começa antes de a ocupação prevista acabar.
  if (startMs < nowMs + duration * 60_000 + 60_000) {
    const createdSince = new Date(sinceDayMs - 86_400_000).toISOString();
    const seatedOf = async (table: "walk_ins" | "waitlist", fallbackCol: "arrived_at" | "created_at", fk: "walk_in_id" | "waitlist_id") => {
      const { data, error } = await supabase
        .from(table)
        .select(`id, table_id, seated_at, ${fallbackCol}`)
        .eq("unit_id", unitId)
        .eq("status", "seated")
        .is("released_at", null)
        .gte("created_at", createdSince);
      if (error) readFailed(table);
      const seated = ((data ?? []) as any[]).filter((w) => {
        const from = w.seated_at ?? w[fallbackCol];
        return from != null && occupiesWindow(new Date(from).getTime());
      });
      if (seated.length === 0) return;
      const { data: occ, error: occErr } = await supabase
        .from("occupant_tables")
        .select(`${fk}, table_id`)
        .eq("unit_id", unitId)
        .in(fk, seated.map((w) => w.id));
      if (occErr) readFailed(`occupant_tables:${fk}`);
      addTables(((occ ?? []) as any[]).map((o) => o.table_id));
      addTables(seated.map((w) => w.table_id));
    };
    await seatedOf("walk_ins", "arrived_at", "walk_in_id");
    await seatedOf("waitlist", "created_at", "waitlist_id");
  }

  return { rows, tables, combinations, blocked, pinned, floating };
}

/** A unidade tem algum salão ativo (salão pedido alheio não cai no caminho legado). */
export async function unitHasActiveHall(supabase: SupabaseClient, unitId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("halls")
    .select("id")
    .eq("unit_id", unitId)
    .eq("active", true)
    .limit(1);
  if (error) readFailed("halls");
  return (data ?? []).length > 0;
}

/**
 * Chave `seat_choice_enabled` da unidade (cliente escolhe a mesa).
 * Falha FECHADA de propósito: erro de leitura ou linha ausente = desligada, e o
 * cliente segue o fluxo sem escolha (decisão do dono). Nunca lança.
 */
export async function loadSeatChoiceEnabled(supabase: SupabaseClient, unitId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("unit_id", unitId)
      .eq("key", "seat_choice_enabled")
      .maybeSingle();
    if (error) {
      console.error(JSON.stringify({ evt: "seat_choice_setting_read_failed" }));
      return false;
    }
    return data?.value === true;
  } catch {
    console.error(JSON.stringify({ evt: "seat_choice_setting_read_failed" }));
    return false;
  }
}

export interface PlanHallRow {
  id: string;
  name: string;
  allow_empty_seat: boolean;
  plan_width_cm: number | null;
  plan_depth_cm: number | null;
  plan_entrance_wall: string | null;
  plan_entrance_offset_cm: number | null;
  plan_window_walls: string[] | null;
}

/** Salão ativo da unidade com as medidas da planta; null = alheio, inativo ou inexistente. */
export async function loadPlanHall(supabase: SupabaseClient, unitId: string, hallId: string): Promise<PlanHallRow | null> {
  const { data, error } = await supabase
    .from("halls")
    .select("id, name, allow_empty_seat, plan_width_cm, plan_depth_cm, plan_entrance_wall, plan_entrance_offset_cm, plan_window_walls")
    .eq("id", hallId)
    .eq("unit_id", unitId)
    .eq("active", true)
    .maybeSingle();
  if (error) readFailed("halls");
  return (data ?? null) as PlanHallRow | null;
}

/** Mesas atuais da reserva (a principal e as juntadas), filtradas pela unidade. */
export async function loadReservationTableIds(
  db: { from: (t: string) => any },
  reservationId: string,
  unitId: string,
): Promise<{ ok: true; tableIds: string[] } | { ok: false; code: string | null }> {
  const { data, error } = await db
    .from("occupant_tables")
    .select("table_id")
    .eq("reservation_id", reservationId)
    .eq("unit_id", unitId);
  if (error) return { ok: false, code: typeof error.code === "string" ? error.code : null };
  return { ok: true, tableIds: (Array.isArray(data) ? data : []).map((o: { table_id: string }) => o.table_id) };
}

/** Reserva com 2+ mesas numa transação (RPC só service_role). A RPC devolve o id;
 *  status e pagamento vêm da linha gravada, como no INSERT direto. Se só essa leitura
 *  falhar, a reserva JÁ existe: devolve o id com estado desconhecido (null), para o
 *  chamador responder "criada, estado não confirmado" em vez de convidar a tentar de
 *  novo (o que criaria outra reserva ou recusaria a mesa pela própria reserva). */
export async function insertWithTables(
  supabase: SupabaseClient,
  row: ReservationInsertRow,
  tableIds: string[],
  tableChoice: "customer" | "system",
): Promise<{ data: { id: string; status: string | null; payment_status: string | null } | null; error: { code?: string } | null }> {
  const { table_id: _principal, ...rest } = row;
  const { data: id, error } = await supabase.rpc("insert_reservation_with_tables", {
    p_row: { ...rest, table_choice: tableChoice },
    p_table_ids: tableIds,
  });
  if (error || typeof id !== "string") return { data: null, error: error ?? { code: "no_id" } };
  const { data, error: readErr } = await supabase
    .from("reservations")
    .select("id,status,payment_status")
    .eq("id", id)
    .eq("unit_id", row.unit_id)
    .single();
  if (readErr || !data) {
    console.error(JSON.stringify({
      evt: "reserve_with_tables_readback_failed",
      code: typeof readErr?.code === "string" ? readErr.code : "no_row",
    }));
    return { data: { id, status: null, payment_status: null }, error: null };
  }
  return { data, error: null };
}

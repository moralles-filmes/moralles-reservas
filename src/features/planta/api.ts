import { supabase } from "@/lib/supabase";
import type { Hall, Mesa, TableCombination, PlanWall, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";
import type { BlockWindow } from "@/lib/table-situation-core";
import { HALL_NOT_IN_UNIT_MESSAGE } from "@/lib/layout-errors";

/** Colunas de `Mesa`, com a planta (`plan_*`). */
export const TABLE_COLUMNS =
  "id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active, plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape, bookable";

/** Payload de `save_hall_plan`, como `toSavePayload` monta. */
export interface SaveHallPlanArgs {
  p_hall: {
    width_cm: number;
    depth_cm: number;
    entrance_wall: PlanWall | null;
    entrance_offset_cm: number | null;
    window_walls: PlanWall[];
  };
  p_tables: Array<{
    id: string;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
    rotation: number | null;
    shape: "round" | "square" | "rect" | null;
    /** Ausente = não muda. */
    bookable?: boolean;
  }>;
  /** Nulo ou ausente = não mexe; array = conjunto ativo de combinações do salão. */
  p_combinations?: Array<{ min: number; max: number; table_ids: string[] }> | null;
}

/**
 * Salão e mesas ativas dele, só da unidade dada. O erro do PostgREST sobe como está;
 * salão de outra unidade ou inexistente sobe como `Error(HALL_NOT_IN_UNIT_MESSAGE)`.
 */
export async function fetchHallPlan(unitId: string, hallId: string): Promise<{ hall: Hall; tables: Mesa[]; combinations: TableCombination[] }> {
  const [hallRes, tablesRes, combinationsRes] = await Promise.all([
    supabase.from("halls").select("*").eq("id", hallId).eq("unit_id", unitId).maybeSingle(),
    supabase
      .from("tables")
      .select(TABLE_COLUMNS)
      .eq("unit_id", unitId)
      .eq("hall_id", hallId)
      .eq("active", true)
      .order("number", { ascending: true }),
    supabase.from("table_combinations").select("id, unit_id, hall_id, min_capacity, max_capacity, active, table_combination_members(table_id)").eq("unit_id", unitId).eq("hall_id", hallId).eq("active", true),
  ]);
  if (hallRes.error) throw hallRes.error;
  if (!hallRes.data) throw new Error(HALL_NOT_IN_UNIT_MESSAGE);
  if (tablesRes.error) throw tablesRes.error;
  if (combinationsRes.error) throw combinationsRes.error;
  const combinations = (combinationsRes.data ?? []).map(({ table_combination_members, ...combination }) => ({
    ...combination, table_ids: table_combination_members.map((member) => member.table_id),
  })) as TableCombination[];
  return { hall: hallRes.data as Hall, tables: (tablesRes.data ?? []) as Mesa[], combinations };
}

/**
 * Grava a planta numa transação e devolve o `updated_at` novo do salão. A revisão vai
 * como a string que o PostgREST devolveu: passar por Date perde os microssegundos e a
 * RPC recusaria todo salvamento com 40001. O erro sobe com `code`.
 */
export async function saveHallPlan(
  hallId: string,
  expectedUpdatedAt: string,
  payload: SaveHallPlanArgs,
): Promise<string> {
  const { data, error } = await supabase.rpc("save_hall_plan", {
    p_hall_id: hallId,
    p_expected_updated_at: expectedUpdatedAt,
    p_hall: payload.p_hall,
    p_tables: payload.p_tables,
    ...(payload.p_combinations !== undefined ? { p_combinations: payload.p_combinations } : {}),
  });
  if (error) throw error;
  return data as string;
}

// ─── Dados ao vivo do salão (Task 8) ─────────────────────────────────────────

/** Salões e mesas ativas da unidade, com `plan_*`. */
export async function fetchSalaoPlan(unitId: string): Promise<{ halls: Hall[]; tables: Mesa[] }> {
  const [hallsRes, tablesRes] = await Promise.all([
    supabase
      .from("halls")
      .select("*")
      .eq("unit_id", unitId)
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("tables")
      .select(TABLE_COLUMNS)
      .eq("unit_id", unitId)
      .eq("active", true)
      .order("number", { ascending: true }),
  ]);
  if (hallsRes.error) throw hallsRes.error;
  if (tablesRes.error) throw tablesRes.error;
  return { halls: (hallsRes.data ?? []) as Hall[], tables: (tablesRes.data ?? []) as Mesa[] };
}

/** Reservas de hoje, mais as de ontem que chegaram e ainda não liberaram a mesa (datas em BRT). */
export async function fetchSalaoReservations(unitId: string, today: string, yesterday: string): Promise<Reserva[]> {
  const { data, error } = await supabase
    .from("reservations")
    .select("*, customer:customers(id, name, phone)")
    .eq("unit_id", unitId)
    .in("status", ["pending", "confirmed"])
    .or(`date.eq.${today},and(date.eq.${yesterday},arrived_at.not.is.null,released_at.is.null)`);
  if (error) throw error;
  return (data ?? []) as Reserva[];
}

// Estas consultas são limitadas a ≤ 2 dias (hoje e ontem em BRT), bem abaixo do teto de 1000 linhas do PostgREST.

/** Fila sentada em mesa e ainda não liberada, com `seated_at` desde ontem (BRT). */
export async function fetchSalaoSeatedWaitlist(unitId: string, yesterday: string): Promise<WaitlistEntry[]> {
  const { data, error } = await supabase
    .from("waitlist")
    .select("*")
    .eq("unit_id", unitId)
    .eq("status", "seated")
    .not("table_id", "is", null)
    .is("released_at", null)
    .gte("seated_at", `${yesterday}T00:00:00-03:00`);
  if (error) throw error;
  return (data ?? []) as WaitlistEntry[];
}

/** Passantes sentados em mesa e ainda não liberados, com `seated_at` desde ontem (BRT). */
export async function fetchSalaoSeatedWalkIns(unitId: string, yesterday: string): Promise<WalkIn[]> {
  const { data, error } = await supabase
    .from("walk_ins")
    .select("*, table:tables(number)")
    .eq("unit_id", unitId)
    .eq("status", "seated")
    .not("table_id", "is", null)
    .is("released_at", null)
    .gte("seated_at", `${yesterday}T00:00:00-03:00`);
  if (error) throw error;
  return (data ?? []) as WalkIn[];
}

/** Bloqueios que tocam o dia BRT; a janela exata de "agora" é aplicada pela função pura. */
export async function fetchSalaoBlocks(unitId: string, today: string, tomorrow: string): Promise<BlockWindow[]> {
  const { data, error } = await supabase
    .from("table_blocks")
    .select("table_id, hall_id, blocked_from, blocked_to")
    .eq("unit_id", unitId)
    .gte("blocked_to", `${today}T00:00:00-03:00`)
    .lt("blocked_from", `${tomorrow}T00:00:00-03:00`);
  if (error) throw error;
  return (data ?? []) as BlockWindow[];
}

/** Valor cru de `reservation_duration_minutes` (ou null). */
export async function fetchSalaoDurationSetting(unitId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("unit_id", unitId)
    .eq("key", "reservation_duration_minutes")
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

// ─── Ações de presença (Task 11) ─────────────────────────────────────────────
// Os erros sobem como vieram do PostgREST (`code` e `details`) para `presenceErrorMessage`.

export type PresenceAction = "arrive" | "undo_arrive" | "release";

/** Chegada, desfazer chegada ou liberação da mesa de uma reserva. */
export async function setReservationPresence(reservationId: string, action: PresenceAction): Promise<boolean> {
  const { data, error } = await supabase.rpc("set_reservation_presence", {
    p_reservation_id: reservationId,
    p_action: action,
  });
  if (error) throw error;
  // false = nada mudou (já estava assim). null/undefined vêm da RPC antiga (front sobe antes da migration): conta como mudou.
  return (data as unknown) !== false;
}

/** Senta uma entrada da fila na mesa. */
export async function seatWaitlistEntry(waitlistId: string, tableId: string): Promise<void> {
  const { error } = await supabase.rpc("seat_waitlist_entry", { p_waitlist_id: waitlistId, p_table_id: tableId });
  if (error) throw error;
}

/** Libera a mesa de uma entrada da fila sentada. */
export async function releaseWaitlistEntry(waitlistId: string): Promise<void> {
  const { error } = await supabase.rpc("release_waitlist_entry", { p_waitlist_id: waitlistId });
  if (error) throw error;
}

/** Libera a mesa de um passante sentado (carimba `released_at`, não muda `status`). */
export async function releaseWalkIn(walkInId: string): Promise<void> {
  const { error } = await supabase.rpc("release_walk_in", { p_walk_in_id: walkInId });
  if (error) throw error;
}

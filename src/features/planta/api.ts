import { supabase } from "@/lib/supabase";
import type { Hall, Mesa, PlanWall, Reserva, WaitlistEntry } from "@/types/reserva";
import type { BlockWindow } from "@/lib/table-situation-core";

/** Colunas de `Mesa`, com a planta (`plan_*`). */
export const TABLE_COLUMNS =
  "id, unit_id, hall_id, number, capacity, min_capacity, max_capacity, location, active, plan_x, plan_y, plan_w, plan_h, plan_rotation, plan_shape";

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
  }>;
}

/** Salão e mesas ativas dele, só da unidade dada. O erro do PostgREST sobe como está. */
export async function fetchHallPlan(unitId: string, hallId: string): Promise<{ hall: Hall; tables: Mesa[] }> {
  const [hallRes, tablesRes] = await Promise.all([
    supabase.from("halls").select("*").eq("id", hallId).eq("unit_id", unitId).single(),
    supabase
      .from("tables")
      .select(TABLE_COLUMNS)
      .eq("unit_id", unitId)
      .eq("hall_id", hallId)
      .eq("active", true)
      .order("number", { ascending: true }),
  ]);
  if (hallRes.error) throw hallRes.error;
  if (tablesRes.error) throw tablesRes.error;
  return { hall: hallRes.data as Hall, tables: (tablesRes.data ?? []) as Mesa[] };
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

/** Fila sentada em mesa e ainda não liberada. */
export async function fetchSalaoSeatedWaitlist(unitId: string): Promise<WaitlistEntry[]> {
  const { data, error } = await supabase
    .from("waitlist")
    .select("*")
    .eq("unit_id", unitId)
    .eq("status", "seated")
    .not("table_id", "is", null)
    .is("released_at", null);
  if (error) throw error;
  return (data ?? []) as WaitlistEntry[];
}

/** Bloqueios que tocam o dia BRT; a janela exata de "agora" é aplicada pela função pura. */
export async function fetchSalaoBlocks(unitId: string, today: string): Promise<BlockWindow[]> {
  const { data, error } = await supabase
    .from("table_blocks")
    .select("table_id, hall_id, blocked_from, blocked_to")
    .eq("unit_id", unitId)
    .gte("blocked_to", `${today}T00:00:00-03:00`)
    .lte("blocked_from", `${today}T23:59:59-03:00`);
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

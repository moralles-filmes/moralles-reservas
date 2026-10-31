import { supabase } from "@/lib/supabase";
import type { Hall, Mesa, PlanWall } from "@/types/reserva";

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

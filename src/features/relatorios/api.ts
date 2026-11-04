import { supabase } from "@/lib/supabase";
import { brtDayBounds } from "@/lib/brt";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import type { PassanteRow } from "@/lib/relatorio-passantes";

const WALK_IN_COLUMNS = "id, party_size, status, arrived_at, seated_at, released_at, table_id";

export interface ReportTableRow {
  id: string;
  number: number;
  hall_id: string;
}

export interface ReportHallRow {
  id: string;
  name: string;
}

/** Passantes da unidade que chegaram nos dias civis BRT `fromKey..toKey`, paginado. */
export function fetchPassantesWalkIns(
  unitId: string,
  fromKey: string,
  toKey: string,
): Promise<PassanteRow[]> {
  const { startIso, endIsoExclusive } = brtDayBounds(fromKey, toKey);
  return fetchAllPages<PassanteRow>((from, to) =>
    supabase
      .from("walk_ins")
      .select(WALK_IN_COLUMNS)
      .eq("unit_id", unitId)
      .gte("arrived_at", startIso)
      .lt("arrived_at", endIsoExclusive)
      .order("id")
      .range(from, to),
  );
}

/** Mesas e salões da unidade, inclusive inativos: o histórico não pode sumir. */
export async function fetchUnitTablesAndHalls(
  unitId: string,
): Promise<{ tables: ReportTableRow[]; halls: ReportHallRow[] }> {
  const [tables, halls] = await Promise.all([
    fetchAllPages<ReportTableRow>((from, to) =>
      supabase
        .from("tables")
        .select("id, number, hall_id")
        .eq("unit_id", unitId)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<ReportHallRow>((from, to) =>
      supabase
        .from("halls")
        .select("id, name")
        .eq("unit_id", unitId)
        .order("id")
        .range(from, to),
    ),
  ]);
  return { tables, halls };
}

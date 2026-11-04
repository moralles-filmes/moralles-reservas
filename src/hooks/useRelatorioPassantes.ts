import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { addDaysKey, brtDayBounds, daysBetweenInclusive, localDateKey } from "@/lib/brt";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import {
  comparePassantes,
  computePassantesReport,
  type PassanteRow,
} from "@/lib/relatorio-passantes";
import type { DateRange } from "@/hooks/useFluxoClientes";

interface TableRow {
  id: string;
  number: number;
  hall_id: string;
}

interface HallRow {
  id: string;
  name: string;
}

const WALK_IN_COLUMNS = "id, party_size, status, arrived_at, seated_at, released_at, table_id";

export function useRelatorioPassantes(
  unitId: string,
  range: DateRange,
  ticketMedioReais: number | null,
) {
  const fromKey = localDateKey(range.from);
  const toKey = localDateKey(range.to);

  // Período anterior: mesmo nº de dias, imediatamente antes.
  const days = Math.max(1, daysBetweenInclusive(fromKey, toKey));
  const prevToKey = addDaysKey(fromKey, -1);
  const prevFromKey = addDaysKey(fromKey, -days);

  const query = useQuery({
    queryKey: ["relatorio-passantes", unitId, fromKey, toKey],
    placeholderData: keepPreviousData,
    enabled: !!unitId,
    queryFn: async () => {
      const readWalkIns = (a: string, b: string) => {
        const { startIso, endIsoExclusive } = brtDayBounds(a, b);
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
      };

      // Mesas e salões inativos entram de propósito: o histórico não pode sumir.
      const [current, previous, tables, halls] = await Promise.all([
        readWalkIns(fromKey, toKey),
        readWalkIns(prevFromKey, prevToKey),
        fetchAllPages<TableRow>((from, to) =>
          supabase
            .from("tables")
            .select("id, number, hall_id")
            .eq("unit_id", unitId)
            .order("id")
            .range(from, to),
        ),
        fetchAllPages<HallRow>((from, to) =>
          supabase
            .from("halls")
            .select("id, name")
            .eq("unit_id", unitId)
            .order("id")
            .range(from, to),
        ),
      ]);

      return { current, previous, tables, halls };
    },
  });

  const computed = useMemo(() => {
    const data = query.data;
    const ticketCents =
      ticketMedioReais && ticketMedioReais > 0 ? Math.round(ticketMedioReais * 100) : 0;
    const tables = data?.tables ?? [];
    const halls = data?.halls ?? [];
    const report = computePassantesReport({
      walkIns: data?.current ?? [],
      tables,
      halls,
      fromKey,
      toKey,
      ticketCents,
    });
    const previous = computePassantesReport({
      walkIns: data?.previous ?? [],
      tables,
      halls,
      fromKey: prevFromKey,
      toKey: prevToKey,
      ticketCents,
    });
    return { report, previous, comparison: comparePassantes(report, previous) };
  }, [query.data, ticketMedioReais, fromKey, toKey, prevFromKey, prevToKey]);

  return {
    ...computed,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

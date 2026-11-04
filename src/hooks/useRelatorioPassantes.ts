import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { addDaysKey, daysBetweenInclusive, localDateKey } from "@/lib/brt";
import { comparePassantes, computePassantesReport } from "@/lib/relatorio-passantes";
import { fetchPassantesWalkIns, fetchUnitTablesAndHalls } from "@/features/relatorios/api";
import type { DateRange } from "@/hooks/useFluxoClientes";

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
      const [current, previous, { tables, halls }] = await Promise.all([
        fetchPassantesWalkIns(unitId, fromKey, toKey),
        fetchPassantesWalkIns(unitId, prevFromKey, prevToKey),
        fetchUnitTablesAndHalls(unitId),
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

import { brtDayBounds, brtTodayKey } from "@/lib/brt";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface WalkInStatsToday {
  total: number;
  waiting: number;
  seated: number;
  left: number;
  no_show: number;
}

export function useWalkInStatsToday(unitId: string) {
  return useQuery<WalkInStatsToday>({
    queryKey: ["walk-in-stats-today", unitId],
    queryFn: async () => {
      const { startIso, endIsoExclusive } = brtDayBounds(brtTodayKey(), brtTodayKey());

      const data = await fetchAllPages((from, to) => supabase
        .from("walk_ins")
        .select("status")
        .eq("unit_id", unitId)
        .gte("arrived_at", startIso).lt("arrived_at", endIsoExclusive).order("id").range(from, to));

      const stats: WalkInStatsToday = { total: 0, waiting: 0, seated: 0, left: 0, no_show: 0 };
      for (const row of data ?? []) {
        stats.total += 1;
        const s = row.status as keyof WalkInStatsToday;
        if (s in stats) (stats[s] as number) += 1;
      }
      return stats;
    },
    enabled: !!unitId,
    staleTime: 60_000,
  });
}

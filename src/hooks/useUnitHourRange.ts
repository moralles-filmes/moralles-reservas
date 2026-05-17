import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface UnitHourRange {
  min: number;
  max: number;
}

const FALLBACK: UnitHourRange = { min: 8, max: 23 };

interface ScheduleRow {
  open_time: string;
  close_time: string;
}

/**
 * Calcula a janela horária da unit a partir dos hall_schedules dos halls ativos.
 * Usado pelo Dashboard para dimensionar o gráfico de "Ocupação por horário".
 * Fallback 8h-23h quando a unit não tem halls/schedules configurados.
 */
export function useUnitHourRange(unitId: string): UnitHourRange {
  const { data } = useQuery({
    queryKey: ["unit-hour-range", unitId],
    queryFn: async (): Promise<ScheduleRow[]> => {
      const { data: halls, error: hallsErr } = await supabase
        .from("halls")
        .select("id")
        .eq("unit_id", unitId)
        .eq("active", true);
      if (hallsErr) throw hallsErr;
      if (!halls || halls.length === 0) return [];

      const ids = halls.map((h) => h.id);
      const { data: schedules, error: schedErr } = await supabase
        .from("hall_schedules")
        .select("open_time, close_time")
        .in("hall_id", ids);
      if (schedErr) throw schedErr;
      return (schedules ?? []) as ScheduleRow[];
    },
    enabled: !!unitId,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    if (!data || data.length === 0) return FALLBACK;
    let min = 24;
    let max = 0;
    for (const r of data) {
      const oh = parseInt(r.open_time?.split(":")[0] ?? "", 10);
      if (Number.isFinite(oh) && oh < min) min = oh;
      const [chStr, cmStr] = (r.close_time ?? "").split(":");
      const ch = parseInt(chStr ?? "", 10);
      const cm = parseInt(cmStr ?? "", 10);
      if (!Number.isFinite(ch)) continue;
      const closeHourCeil = ch + (Number.isFinite(cm) && cm > 0 ? 1 : 0);
      if (closeHourCeil > max) max = closeHourCeil;
    }
    if (min === 24) min = FALLBACK.min;
    if (max === 0) max = FALLBACK.max;
    return {
      min: Math.max(0, Math.min(23, min)),
      max: Math.max(0, Math.min(23, max)),
    };
  }, [data]);
}

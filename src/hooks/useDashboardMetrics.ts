import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { safeDateParse } from "@/lib/utils";
import type { Period } from "@/components/dashboard/PeriodFilter";
import type { ReservaStatus } from "@/types/reserva";

interface MetricsRow {
  id: string;
  date: string;
  time: string | null;
  party_size: number;
  status: ReservaStatus;
  source: "web" | "whatsapp" | null;
  satisfaction_rating: number | null;
  satisfaction_at: string | null;
  customer: { name: string; phone: string } | null;
}

export interface DashboardKpis {
  reservasConfirmadas: number;
  pessoasAtendidas: number;
  noShowRate: number | null;
  cancelRate: number | null;
  avgRating: number | null;
  ratingsCount: number;
  avgPartySize: number;
  deltas: {
    reservasConfirmadas: number | null;
    pessoasAtendidas: number | null;
    noShowRate: number | null;
    cancelRate: number | null;
    avgRating: number | null;
    avgPartySize: number | null;
  };
}

export interface UnitHourRange {
  min: number;
  max: number;
}

const DEFAULT_HOUR_RANGE: UnitHourRange = { min: 8, max: 23 };

export interface DashboardCharts {
  byDay: Array<{ date: string; label: string; confirmed: number; lost: number }>;
  byHour: Array<{ hour: string; count: number }>;
  ratings: number[];
}

export interface RecentRating {
  id: string;
  date: string;
  time: string | null;
  rating: number;
  customerName: string | null;
  customerPhone: string | null;
}

export interface DashboardLists {
  recentRatings: RecentRating[];
}

interface DashboardMetricsResult {
  kpis: DashboardKpis;
  charts: DashboardCharts;
  lists: DashboardLists;
  hasDataInPeriod: boolean;
  isLoading: boolean;
  error: Error | null;
}

const PERIOD_DAYS: Record<Period, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function toIsoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) {
    if (current === 0) return 0;
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function rawDelta(current: number, previous: number): number | null {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return current - previous;
}

export function useDashboardMetrics(
  unitId: string,
  period: Period,
  unitHours: UnitHourRange = DEFAULT_HOUR_RANGE,
): DashboardMetricsResult {
  const days = PERIOD_DAYS[period];

  const { range, currentStart } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentStart = new Date(today);
    currentStart.setDate(currentStart.getDate() - (days - 1));
    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - days);
    return {
      range: { from: toIsoDate(previousStart), to: toIsoDate(today) },
      currentStart: toIsoDate(currentStart),
    };
  }, [days]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-metrics", unitId, period, range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select(
          "id, date, time, party_size, status, source, satisfaction_rating, satisfaction_at, customer:customers(name, phone)"
        )
        .eq("unit_id", unitId)
        .gte("date", range.from)
        .lte("date", range.to)
        .order("date", { ascending: true });
      if (error) throw error;
      return data as unknown as MetricsRow[];
    },
    enabled: !!unitId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  return useMemo(() => {
    const rows = data ?? [];
    const current = rows.filter((r) => r.date >= currentStart);
    const previous = rows.filter((r) => r.date < currentStart);

    const kpis = computeKpis(current, previous);
    const charts = computeCharts(current, currentStart, days, unitHours);
    const lists = computeLists(current);

    return {
      kpis,
      charts,
      lists,
      hasDataInPeriod: current.length > 0,
      isLoading,
      error: (error as Error | null) ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, currentStart, days, unitHours.min, unitHours.max, isLoading, error]);
}

function computeKpis(current: MetricsRow[], previous: MetricsRow[]): DashboardKpis {
  const c = aggregate(current);
  const p = aggregate(previous);

  return {
    reservasConfirmadas: c.confirmed,
    pessoasAtendidas: c.peopleServed,
    noShowRate: c.noShowRate,
    cancelRate: c.cancelRate,
    avgRating: c.avgRating,
    ratingsCount: c.ratingsCount,
    avgPartySize: c.avgPartySize,
    deltas: {
      reservasConfirmadas: pctDelta(c.confirmed, p.confirmed),
      pessoasAtendidas: pctDelta(c.peopleServed, p.peopleServed),
      noShowRate:
        c.noShowRate !== null && p.noShowRate !== null
          ? rawDelta(c.noShowRate, p.noShowRate)
          : null,
      cancelRate:
        c.cancelRate !== null && p.cancelRate !== null
          ? rawDelta(c.cancelRate, p.cancelRate)
          : null,
      avgRating:
        c.avgRating !== null && p.avgRating !== null
          ? c.avgRating - p.avgRating
          : null,
      avgPartySize: pctDelta(c.avgPartySize, p.avgPartySize),
    },
  };
}

function aggregate(rows: MetricsRow[]) {
  const total = rows.length;
  const confirmedRows = rows.filter((r) => r.status === "confirmed");
  const confirmed = confirmedRows.length;
  const cancelled = rows.filter((r) => r.status === "cancelled").length;
  const noShow = rows.filter((r) => r.status === "no_show").length;

  const peopleServed = confirmedRows.reduce((acc, r) => acc + r.party_size, 0);

  // Denominador: apenas reservas com desfecho decidido (exclui pending).
  const decided = confirmed + cancelled + noShow;
  const noShowDenom = confirmed + noShow;
  const noShowRate: number | null =
    noShowDenom > 0 ? (noShow / noShowDenom) * 100 : null;
  const cancelRate: number | null =
    decided > 0 ? (cancelled / decided) * 100 : null;

  const ratings = rows
    .filter((r) => r.satisfaction_rating !== null)
    .map((r) => r.satisfaction_rating as number);
  const avgRating = ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

  const partySizes = confirmedRows.map((r) => r.party_size);
  const avgPartySize =
    partySizes.length > 0 ? partySizes.reduce((a, b) => a + b, 0) / partySizes.length : 0;

  return {
    total,
    confirmed,
    cancelled,
    noShow,
    peopleServed,
    noShowRate,
    cancelRate,
    avgRating,
    ratingsCount: ratings.length,
    avgPartySize,
  };
}

function computeCharts(
  rows: MetricsRow[],
  currentStart: string,
  days: number,
  unitHours: UnitHourRange,
): DashboardCharts {
  const startDate = safeDateParse(currentStart);
  const byDayMap = new Map<string, { confirmed: number; lost: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    byDayMap.set(toIsoDate(d), { confirmed: 0, lost: 0 });
  }

  for (const r of rows) {
    const bucket = byDayMap.get(r.date);
    if (!bucket) continue;
    if (r.status === "confirmed") bucket.confirmed += 1;
    else if (r.status === "cancelled" || r.status === "no_show") bucket.lost += 1;
  }

  const byDay = Array.from(byDayMap.entries()).map(([date, v]) => ({
    date,
    label: safeDateParse(date).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
    confirmed: v.confirmed,
    lost: v.lost,
  }));

  const hourMin = Math.max(0, Math.min(23, unitHours.min));
  const hourMax = Math.max(hourMin, Math.min(23, unitHours.max));
  const byHourMap = new Map<number, number>();
  for (let h = hourMin; h <= hourMax; h++) byHourMap.set(h, 0);

  for (const r of rows) {
    if (r.status !== "confirmed" || !r.time) continue;
    const hour = parseInt(r.time.split(":")[0], 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
    if (byHourMap.has(hour)) {
      byHourMap.set(hour, (byHourMap.get(hour) ?? 0) + 1);
    }
  }

  const byHour = Array.from(byHourMap.entries()).map(([h, count]) => ({
    hour: `${String(h).padStart(2, "0")}h`,
    count,
  }));

  const ratings = rows
    .filter((r) => r.satisfaction_rating !== null)
    .map((r) => r.satisfaction_rating as number);

  return { byDay, byHour, ratings };
}

function computeLists(rows: MetricsRow[]): DashboardLists {
  const toMs = (r: MetricsRow): number => {
    const iso = r.satisfaction_at ?? `${r.date}T${r.time ?? "00:00"}:00`;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const recentRatings = rows
    .filter((r) => r.satisfaction_rating !== null)
    .sort((a, b) => toMs(b) - toMs(a))
    .slice(0, 5)
    .map<RecentRating>((r) => ({
      id: r.id,
      date: r.date,
      time: r.time,
      rating: r.satisfaction_rating as number,
      customerName: r.customer?.name ?? null,
      customerPhone: r.customer?.phone ?? null,
    }));

  return { recentRatings };
}

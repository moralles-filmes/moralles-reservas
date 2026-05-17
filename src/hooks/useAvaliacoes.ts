import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { DateRange } from "@/hooks/useFluxoClientes";

export interface AvaliacaoRow {
  id: string;
  date: string;
  time: string;
  rating: number;
  ratedAt: string;
  comment: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
}

export interface AvaliacoesData {
  total: number;
  average: number | null;
  distribution: { stars: number; count: number }[];
  totalSurveysSent: number;
  /** null quando nenhuma pesquisa foi enviada no período. */
  responseRatePct: number | null;
  rows: AvaliacaoRow[];
}

interface RawCustomer {
  name: string | null;
  phone: string | null;
  email: string | null;
}

interface RawRow {
  id: string;
  date: string;
  time: string;
  satisfaction_rating: number;
  satisfaction_at: string;
  satisfaction_comment: string | null;
  customer: RawCustomer | RawCustomer[] | null;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function customerOf(row: RawRow): RawCustomer | null {
  if (!row.customer) return null;
  if (Array.isArray(row.customer)) return row.customer[0] ?? null;
  return row.customer;
}

export function useAvaliacoes(unitId: string, range: DateRange) {
  const fromIso = toIsoDate(range.from);
  const toIso = toIsoDate(range.to);

  return useQuery({
    queryKey: ["avaliacoes", unitId, fromIso, toIso],
    placeholderData: keepPreviousData,
    enabled: !!unitId,
    queryFn: async (): Promise<AvaliacoesData> => {
      const startTs = `${fromIso}T00:00:00.000Z`;
      const endDate = new Date(range.to);
      endDate.setHours(23, 59, 59, 999);
      const endTs = endDate.toISOString();

      const [rowsRes, surveysRes] = await Promise.all([
        supabase
          .from("reservations")
          .select(
            "id, date, time, satisfaction_rating, satisfaction_at, satisfaction_comment, customer:customers(name, phone, email)"
          )
          .eq("unit_id", unitId)
          .gte("satisfaction_at", startTs)
          .lte("satisfaction_at", endTs)
          .not("satisfaction_rating", "is", null)
          .order("satisfaction_at", { ascending: false }),
        supabase
          .from("notifications_sent")
          .select("id", { count: "exact", head: true })
          .eq("unit_id", unitId)
          .eq("kind", "survey_d1")
          .eq("status", "sent")
          .gte("sent_at", startTs)
          .lte("sent_at", endTs),
      ]);

      if (rowsRes.error) throw rowsRes.error;

      const raw = (rowsRes.data ?? []) as RawRow[];
      const rows: AvaliacaoRow[] = raw.map((r) => {
        const c = customerOf(r);
        return {
          id: r.id,
          date: r.date,
          time: r.time,
          rating: r.satisfaction_rating,
          ratedAt: r.satisfaction_at,
          comment: r.satisfaction_comment,
          customerName: c?.name ?? null,
          customerPhone: c?.phone ?? null,
          customerEmail: c?.email ?? null,
        };
      });

      const total = rows.length;
      const average = total > 0 ? rows.reduce((s, r) => s + r.rating, 0) / total : null;

      const distribution = [5, 4, 3, 2, 1].map((stars) => ({
        stars,
        count: rows.filter((r) => r.rating === stars).length,
      }));

      const totalSurveysSent = surveysRes.count ?? 0;
      const responseRatePct =
        totalSurveysSent > 0 ? (total / totalSurveysSent) * 100 : null;

      return {
        total,
        average,
        distribution,
        totalSurveysSent,
        responseRatePct,
        rows,
      };
    },
  });
}

export function useAvaliacoesAggregates(data: AvaliacoesData | undefined) {
  return useMemo(() => {
    if (!data) {
      return { total: 0, average: null, distribution: [], rows: [] };
    }
    return data;
  }, [data]);
}

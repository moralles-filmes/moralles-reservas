import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { DateRange } from "@/hooks/useFluxoClientes";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type NotificationKind =
  | "confirmation"
  | "confirmation_email"
  | "reminder_d1"
  | "survey_d1"
  | "cancellation"
  | "waitlist_entered"
  | "waitlist_table_ready"
  | "waitlist_feedback";

export type NotificationStatus = "sent" | "failed" | "skipped";

export type ComunicacaoTab = "geral" | "reserva" | "fila" | "avaliacao";

export interface KpiSet {
  whatsapp: number;
  email: number;
  total: number;
  failed: number;
  skipped: number;
  /** sent / (sent + failed). Skipped não conta no denominador. */
  success_rate_pct: number;
}

export interface DailyEnvio {
  date: string;
  label: string;
  whatsapp: number;
  email: number;
  total: number;
}

export interface KindBucket {
  kind: NotificationKind;
  label: string;
  sent: number;
  failed: number;
  skipped: number;
}

export interface RecentFailure {
  id: string;
  kind: NotificationKind;
  error: string | null;
  sent_at: string;
  /** Telefone mascarado quando temos JOIN com customer. */
  customer_phone: string | null;
  customer_name: string | null;
}

export interface ComunicacaoData {
  kpis: Record<ComunicacaoTab, KpiSet>;
  daily: DailyEnvio[];
  byKind: KindBucket[];
  recentFailures: RecentFailure[];
}

// ── Constantes ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<NotificationKind, string> = {
  confirmation: "Confirmação WhatsApp",
  confirmation_email: "Confirmação e-mail",
  reminder_d1: "Lembrete D-1",
  survey_d1: "Pesquisa D+1",
  cancellation: "Cancelamento WhatsApp",
  waitlist_entered: "Fila — entrou",
  waitlist_table_ready: "Fila — mesa pronta",
  waitlist_feedback: "Fila — feedback",
};

const KIND_BY_TAB: Record<ComunicacaoTab, NotificationKind[]> = {
  geral: [
    "confirmation",
    "confirmation_email",
    "reminder_d1",
    "survey_d1",
    "cancellation",
    "waitlist_entered",
    "waitlist_table_ready",
    "waitlist_feedback",
  ],
  reserva: ["confirmation", "confirmation_email", "cancellation", "reminder_d1"],
  fila: ["waitlist_entered", "waitlist_table_ready", "waitlist_feedback"],
  avaliacao: ["survey_d1"],
};

const EMAIL_KINDS = new Set<NotificationKind>(["confirmation_email"]);

export function isEmailKind(kind: NotificationKind): boolean {
  return EMAIL_KINDS.has(kind);
}

export function kindLabel(kind: NotificationKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export function kindsForTab(tab: ComunicacaoTab): NotificationKind[] {
  return KIND_BY_TAB[tab];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    days.push(toIsoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function emptyKpi(): KpiSet {
  return {
    whatsapp: 0,
    email: 0,
    total: 0,
    failed: 0,
    skipped: 0,
    success_rate_pct: 0,
  };
}

interface Row {
  id: string;
  kind: NotificationKind;
  status: NotificationStatus;
  error: string | null;
  sent_at: string;
  customer:
    | { name: string | null; phone: string | null }
    | { name: string | null; phone: string | null }[]
    | null;
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${digits.slice(0, 2)}*****${digits.slice(-4)}`;
}

function customerOf(row: Row): { name: string | null; phone: string | null } | null {
  if (!row.customer) return null;
  if (Array.isArray(row.customer)) return row.customer[0] ?? null;
  return row.customer;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useComunicacao(unitId: string, range: DateRange) {
  const fromIso = toIsoDate(range.from);
  const toIso = toIsoDate(range.to);

  const query = useQuery({
    queryKey: ["comunicacao", unitId, fromIso, toIso],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const startTs = `${fromIso}T00:00:00.000Z`;
      const endTs = new Date(range.to);
      endTs.setHours(23, 59, 59, 999);
      const endTsIso = endTs.toISOString();

      const { data, error } = await supabase
        .from("notifications_sent")
        .select(
          "id, kind, status, error, sent_at, " +
            "reservation:reservations(customer:customers(name, phone))",
        )
        .eq("unit_id", unitId)
        .gte("sent_at", startTs)
        .lte("sent_at", endTsIso)
        .order("sent_at", { ascending: false });

      if (error) throw error;

      // Achata reservation.customer pra customer no nível da row
      type RawRow = {
        id: string;
        kind: NotificationKind;
        status: NotificationStatus;
        error: string | null;
        sent_at: string;
        reservation:
          | { customer: { name: string | null; phone: string | null } | null }
          | { customer: { name: string | null; phone: string | null } | null }[]
          | null;
      };

      return ((data ?? []) as unknown as RawRow[]).map((r) => {
        const reserv = Array.isArray(r.reservation)
          ? r.reservation[0]
          : r.reservation;
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          error: r.error,
          sent_at: r.sent_at,
          customer: reserv?.customer ?? null,
        } as Row;
      });
    },
    enabled: !!unitId,
  });

  const data = useMemo<ComunicacaoData>(() => {
    if (!query.data) {
      return {
        kpis: {
          geral: emptyKpi(),
          reserva: emptyKpi(),
          fila: emptyKpi(),
          avaliacao: emptyKpi(),
        },
        daily: [],
        byKind: [],
        recentFailures: [],
      };
    }

    const rows = query.data;

    // ── KPIs por tab ───────────────────────────────────────────────────────
    const kpis: Record<ComunicacaoTab, KpiSet> = {
      geral: emptyKpi(),
      reserva: emptyKpi(),
      fila: emptyKpi(),
      avaliacao: emptyKpi(),
    };

    const tabs: ComunicacaoTab[] = ["geral", "reserva", "fila", "avaliacao"];
    for (const r of rows) {
      for (const tab of tabs) {
        if (!KIND_BY_TAB[tab].includes(r.kind)) continue;
        const k = kpis[tab];
        if (r.status === "failed") k.failed += 1;
        if (r.status === "skipped") k.skipped += 1;
        if (r.status === "sent") {
          k.total += 1;
          if (isEmailKind(r.kind)) k.email += 1;
          else k.whatsapp += 1;
        }
      }
    }
    for (const tab of tabs) {
      const k = kpis[tab];
      const denom = k.total + k.failed;
      k.success_rate_pct = denom > 0 ? (k.total / denom) * 100 : 0;
    }

    // ── Daily ──────────────────────────────────────────────────────────────
    const days = eachDay(range.from, range.to);
    const daily: DailyEnvio[] = days.map((d) => ({
      date: d,
      label: d.slice(8, 10) + "/" + d.slice(5, 7),
      whatsapp: 0,
      email: 0,
      total: 0,
    }));
    const dailyMap = Object.fromEntries(daily.map((d) => [d.date, d]));
    for (const r of rows) {
      if (r.status !== "sent") continue;
      const day = r.sent_at.slice(0, 10);
      const entry = dailyMap[day];
      if (!entry) continue;
      if (isEmailKind(r.kind)) entry.email += 1;
      else entry.whatsapp += 1;
      entry.total += 1;
    }

    // ── byKind ─────────────────────────────────────────────────────────────
    const kindMap = new Map<NotificationKind, KindBucket>();
    for (const r of rows) {
      if (!kindMap.has(r.kind)) {
        kindMap.set(r.kind, {
          kind: r.kind,
          label: kindLabel(r.kind),
          sent: 0,
          failed: 0,
          skipped: 0,
        });
      }
      const b = kindMap.get(r.kind)!;
      if (r.status === "sent") b.sent += 1;
      else if (r.status === "failed") b.failed += 1;
      else if (r.status === "skipped") b.skipped += 1;
    }
    const byKind = Array.from(kindMap.values()).sort(
      (a, b) =>
        b.sent + b.failed + b.skipped - (a.sent + a.failed + a.skipped),
    );

    // ── Recent failures ────────────────────────────────────────────────────
    const recentFailures: RecentFailure[] = rows
      .filter((r) => r.status === "failed")
      .slice(0, 20)
      .map((r) => {
        const cust = customerOf(r);
        return {
          id: r.id,
          kind: r.kind,
          error: r.error,
          sent_at: r.sent_at,
          customer_phone: maskPhone(cust?.phone ?? null),
          customer_name: cust?.name ?? null,
        };
      });

    return { kpis, daily, byKind, recentFailures };
  }, [query.data, range.from, range.to]);

  return {
    data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

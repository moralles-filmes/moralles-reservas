import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { isoToLocalDate } from "@/lib/utils";
import type { DateRange } from "@/hooks/useFluxoClientes";
import type { VoucherStatus, VoucherTrigger } from "@/hooks/useVouchers";

export interface GiftbackKpis {
  total_issued: number;
  total_used: number;
  total_expired: number;
  total_cancelled: number;
  total_active: number;
  /** total_used / total_issued. null quando nenhum voucher foi emitido. */
  conversion_pct: number | null;
}

export interface DailyGiftback {
  date: string;
  label: string;
  issued: number;
  used: number;
}

// Tipo do bucket: 'manual_avulso' unifica registros sem rule (rule_id=null)
// E rules com trigger_type='manual' — semanticamente "emissão manual fora
// de gatilho automático". Antes apareciam como 2 fatias separadas no gráfico
// (legacy trigger_type='manual' não é mais selecionável na UI).
export interface TriggerBucket {
  trigger: Exclude<VoucherTrigger, "manual"> | "manual_avulso";
  label: string;
  count: number;
}

export interface RecentVoucher {
  id: string;
  code: string;
  status: VoucherStatus;
  discount_percent: number;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  trigger: VoucherTrigger | null;
}

export interface GiftbackData {
  kpis: GiftbackKpis;
  daily: DailyGiftback[];
  byTrigger: TriggerBucket[];
  recent: RecentVoucher[];
}

const TRIGGER_LABEL: Record<TriggerBucket["trigger"], string> = {
  after_rating: "Após avaliação",
  birthday: "Aniversário",
  frequency: "Frequência",
  manual_avulso: "Manual",
};

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

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

interface RawRow {
  id: string;
  code: string;
  status: VoucherStatus;
  discount_percent: number;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  rule_id: string | null;
  customer:
    | { name: string | null; phone: string | null }
    | { name: string | null; phone: string | null }[]
    | null;
  rule:
    | { trigger_type: VoucherTrigger }
    | { trigger_type: VoucherTrigger }[]
    | null;
}

function customerOf(row: RawRow) {
  if (!row.customer) return null;
  if (Array.isArray(row.customer)) return row.customer[0] ?? null;
  return row.customer;
}

function ruleOf(row: RawRow) {
  if (!row.rule) return null;
  if (Array.isArray(row.rule)) return row.rule[0] ?? null;
  return row.rule;
}

export function useGiftbackRelatorio(unitId: string, range: DateRange) {
  const fromIso = toIsoDate(range.from);
  const toIso = toIsoDate(range.to);

  return useQuery({
    queryKey: ["giftback-relatorio", unitId, fromIso, toIso],
    placeholderData: keepPreviousData,
    enabled: !!unitId,
    queryFn: async (): Promise<GiftbackData> => {
      // Boundaries em fuso local — alinhados com isoToLocalDate() abaixo. Antes
      // o startTs usava 'T00:00:00.000Z' (UTC puro) enquanto endTs convertia
      // do local → vazava 3h do dia anterior em BRT e excluía 3h do último.
      const startDate = new Date(range.from);
      startDate.setHours(0, 0, 0, 0);
      const startTs = startDate.toISOString();
      const endDate = new Date(range.to);
      endDate.setHours(23, 59, 59, 999);
      const endTs = endDate.toISOString();

      // Limit defensivo (B15): unit com volume alto pode passar 5000 vouchers/range.
      // Caso atinja, exibe truncado — relatório deveria migrar pra RPC agregada.
      const { data, error } = await supabase
        .from("vouchers")
        .select(
          "id, code, status, discount_percent, issued_at, expires_at, used_at, rule_id, customer:customers(name, phone), rule:voucher_rules(trigger_type)",
        )
        .eq("unit_id", unitId)
        .gte("issued_at", startTs)
        .lte("issued_at", endTs)
        .order("issued_at", { ascending: false })
        .limit(5000);

      if (error) throw error;

      const rows = (data ?? []) as unknown as RawRow[];

      // KPIs
      const kpis: GiftbackKpis = {
        total_issued: rows.length,
        total_used: rows.filter((r) => r.status === "used").length,
        total_expired: rows.filter((r) => r.status === "expired").length,
        total_cancelled: rows.filter((r) => r.status === "cancelled").length,
        total_active: rows.filter((r) => r.status === "active").length,
        conversion_pct: null,
      };
      kpis.conversion_pct =
        kpis.total_issued > 0
          ? (kpis.total_used / kpis.total_issued) * 100
          : null;

      // Daily
      const days = eachDay(range.from, range.to);
      const daily = days.map((date) => ({
        date,
        label: dayLabel(date),
        issued: 0,
        used: 0,
      }));
      const dailyByDate = new Map(daily.map((d) => [d.date, d]));

      for (const r of rows) {
        // issued_at e used_at são timestamptz UTC — converte pro dia local
        // do restaurante para evitar bug de fuso em eventos próximos da meia-noite.
        const issuedDay = isoToLocalDate(r.issued_at);
        const issuedSlot = dailyByDate.get(issuedDay);
        if (issuedSlot) issuedSlot.issued += 1;

        if (r.used_at) {
          const usedDay = isoToLocalDate(r.used_at);
          const usedSlot = dailyByDate.get(usedDay);
          if (usedSlot) usedSlot.used += 1;
        }
      }

      // Por gatilho — rule_id null OU rule.trigger_type='manual' (legado) unificam
      // como manual_avulso. UI nunca expõe 'manual' como gatilho selecionável.
      const triggerCounts = new Map<TriggerBucket["trigger"], number>();
      for (const r of rows) {
        const rule = ruleOf(r);
        const trig = rule?.trigger_type;
        const key: TriggerBucket["trigger"] =
          trig === "after_rating" || trig === "birthday" || trig === "frequency"
            ? trig
            : "manual_avulso";
        triggerCounts.set(key, (triggerCounts.get(key) ?? 0) + 1);
      }

      const byTrigger: TriggerBucket[] = (
        ["after_rating", "birthday", "frequency", "manual_avulso"] as TriggerBucket["trigger"][]
      )
        .filter((t) => (triggerCounts.get(t) ?? 0) > 0)
        .map((t) => ({
          trigger: t,
          label: TRIGGER_LABEL[t],
          count: triggerCounts.get(t) ?? 0,
        }));

      // Recent (top 20)
      const recent: RecentVoucher[] = rows.slice(0, 20).map((r) => {
        const customer = customerOf(r);
        const rule = ruleOf(r);
        return {
          id: r.id,
          code: r.code,
          status: r.status,
          discount_percent: r.discount_percent,
          issued_at: r.issued_at,
          expires_at: r.expires_at,
          used_at: r.used_at,
          customer_name: customer?.name ?? null,
          customer_phone: customer?.phone ?? null,
          trigger: rule?.trigger_type ?? null,
        };
      });

      return { kpis, daily, byTrigger, recent };
    },
  });
}

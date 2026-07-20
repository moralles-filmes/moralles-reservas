// Núcleo PURO da inadimplência (Fase 4b). ZERO imports — importável por vitest a
// partir de src/ (mesmo padrão de _shared/entitlements-core.ts). Deno roda em UTC:
// toda conta de "dia" passa por BRT aqui.

export const GRACE_PERIOD_DAYS = 5;
export const BLOCK_AFTER_DAYS = 6;

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** "Hoje" no fuso BRT como YYYY-MM-DD. Passe nowMs fixo nos testes. */
export function todayBrt(nowMs: number = Date.now()): string {
  return new Date(nowMs - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Soma `days` a uma data YYYY-MM-DD, ancorada ao meio-dia UTC (não cruza fuso). */
export function addDaysToDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dias de atraso de `dueDate` até `today` (YYYY-MM-DD). Positivo = vencida. */
export function daysOverdue(dueDate: string, today: string): number {
  const due = new Date(dueDate + "T12:00:00Z").getTime();
  const now = new Date(today + "T12:00:00Z").getTime();
  return Math.round((now - due) / DAY_MS);
}

export type DelinquencyStatus = "grace_period" | "blocked";

/** billing_status alvo pela idade do atraso. null = não vencida (nada a fazer). */
export function decideDelinquencyStatus(
  dueDate: string,
  today: string,
): DelinquencyStatus | null {
  const overdue = daysOverdue(dueDate, today);
  if (overdue < 1) return null;
  return overdue >= BLOCK_AFTER_DAYS ? "blocked" : "grace_period";
}

/** Puro: preferência billing_email -> owner -> null. */
export function pickRecipient(
  billingEmail?: string | null,
  ownerEmail?: string | null,
): string | null {
  const be = (billingEmail ?? "").trim();
  if (be) return be;
  const oe = (ownerEmail ?? "").trim();
  if (oe) return oe;
  return null;
}

export type ReminderOffset = { days: number; type: string };

/** Offsets de lembrete relativos ao due_date. D0 = "vence hoje"; D+1/3/5 = atraso. */
export const REMINDER_OFFSETS: ReminderOffset[] = [
  { days: 0, type: "payment_pending" },
  { days: 1, type: "overdue_d1" },
  { days: 3, type: "overdue_d3" },
  { days: 5, type: "overdue_d5" },
];

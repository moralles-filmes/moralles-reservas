// Datas no dia civil de Brasília (UTC-3 fixo; o Brasil não tem horário de verão
// desde 2019). Deno roda em UTC: "hoje" lido com getDate()/toISOString() cru
// vira o dia seguinte das 21h à meia-noite BRT. Funções puras; passe nowMs fixo
// nos testes.

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** "Hoje" em BRT como YYYY-MM-DD. */
export function todayBrtIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Dias de calendário de `fromIso` até `toIso` (YYYY-MM-DD). Positivo = futuro. */
export function calendarDayDiff(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T12:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T12:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

/**
 * Distância em dias, no calendário BRT, até o próximo aniversário de
 * `birthdayIso` (YYYY-MM-DD; só mês e dia contam). 0 = hoje. Quem nasceu em
 * 29/02 faz aniversário em 28/02 nos anos não-bissextos — mesma regra do cron
 * process-voucher-triggers (B11), para o agente e o voucher concordarem.
 */
export function daysUntilBirthdayBrt(birthdayIso: string, nowMs: number = Date.now()): number | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(birthdayIso));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const today = todayBrtIso(nowMs);
  const year = Number(today.slice(0, 4));
  const todayNoon = Date.parse(`${today}T12:00:00Z`);
  const birthdayIn = (y: number) => {
    const d = month === 2 && day === 29 && !isLeapYear(y) ? 28 : day;
    return Date.UTC(y, month - 1, d, 12);
  };
  let target = birthdayIn(year);
  if (target < todayNoon) target = birthdayIn(year + 1);
  return Math.round((target - todayNoon) / DAY_MS);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Instante (ISO UTC) de 1º de janeiro, 00:00 BRT, do ano civil BRT corrente.
 * Corte da idempotência do voucher de aniversário: no máximo 1 por regra e
 * cliente por ano civil. "Últimos 365 dias" pulava o aniversário quando a
 * rodada do ano anterior emitiu alguns minutos mais tarde (ou em ano bissexto).
 */
export function brtYearStartInstantIso(nowMs: number = Date.now()): string {
  const year = todayBrtIso(nowMs).slice(0, 4);
  return `${year}-01-01T03:00:00.000Z`;
}

/** YYYY-MM-DD do dia civil BRT `days` dias depois de hoje (negativo = antes). */
export function addDaysBrtIso(days: number, nowMs: number = Date.now()): string {
  const d = new Date(nowMs - BRT_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dia civil BRT (YYYY-MM-DD) de um instante em segundos Unix (ex.: `due_date` do Stripe). */
export function unixSecondsToBrtDate(seconds: number): string {
  return todayBrtIso(seconds * 1000);
}

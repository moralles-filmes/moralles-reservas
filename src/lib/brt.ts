// Helpers de data em horário de Brasília (America/Sao_Paulo), independentes do fuso do navegador.

const brtFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function brtParts(iso: string): { date: string; hour: number } {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return { date: iso.slice(0, 10), hour: 0 };
  const p: Record<string, string> = {};
  for (const part of brtFormatter.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** YYYY-MM-DD do instante em BRT. */
export function brtDateOf(iso: string): string {
  return brtParts(iso).date;
}

/** Hora (0–23) do instante em BRT. */
export function brtHourOf(iso: string): number {
  return brtParts(iso).hour;
}

/** Dia da semana em BRT: 0 = Domingo … 6 = Sábado. */
export function brtDowOf(iso: string): number {
  return new Date(`${brtDateOf(iso)}T12:00:00Z`).getUTCDay();
}

/** YYYY-MM-DD pelos getters locais: o dia civil que o usuário escolheu no picker. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Soma dias a uma chave YYYY-MM-DD (aritmética UTC ao meio-dia, sem borda de fuso). */
export function addDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dias civis de fromKey a toKey, inclusive. */
export function eachDateKey(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let cur = fromKey;
  while (cur <= toKey) {
    out.push(cur);
    cur = addDaysKey(cur, 1);
  }
  return out;
}

export function daysBetweenInclusive(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T12:00:00Z`);
  const b = Date.parse(`${toKey}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Limites do período em BRT: [startIso, endIsoExclusive). */
export function brtDayBounds(
  fromKey: string,
  toKey: string,
): { startIso: string; endIsoExclusive: string } {
  return {
    startIso: `${fromKey}T00:00:00-03:00`,
    endIsoExclusive: `${addDaysKey(toKey, 1)}T00:00:00-03:00`,
  };
}

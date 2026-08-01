// Núcleo puro (Fase 6b): aritmética do calendário do FORNECEDOR.
//
// ZERO IMPORTS — importado por Edge Function (Deno) e por vitest a partir de
// src/. Um único import de esm.sh, mesmo `import type`, quebra a resolução do
// Vite e derruba a suíte inteira.
//
// Não lê relógio. A data civil de referência entra SEMPRE por parâmetro, já
// resolvida em BRT pelo caller via todayBrt() de billing-delinquency-core.ts.

export type IsoDate = string; // "YYYY-MM-DD"

function parts(iso: IsoDate): { y: number; m: number; d: number } {
  return {
    y: Number(iso.slice(0, 4)),
    m: Number(iso.slice(5, 7)),
    d: Number(iso.slice(8, 10)),
  };
}

function fmt(y: number, m: number, d: number): IsoDate {
  const mm = m < 10 ? `0${m}` : `${m}`;
  const dd = d < 10 ? `0${d}` : `${d}`;
  return `${y}-${mm}-${dd}`;
}

export function daysInMonth(year: number, month1: number): number {
  // Dia 0 do mês seguinte = último dia deste mês. Date.UTC evita fuso.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Dia-âncora ajustado ao mês, sem NUNCA sobrescrever a âncora original. */
export function clampDayToMonth(year: number, month1: number, day: number): number {
  const max = daysInMonth(year, month1);
  return day > max ? max : day;
}

/**
 * Próximo vencimento: avança UM mês a partir de `fromIso` e aplica a âncora
 * com clamp. A âncora vem da instância (persistida), nunca do dia de `fromIso`
 * — é o que faz 31/01 → 28/02 → 31/03 em vez de degradar para 28 pra sempre.
 */
export function nextDueFromAnchor(fromIso: IsoDate, anchorDay: number): IsoDate {
  const { y, m } = parts(fromIso);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return fmt(ny, nm, clampDayToMonth(ny, nm, anchorDay));
}

/**
 * O ciclo cobre [cycle_start, provider_due_on) — fim EXCLUSIVO. Por isso `>=`
 * e não `>`: com `>` a rolagem sairia um dia atrasada.
 */
export function isCycleDue(providerDueOn: IsoDate, todayIso: IsoDate): boolean {
  return todayIso >= providerDueOn;
}

/** Dias civis até o alvo. Positivo = futuro, 0 = hoje, negativo = passado. */
export function daysUntil(targetIso: IsoDate, todayIso: IsoDate): number {
  const t = parts(targetIso);
  const n = parts(todayIso);
  const ms = Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(n.y, n.m - 1, n.d);
  return Math.round(ms / 86400000);
}

/** Próximo ciclo. `cycleStart` do novo == `providerDueOn` do anterior (§6.1). */
export function nextCycleFrom(
  providerDueOn: IsoDate,
  anchorDay: number,
): { cycleStart: IsoDate; providerDueOn: IsoDate } {
  return {
    cycleStart: providerDueOn,
    providerDueOn: nextDueFromAnchor(providerDueOn, anchorDay),
  };
}

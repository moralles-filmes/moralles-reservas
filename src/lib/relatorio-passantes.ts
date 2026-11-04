// Cálculo puro do relatório de passantes (uma linha de walk_ins = um grupo).
// Definições: docs/superpowers/specs/2026-11-04-relatorio-passantes-design.md.

import { brtDateOf, brtDowOf, brtHourOf, daysBetweenInclusive, eachDateKey } from "@/lib/brt";

// ── Buckets de tamanho de grupo (compartilhados com useFluxoClientes) ─────────

export function bucketFor(partySize: number): string {
  if (partySize <= 2) return "01-02";
  if (partySize <= 4) return "03-04";
  if (partySize <= 6) return "05-06";
  if (partySize <= 8) return "07-08";
  if (partySize <= 10) return "09-10";
  if (partySize <= 12) return "11-12";
  if (partySize <= 16) return "13-16";
  if (partySize <= 19) return "17-19";
  return "20+";
}

export const ALL_BUCKETS = [
  "01-02",
  "03-04",
  "05-06",
  "07-08",
  "09-10",
  "11-12",
  "13-16",
  "17-19",
  "20+",
];

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Espera de até este valor conta como "sentou direto". */
export const DIRECT_SEAT_MAX_SEC = 60;

export interface PassanteRow {
  id: string;
  party_size: number;
  status: "waiting" | "seated" | "left" | "no_show";
  arrived_at: string;
  seated_at: string | null;
  released_at: string | null;
  table_id: string | null;
}

export interface PassanteInput {
  walkIns: PassanteRow[];
  tables: { id: string; number: number; hall_id: string }[];
  halls: { id: string; name: string }[];
  fromKey: string;
  toKey: string;
  ticketCents: number;
}

export interface PassanteKpis {
  groups: number;
  people: number;
  /** pessoas / grupos (todos os grupos do período); null sem grupos. */
  avgPartySize: number | null;
  seatedGroups: number;
  seatedPeople: number;
  /** Sentados com table_id nulo. */
  seatedWithoutTable: number;
  /** status waiting e seated_at nulo (sem desfecho; fora das taxas). */
  waitingGroups: number;
  /** status left/no_show com seated_at nulo. */
  abandonedGroups: number;
  /** abandonados / (sentados + abandonados) × 100; null se denominador 0. */
  abandonRatePct: number | null;
  /** Segundos; só sentados que esperaram > 60 s. null sem amostra. */
  avgWaitSec: number | null;
  medianWaitSec: number | null;
  waitSampleSize: number;
  /** Sentados com espera <= 60 s. */
  directSeatedGroups: number;
  /** % dos sentados; null sem sentados. */
  directSeatedPct: number | null;
  /** Segundos; released_at − seated_at > 0. null sem amostra. */
  avgTableSec: number | null;
  medianTableSec: number | null;
  /** Sentados com tempo na mesa válido (numerador da cobertura). */
  releasedGroups: number;
  /** Denominador da cobertura (= sentados). */
  tableCoverageDenominator: number;
  revenueCents: number;
}

export interface PassanteDaily {
  date: string;
  label: string;
  groups: number;
  people: number;
  seatedGroups: number;
  seatedPeople: number;
}

export interface PassanteHour {
  hour: number;
  groups: number;
  people: number;
}

export interface PassanteDow {
  /** 0 = Dom … 6 = Sáb. */
  dow: number;
  label: string;
  groups: number;
  people: number;
}

export interface PassanteHeatRow {
  dow: number;
  label: string;
  /** 24 posições: grupos por hora de chegada. */
  hours: number[];
}

export interface PassantePartySize {
  bucket: string;
  groups: number;
  people: number;
  seatedGroups: number;
  avgTableSec: number | null;
}

export interface PassantePlaceStat {
  /** null = "Sem salão" / "Sem mesa". */
  id: string | null;
  name: string;
  /** Grupos sentados e pessoas sentadas. */
  groups: number;
  people: number;
  avgTableSec: number | null;
  /** grupos sentados ÷ dias do período. */
  turnover: number;
}

export interface PassantesReport {
  kpis: PassanteKpis;
  daily: PassanteDaily[];
  byHour: PassanteHour[];
  /** Seg..Dom. */
  byDow: PassanteDow[];
  /** Seg..Dom × 24h. */
  heatmap: PassanteHeatRow[];
  heatmapMax: number;
  byPartySize: PassantePartySize[];
  byHall: PassantePlaceStat[];
  byTable: PassantePlaceStat[];
  periodDays: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOW_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const NO_HALL = "Sem salão";
const NO_TABLE = "Sem mesa";

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function waitSec(r: PassanteRow): number | null {
  if (!r.seated_at) return null;
  const v = (ms(r.seated_at) - ms(r.arrived_at)) / 1000;
  return Number.isFinite(v) ? v : null;
}

function tableSec(r: PassanteRow): number | null {
  if (!r.seated_at || !r.released_at) return null;
  const v = (ms(r.released_at) - ms(r.seated_at)) / 1000;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ── Cálculo ───────────────────────────────────────────────────────────────────

export function computePassantesReport(input: PassanteInput): PassantesReport {
  const { walkIns, tables, halls, fromKey, toKey, ticketCents } = input;
  const periodDays = Math.max(1, daysBetweenInclusive(fromKey, toKey));

  const seated = walkIns.filter((r) => r.seated_at != null);
  const abandoned = walkIns.filter(
    (r) => r.seated_at == null && (r.status === "left" || r.status === "no_show"),
  );
  const waiting = walkIns.filter((r) => r.seated_at == null && r.status === "waiting");

  const people = walkIns.reduce((a, r) => a + r.party_size, 0);
  const seatedPeople = seated.reduce((a, r) => a + r.party_size, 0);

  const waits = seated
    .map(waitSec)
    .filter((v): v is number => v != null && v > DIRECT_SEAT_MAX_SEC);
  const directSeated = seated.filter((r) => {
    const w = waitSec(r);
    return w != null && w <= DIRECT_SEAT_MAX_SEC;
  }).length;
  const tableTimes = seated.map(tableSec).filter((v): v is number => v != null);
  const abandonDenom = seated.length + abandoned.length;

  const kpis: PassanteKpis = {
    groups: walkIns.length,
    people,
    avgPartySize: walkIns.length ? people / walkIns.length : null,
    seatedGroups: seated.length,
    seatedPeople,
    seatedWithoutTable: seated.filter((r) => r.table_id == null).length,
    waitingGroups: waiting.length,
    abandonedGroups: abandoned.length,
    abandonRatePct: abandonDenom > 0 ? (abandoned.length / abandonDenom) * 100 : null,
    avgWaitSec: avg(waits),
    medianWaitSec: median(waits),
    waitSampleSize: waits.length,
    directSeatedGroups: directSeated,
    directSeatedPct: seated.length ? (directSeated / seated.length) * 100 : null,
    avgTableSec: avg(tableTimes),
    medianTableSec: median(tableTimes),
    releasedGroups: tableTimes.length,
    tableCoverageDenominator: seated.length,
    revenueCents: seatedPeople * ticketCents,
  };

  // Por dia (BRT): grupos/pessoas pela chegada; sentados pelo dia da chegada também.
  const daily: PassanteDaily[] = eachDateKey(fromKey, toKey).map((d) => ({
    date: d,
    label: d.slice(8, 10) + "/" + d.slice(5, 7),
    groups: 0,
    people: 0,
    seatedGroups: 0,
    seatedPeople: 0,
  }));
  const dailyMap = new Map(daily.map((d) => [d.date, d]));

  const byHour: PassanteHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    groups: 0,
    people: 0,
  }));
  const dowAcc = Array.from({ length: 7 }, (_, dow) => ({
    dow,
    label: DOW_LABELS[dow],
    groups: 0,
    people: 0,
  }));
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

  for (const r of walkIns) {
    const isSeated = r.seated_at != null;
    const day = dailyMap.get(brtDateOf(r.arrived_at));
    if (day) {
      day.groups += 1;
      day.people += r.party_size;
      if (isSeated) {
        day.seatedGroups += 1;
        day.seatedPeople += r.party_size;
      }
    }
    const h = brtHourOf(r.arrived_at);
    const d = brtDowOf(r.arrived_at);
    byHour[h].groups += 1;
    byHour[h].people += r.party_size;
    dowAcc[d].groups += 1;
    dowAcc[d].people += r.party_size;
    heat[d][h] += 1;
  }

  const heatmap: PassanteHeatRow[] = DOW_ORDER.map((dow) => ({
    dow,
    label: DOW_LABELS[dow],
    hours: heat[dow],
  }));
  const heatmapMax = heatmap.reduce((m, row) => Math.max(m, ...row.hours), 0);

  // Tamanho de grupo.
  const byPartySize: PassantePartySize[] = ALL_BUCKETS.map((bucket) => {
    const rows = walkIns.filter((r) => bucketFor(r.party_size) === bucket);
    const seatedRows = rows.filter((r) => r.seated_at != null);
    return {
      bucket,
      groups: rows.length,
      people: rows.reduce((a, r) => a + r.party_size, 0),
      seatedGroups: seatedRows.length,
      avgTableSec: avg(seatedRows.map(tableSec).filter((v): v is number => v != null)),
    };
  }).filter((b) => b.groups > 0);

  // Salão e mesa (só sentados têm mesa).
  const tableById = new Map(tables.map((t) => [t.id, t]));
  const hallById = new Map(halls.map((h) => [h.id, h]));

  interface Acc {
    id: string | null;
    name: string;
    groups: number;
    people: number;
    times: number[];
  }
  const hallAcc = new Map<string | null, Acc>();
  const tableAcc = new Map<string | null, Acc>();
  const bump = (m: Map<string | null, Acc>, id: string | null, name: string, r: PassanteRow) => {
    let a = m.get(id);
    if (!a) {
      a = { id, name, groups: 0, people: 0, times: [] };
      m.set(id, a);
    }
    a.groups += 1;
    a.people += r.party_size;
    const t = tableSec(r);
    if (t != null) a.times.push(t);
  };
  for (const r of seated) {
    const table = r.table_id ? tableById.get(r.table_id) : undefined;
    if (!table) {
      bump(hallAcc, null, NO_HALL, r);
      bump(tableAcc, null, NO_TABLE, r);
      continue;
    }
    const hall = hallById.get(table.hall_id);
    bump(hallAcc, hall ? hall.id : null, hall ? hall.name : NO_HALL, r);
    bump(tableAcc, table.id, `Mesa ${table.number}`, r);
  }
  const finish = (m: Map<string | null, Acc>): PassantePlaceStat[] =>
    [...m.values()]
      .map((a) => ({
        id: a.id,
        name: a.name,
        groups: a.groups,
        people: a.people,
        avgTableSec: avg(a.times),
        turnover: a.groups / periodDays,
      }))
      .sort((a, b) => b.groups - a.groups || a.name.localeCompare(b.name, "pt-BR", { numeric: true }));

  return {
    kpis,
    daily,
    byHour,
    byDow: DOW_ORDER.map((d) => dowAcc[d]),
    heatmap,
    heatmapMax,
    byPartySize,
    byHall: finish(hallAcc),
    byTable: finish(tableAcc),
    periodDays,
  };
}

// ── Comparação ────────────────────────────────────────────────────────────────

export interface KpiDelta {
  current: number | null;
  previous: number | null;
  /** % de variação, ou pontos percentuais quando `unit` = "pp". null sem base. */
  delta: number | null;
  unit: "pct" | "pp";
}

export interface PassantesComparison {
  groups: KpiDelta;
  people: KpiDelta;
  avgPartySize: KpiDelta;
  seatedGroups: KpiDelta;
  avgTableSec: KpiDelta;
  avgWaitSec: KpiDelta;
  directSeatedPct: KpiDelta;
  abandonRatePct: KpiDelta;
  revenueCents: KpiDelta;
}

function pctDelta(cur: number | null, prev: number | null): KpiDelta {
  const ok = cur != null && prev != null && prev !== 0;
  return { current: cur, previous: prev, delta: ok ? ((cur - prev) / prev) * 100 : null, unit: "pct" };
}

function ppDelta(cur: number | null, prev: number | null): KpiDelta {
  const ok = cur != null && prev != null;
  return { current: cur, previous: prev, delta: ok ? cur - prev : null, unit: "pp" };
}

export function comparePassantes(
  current: PassantesReport,
  previous: PassantesReport,
): PassantesComparison {
  const c = current.kpis;
  const p = previous.kpis;
  return {
    groups: pctDelta(c.groups, p.groups),
    people: pctDelta(c.people, p.people),
    avgPartySize: pctDelta(c.avgPartySize, p.avgPartySize),
    seatedGroups: pctDelta(c.seatedGroups, p.seatedGroups),
    avgTableSec: pctDelta(c.avgTableSec, p.avgTableSec),
    avgWaitSec: pctDelta(c.avgWaitSec, p.avgWaitSec),
    directSeatedPct: ppDelta(c.directSeatedPct, p.directSeatedPct),
    abandonRatePct: ppDelta(c.abandonRatePct, p.abandonRatePct),
    revenueCents: pctDelta(c.revenueCents, p.revenueCents),
  };
}

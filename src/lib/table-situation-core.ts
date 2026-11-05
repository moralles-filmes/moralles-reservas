import type { StatusTone } from "@/lib/status-tone";
import type { Mesa, OccupantTable, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";

export type TableSituation = "blocked" | "occupied" | "late" | "arriving" | "reserved" | "free";

/** Agora em BRT: data "YYYY-MM-DD" e minutos desde 00:00. */
export interface BrtNow {
  date: string;
  minutes: number;
  yesterday: string;
  tomorrow: string;
}

export interface Occupant {
  kind: "reservation" | "walk_in" | "waitlist";
  id: string;
  since: string;
  partySize: number;
}

export interface TableState {
  situation: TableSituation;
  occupant?: Occupant;
  /** Ocupada e since + durationMinutes < now. */
  overtime?: boolean;
  minutesLate?: number;
  minutesUntil?: number;
  /** late | arriving | reserved. */
  focusReservationId?: string;
  /** Próxima reserva de hoje ainda não chegada, para o painel. */
  nextReservationId?: string;
  /** Mesas do mesmo ocupante (ou da reserva em foco) quando são duas ou mais; a cena liga. */
  groupTableIds?: string[];
}

export interface BlockWindow {
  table_id: string | null;
  hall_id: string | null;
  blocked_from: string;
  blocked_to: string;
}

export interface SituationInput {
  tables: Array<Pick<Mesa, "id" | "hall_id">>;
  reservations: Array<
    Pick<Reserva, "id" | "table_id" | "date" | "time" | "status" | "party_size" | "arrived_at" | "released_at">
  >;
  walkIns: Array<Pick<WalkIn, "id" | "table_id" | "status" | "seated_at" | "party_size" | "released_at">>;
  waitlistSeated: Array<
    Pick<WaitlistEntry, "id" | "table_id" | "status" | "seated_at" | "party_size" | "released_at">
  >;
  blocks: BlockWindow[];
  now: Date;
  durationMinutes: number;
  /** Mesas de cada ocupante (`occupant_tables`). Ausente = cada ocupante só no `table_id`. */
  occupantTables?: OccupantTable[];
}

const ARRIVING_WINDOW_MIN = 15;

const brtFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function brtNow(now: Date): BrtNow {
  const p: Record<string, string> = {};
  for (const part of brtFormatter.formatToParts(now)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  // Ontem em BRT: meio-dia UTC da data de hoje menos 24h evita borda de fuso.
  const y = new Date(`${date}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return { date, minutes, yesterday: y.toISOString().slice(0, 10), tomorrow: t.toISOString().slice(0, 10) };
}

function toMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(":");
  return Number(h) * 60 + Number(m);
}

function ts(iso: string): number {
  return new Date(iso).getTime();
}

function isBlocked(table: { id: string; hall_id: string }, blocks: BlockWindow[], nowMs: number): boolean {
  return blocks.some((b) => {
    if (!(ts(b.blocked_from) <= nowMs && nowMs < ts(b.blocked_to))) return false;
    if (b.table_id != null) return b.table_id === table.id;
    if (b.hall_id != null) return b.hall_id === table.hall_id;
    return true;
  });
}

type OccupantKey = `${Occupant["kind"]}:${string}`;

function occupantKeyOf(row: OccupantTable): OccupantKey | null {
  if (row.reservation_id) return `reservation:${row.reservation_id}`;
  if (row.walk_in_id) return `walk_in:${row.walk_in_id}`;
  if (row.waitlist_id) return `waitlist:${row.waitlist_id}`;
  return null;
}

/** Ocupante → mesas, a partir de `occupant_tables`. */
function indexOccupantTables(rows: OccupantTable[] | undefined): Map<OccupantKey, string[]> | null {
  if (!rows) return null;
  const map = new Map<OccupantKey, string[]>();
  for (const row of rows) {
    const key = occupantKeyOf(row);
    if (!key) continue;
    const list = map.get(key);
    if (!list) map.set(key, [row.table_id]);
    else if (!list.includes(row.table_id)) list.push(row.table_id);
  }
  return map;
}

/** Mesas de um ocupante: as de `occupant_tables` quando houver linha, senão o `table_id` dele. */
function tablesOf(index: Map<OccupantKey, string[]> | null, key: OccupantKey, tableId: string | null | undefined): string[] {
  const rows = index?.get(key);
  if (rows?.length) return rows;
  return tableId ? [tableId] : [];
}

/** Mesas de uma reserva (junção inclusa); vazio quando ela não tem mesa. */
export function reservationTableIds(
  reservationId: string,
  input: Pick<SituationInput, "reservations" | "occupantTables">,
): string[] {
  const index = indexOccupantTables(input.occupantTables);
  const r = input.reservations.find((x) => x.id === reservationId);
  return tablesOf(index, `reservation:${reservationId}`, r?.table_id);
}

/**
 * Reserva de hoje ainda não chegada, a partir de 15 min antes do horário, com alguma das
 * suas mesas ocupada por OUTRO ocupante: a recepção resolve na chegada.
 */
export function tableInUse(
  r: Pick<Reserva, "id" | "date" | "time" | "status" | "arrived_at">,
  states: Map<string, TableState>,
  tableIds: string[],
  now: Date,
): boolean {
  if (r.status !== "pending" && r.status !== "confirmed") return false;
  if (r.arrived_at) return false;
  const brt = brtNow(now);
  if (r.date !== brt.date) return false;
  if (toMinutes(r.time) - brt.minutes > ARRIVING_WINDOW_MIN) return false;
  return tableIds.some((id) => {
    const st = states.get(id);
    if (st?.situation !== "occupied" || !st.occupant) return false;
    return !(st.occupant.kind === "reservation" && st.occupant.id === r.id);
  });
}

function pushTo<T>(map: Map<string, T[]>, key: string | null | undefined, value: T) {
  if (key == null) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Situação ao vivo de uma reserva para as listas (pílula ao lado do status gravado).
 * Só vale para `pending|confirmed`; as mesmas janelas de `deriveTableStates`.
 */
export function reservationLiveSituation(
  r: Pick<Reserva, "date" | "time" | "status" | "arrived_at" | "released_at">,
  now: Date,
  durationMinutes: number,
): { tone: StatusTone; label: string } | null {
  if (r.status !== "pending" && r.status !== "confirmed") return null;
  if (r.released_at) return null;

  const brt = brtNow(now);
  if (r.arrived_at) {
    // Mesma janela da planta e do "Liberar mesa": só hoje ou ontem (BRT). Chegada antiga
    // sem liberação não é mais "Sentada", e a lista não teria como liberá-la.
    if (r.date !== brt.date && r.date !== brt.yesterday) return null;
    // Mesma régua do `overtime` da planta: conta da chegada, não do horário reservado.
    const sinceMs = new Date(r.arrived_at).getTime();
    const over = Number.isFinite(sinceMs) && now.getTime() > sinceMs + durationMinutes * 60_000;
    return { tone: "seated", label: over ? "Sentada · passou do tempo" : "Sentada" };
  }

  if (r.date !== brt.date) return null;
  const diff = toMinutes(r.time) - brt.minutes;
  if (diff < 0) return { tone: "late", label: `Atrasada ${-diff} min` };
  if (r.status === "confirmed" && diff <= ARRIVING_WINDOW_MIN) {
    return { tone: "arriving", label: `Chega em ${diff} min` };
  }
  return null;
}

/** Só põe a chave quando há junção: sem `occupantTables` o estado fica idêntico ao de antes. */
function withGroup(ids: string[] | undefined): Pick<TableState, "groupTableIds"> {
  return ids ? { groupTableIds: ids } : {};
}

export function deriveTableStates(input: SituationInput): Map<string, TableState> {
  const { now, durationMinutes } = input;
  const nowMs = now.getTime();
  const brt = brtNow(now);

  const occupants = new Map<string, Occupant[]>();
  const pending = new Map<string, Array<{ id: string; minutes: number; confirmed: boolean }>>();
  const index = indexOccupantTables(input.occupantTables);
  /** Ocupante (ou reserva a chegar) → todas as suas mesas, para `groupTableIds`. */
  const groups = new Map<OccupantKey, string[]>();
  const place = <T,>(map: Map<string, T[]>, key: OccupantKey, tableId: string | null | undefined, value: T) => {
    const ids = tablesOf(index, key, tableId);
    if (ids.length > 1) groups.set(key, ids);
    for (const id of ids) pushTo(map, id, value);
  };
  const groupOf = (key: OccupantKey) => groups.get(key);

  // Passante/fila legados ficam `seated` sem `released_at` para sempre: só conta
  // quem sentou hoje ou ontem (BRT), a mesma janela das reservas.
  const inWindow = (iso: string) => {
    const d = brtNow(new Date(iso)).date;
    return d === brt.date || d === brt.yesterday;
  };

  for (const w of input.walkIns) {
    // Sentado sem `seated_at` não tem como datar: ignora.
    if (w.status !== "seated" || w.released_at || !w.seated_at || !inWindow(w.seated_at)) continue;
    place(occupants, `walk_in:${w.id}`, w.table_id, { kind: "walk_in", id: w.id, since: w.seated_at, partySize: w.party_size });
  }
  for (const f of input.waitlistSeated) {
    if (f.status !== "seated" || f.released_at || !f.seated_at || !inWindow(f.seated_at)) continue;
    place(occupants, `waitlist:${f.id}`, f.table_id, { kind: "waitlist", id: f.id, since: f.seated_at, partySize: f.party_size });
  }
  for (const r of input.reservations) {
    if (r.status !== "pending" && r.status !== "confirmed") continue;
    if (r.released_at) continue;
    if (r.arrived_at) {
      if (r.date !== brt.date && r.date !== brt.yesterday) continue;
      place(occupants, `reservation:${r.id}`, r.table_id, {
        kind: "reservation",
        id: r.id,
        since: r.arrived_at,
        partySize: r.party_size,
      });
    } else if (r.date === brt.date) {
      place(pending, `reservation:${r.id}`, r.table_id, {
        id: r.id,
        minutes: toMinutes(r.time),
        confirmed: r.status === "confirmed",
      });
    }
  }

  const result = new Map<string, TableState>();
  for (const table of input.tables) {
    const upcoming = (pending.get(table.id) ?? []).slice().sort((a, b) => a.minutes - b.minutes);
    const next = upcoming.find((u) => u.minutes >= brt.minutes);
    const nextReservationId = next?.id;

    if (isBlocked(table, input.blocks, nowMs)) {
      result.set(table.id, { situation: "blocked", nextReservationId });
      continue;
    }

    const occ = (occupants.get(table.id) ?? []).slice().sort((a, b) => ts(a.since) - ts(b.since))[0];
    if (occ) {
      result.set(table.id, {
        situation: "occupied",
        occupant: occ,
        overtime: ts(occ.since) + durationMinutes * 60_000 < nowMs,
        nextReservationId,
        ...withGroup(groupOf(`${occ.kind}:${occ.id}`)),
      });
      continue;
    }

    const late = upcoming.find((u) => u.minutes < brt.minutes);
    if (late) {
      result.set(table.id, {
        situation: "late",
        minutesLate: brt.minutes - late.minutes,
        focusReservationId: late.id,
        nextReservationId,
        ...withGroup(groupOf(`reservation:${late.id}`)),
      });
      continue;
    }

    if (next) {
      const until = next.minutes - brt.minutes;
      if (next.confirmed && until <= ARRIVING_WINDOW_MIN) {
        result.set(table.id, {
          situation: "arriving",
          minutesUntil: until,
          focusReservationId: next.id,
          nextReservationId,
          ...withGroup(groupOf(`reservation:${next.id}`)),
        });
      } else {
        result.set(table.id, {
          situation: "reserved",
          focusReservationId: next.id,
          nextReservationId,
          ...withGroup(groupOf(`reservation:${next.id}`)),
        });
      }
      continue;
    }

    result.set(table.id, { situation: "free" });
  }
  return result;
}

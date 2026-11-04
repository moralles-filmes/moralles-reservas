// Núcleo puro de escolha de mesa/combinação. Sem I/O: compatível com Deno e Vitest.

export interface SeatTable {
  id: string;
  number: number;
  minCapacity: number;
  maxCapacity: number;
  bookable: boolean;
  inCombination: boolean;
}
export interface SeatCombination {
  id: string;
  tableIds: string[];
  minCapacity: number;
  maxCapacity: number;
}
export type SeatChoice = { kind: "table"; id: string } | { kind: "combination"; id: string };
export interface SeatPick {
  tableIds: string[];
  combinationId: string | null;
}

export function fitsParty(
  min: number,
  max: number,
  partySize: number,
  allowEmptySeat: boolean,
): boolean {
  const lower = Math.max(1, allowEmptySeat ? min - 1 : min);
  return partySize >= lower && partySize <= max;
}

interface Args {
  tables: SeatTable[];
  combinations: SeatCombination[];
  occupied: ReadonlySet<string>;
  partySize: number;
  allowEmptySeat: boolean;
}

interface Candidate {
  choice: SeatChoice;
  tableIds: string[];
  available: boolean;
  minCapacity: number;
  maxCapacity: number;
  group: number;
  tieNumber: number;
  id: string;
}

// Todos os candidatos que cabem o grupo e são reserváveis, já ordenados.
function candidates(a: Args): Candidate[] {
  const byId = new Map(a.tables.map((t) => [t.id, t]));
  const out: Candidate[] = [];
  for (const t of a.tables) {
    if (t.bookable !== true) continue;
    if (!fitsParty(t.minCapacity, t.maxCapacity, a.partySize, a.allowEmptySeat)) continue;
    out.push({
      choice: { kind: "table", id: t.id },
      tableIds: [t.id],
      available: !a.occupied.has(t.id),
      minCapacity: t.minCapacity,
      maxCapacity: t.maxCapacity,
      group: t.inCombination ? 1 : 0,
      tieNumber: t.number,
      id: t.id,
    });
  }
  for (const c of a.combinations) {
    if (c.tableIds.length === 0) continue;
    if (!fitsParty(c.minCapacity, c.maxCapacity, a.partySize, a.allowEmptySeat)) continue;
    const members = c.tableIds.map((id) => byId.get(id));
    if (members.some((m) => !m || m.bookable !== true)) continue;
    out.push({
      choice: { kind: "combination", id: c.id },
      tableIds: [...c.tableIds],
      available: !c.tableIds.some((id) => a.occupied.has(id)),
      minCapacity: c.minCapacity,
      maxCapacity: c.maxCapacity,
      group: 2,
      tieNumber: Math.min(...members.map((m) => m!.number)),
      id: c.id,
    });
  }
  out.sort(
    (x, y) =>
      x.group - y.group ||
      x.maxCapacity - y.maxCapacity ||
      x.tieNumber - y.tieNumber ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return out;
}

function toPick(c: Candidate): SeatPick {
  return {
    tableIds: c.tableIds,
    combinationId: c.choice.kind === "combination" ? c.choice.id : null,
  };
}

export function pickSeat(
  args: Args & { choice?: SeatChoice | null; preferTableIds?: string[] | null },
): SeatPick | null {
  const usable = candidates(args).filter((c) => c.available);
  if (args.choice) {
    const ch = args.choice;
    const found = usable.find((c) => c.choice.kind === ch.kind && c.choice.id === ch.id);
    return found ? toPick(found) : null;
  }
  const pref = args.preferTableIds;
  if (pref && pref.length > 0) {
    const want = new Set(pref);
    const match = usable.find(
      (c) => c.tableIds.length === want.size && c.tableIds.every((id) => want.has(id)),
    );
    if (match) return toPick(match);
  }
  return usable.length > 0 ? toPick(usable[0]) : null;
}

export function seatOptions(args: Args): Array<{
  choice: SeatChoice;
  tableIds: string[];
  available: boolean;
  minCapacity: number;
  maxCapacity: number;
}> {
  return candidates(args).map((c) => ({
    choice: c.choice,
    tableIds: c.tableIds,
    available: c.available,
    minCapacity: c.minCapacity,
    maxCapacity: c.maxCapacity,
  }));
}

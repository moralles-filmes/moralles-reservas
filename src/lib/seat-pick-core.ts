import type { Mesa, OccupantKind, TableCombination } from "@/types/reserva";
import type { BlockWindow, TableState } from "./table-situation-core";

/** Ocupante (reserva, passante ou fila) que está sentado ou vai sentar. */
export type OccupantRef = { kind: OccupantKind; id: string };

/** Mesas que o ocupante pode receber e as combinações sugeridas (até três) para o grupo. */
export function validSeatTargets({
  mode,
  occupant,
  partySize,
  tables,
  states,
  combinations,
  blocks,
  now,
}: {
  mode: "move" | "join";
  occupant: OccupantRef;
  partySize: number;
  tables: Mesa[];
  states: Map<string, TableState>;
  combinations: TableCombination[];
  blocks: BlockWindow[];
  now: Date;
}): { selectable: Set<string>; suggested: string[][] } {
  const own = (s?: TableState) => s?.occupant?.kind === occupant.kind && s.occupant.id === occupant.id;
  const selectable = new Set(
    tables
      .filter(t => {
        const s = states.get(t.id);
        return (
          t.active &&
          s?.situation !== "blocked" &&
          (!s?.occupant || own(s)) &&
          !blocks.some(
            b =>
              new Date(b.blocked_from).getTime() <= now.getTime() &&
              now.getTime() < new Date(b.blocked_to).getTime() &&
              (b.table_id != null ? b.table_id === t.id : b.hall_id != null ? b.hall_id === t.hall_id : true),
          )
        );
      })
      .map(t => t.id),
  );
  if (mode === "join") return { selectable, suggested: [] };
  const singles = tables
    .filter(
      t =>
        selectable.has(t.id) &&
        (states.get(t.id)?.situation === "free" || own(states.get(t.id))) &&
        (t.max_capacity ?? t.capacity) >= partySize,
    )
    .sort((a, b) => (a.max_capacity ?? a.capacity) - (b.max_capacity ?? b.capacity))
    .map(t => [t.id]);
  const groups = combinations
    .filter(
      c =>
        c.active &&
        c.table_ids.length > 0 &&
        c.table_ids.every(id => selectable.has(id)) &&
        c.min_capacity <= partySize &&
        partySize <= c.max_capacity,
    )
    .sort((a, b) => a.max_capacity - b.max_capacity)
    .map(c => c.table_ids);
  return { selectable, suggested: [...singles, ...groups].slice(0, 3) };
}

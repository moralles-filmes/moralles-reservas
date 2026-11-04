import { cn } from "@/lib/utils";
import type { TableSituation } from "@/lib/table-situation-core";
import { SITUATION_LABEL, SITUATION_ORDER, SITUATION_TONE, TONE_CLASS } from "../situation-labels";

export function LegendaSituacoes({ counts }: { counts: Record<TableSituation, number> }) {
  return (
    <ul aria-label="Situação das mesas" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {SITUATION_ORDER.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", TONE_CLASS[SITUATION_TONE[s]].dot)} />
          <span>{SITUATION_LABEL[s]}</span>
          <span className="tabular-nums text-muted-foreground">{counts[s]}</span>
        </li>
      ))}
    </ul>
  );
}

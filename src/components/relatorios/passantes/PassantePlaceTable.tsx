import type { PassantePlaceStat } from "@/lib/relatorio-passantes";
import { formatDecimal, formatHM } from "./format";

export function PassantePlaceTable({
  rows,
  firstColumn,
}: {
  rows: PassantePlaceStat[];
  firstColumn: string;
}) {
  const sorted = [...rows].sort((a, b) => b.groups - a.groups);
  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">Sem dados no período.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="py-2 pr-3 font-medium">{firstColumn}</th>
            <th className="py-2 px-2 font-medium text-right">Grupos</th>
            <th className="py-2 px-2 font-medium text-right">Pessoas</th>
            <th className="py-2 px-2 font-medium text-right">Tempo médio na mesa</th>
            <th className="py-2 pl-2 font-medium text-right">Giro/dia</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id ?? r.name} className="border-b last:border-0">
              <td className="py-2 pr-3">{r.name}</td>
              <td className="py-2 px-2 text-right tabular">{r.groups}</td>
              <td className="py-2 px-2 text-right tabular">{r.people}</td>
              <td className="py-2 px-2 text-right tabular">{formatHM(r.avgTableSec)}</td>
              <td className="py-2 pl-2 text-right tabular">{formatDecimal(r.turnover, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

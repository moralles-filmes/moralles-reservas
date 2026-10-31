import { Button } from "@/components/ui/button";
import type { TableBox } from "@/lib/hall-plan-core";

interface Props {
  boxes: TableBox[];
  onPlace: (id: string) => void;
  readOnly?: boolean;
}

export function BandejaSemPosicao({ boxes, onPlace, readOnly = false }: Props) {
  const pending = boxes.filter((b) => !b.positioned);
  return (
    <section className="surface space-y-2 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Sem posição</h3>
      {pending.length === 0 ? (
        <p className="text-xs text-muted-foreground">Todas as mesas estão na planta.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {pending.map((b) => (
            <li key={b.tableId}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly}
                className="min-h-11 min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onPlace(b.tableId)}
              >
                {`Mesa ${b.number} · ${b.capacity} lugares`}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

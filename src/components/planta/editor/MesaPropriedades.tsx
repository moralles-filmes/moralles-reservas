import { Button } from "@/components/ui/button";
import { CampoNumero } from "./CampoNumero";
import { cn } from "@/lib/utils";
import type { PlanShape, TableBox } from "@/lib/hall-plan-core";

interface Props {
  box: TableBox | null;
  onChange: (patch: Partial<Pick<TableBox, "shape" | "w" | "h" | "rotation">>) => void;
  onRemove: () => void;
  readOnly?: boolean;
}

const SHAPES: Array<{ value: PlanShape; label: string }> = [
  { value: "round", label: "Redonda" },
  { value: "square", label: "Quadrada" },
  { value: "rect", label: "Retangular" },
];

export function MesaPropriedades({ box, onChange, onRemove, readOnly = false }: Props) {
  if (!box) {
    return (
      <section className="surface rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground">Selecione uma mesa para ajustar.</p>
      </section>
    );
  }


  return (
    <section className="surface space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">{`Mesa ${box.number}`}</h3>

      <div className="space-y-1">
        <span id="mesa-forma" className="text-sm font-medium">Forma</span>
        <div role="radiogroup" aria-labelledby="mesa-forma" className="flex gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={box.shape === s.value}
              disabled={readOnly}
              onClick={() => onChange({ shape: s.value })}
              className={cn(
                "min-h-11 min-w-11 flex-1 rounded-md border border-border px-2 text-xs",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                box.shape === s.value ? "bg-primary text-primary-foreground" : "bg-background",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CampoNumero id="mesa-w" label="Largura (cm)" value={box.w} min={30} max={600} disabled={readOnly} onCommit={(w) => onChange({ w })} />
        <CampoNumero id="mesa-h" label="Profundidade (cm)" value={box.h} min={30} max={600} disabled={readOnly} onCommit={(h) => onChange({ h })} />
      </div>

      <CampoNumero
        id="mesa-rot"
        label="Rotação (graus)"
        value={box.rotation}
        min={0}
        max={359}
        disabled={readOnly}
        onCommit={(rotation) => onChange({ rotation })}
      />

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={readOnly}
        onClick={onRemove}
      >
        Tirar da planta
      </Button>
    </section>
  );
}

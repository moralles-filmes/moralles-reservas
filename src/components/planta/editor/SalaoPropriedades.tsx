import { Label } from "@/components/ui/label";
import type { HallPlan, PlanWall } from "@/lib/hall-plan-core";
import { CampoNumero } from "./CampoNumero";

interface Props {
  plan: HallPlan;
  onChange: (next: HallPlan) => void;
  readOnly?: boolean;
}

const WALLS: Array<{ value: PlanWall; label: string }> = [
  { value: "top", label: "Cima" },
  { value: "right", label: "Direita" },
  { value: "bottom", label: "Baixo" },
  { value: "left", label: "Esquerda" },
];

const MIN_CM = 200;
// Faixa do CHECK halls_plan_dims; a entrada tem 90 cm (a mesma da lona).
const MAX_CM = 5000;
const ENTRANCE_CM = 90;

export function SalaoPropriedades({ plan, onChange, readOnly = false }: Props) {
  const wallLength = (wall: PlanWall, p: HallPlan) => (wall === "top" || wall === "bottom" ? p.widthCm : p.depthCm);
  const maxOffset = (wall: PlanWall, p: HallPlan) => Math.max(0, wallLength(wall, p) - ENTRANCE_CM);

  // Ao mudar o tamanho, a entrada continua dentro da parede.
  const resize = (next: HallPlan) =>
    onChange(
      next.entrance
        ? { ...next, entrance: { ...next.entrance, offsetCm: Math.min(next.entrance.offsetCm, maxOffset(next.entrance.wall, next)) } }
        : next,
    );

  const toggleWindow = (wall: PlanWall, on: boolean) => {
    const set = new Set(plan.windowWalls);
    if (on) set.add(wall);
    else set.delete(wall);
    onChange({ ...plan, windowWalls: WALLS.map((w) => w.value).filter((w) => set.has(w)) });
  };

  return (
    <section className="surface space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">Salão</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CampoNumero id="salao-w" label="Largura (cm)" value={plan.widthCm} min={MIN_CM} max={MAX_CM} disabled={readOnly} onCommit={(widthCm) => resize({ ...plan, widthCm })} />
        <CampoNumero id="salao-d" label="Profundidade (cm)" value={plan.depthCm} min={MIN_CM} max={MAX_CM} disabled={readOnly} onCommit={(depthCm) => resize({ ...plan, depthCm })} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="salao-entrada">Entrada</Label>
          <select
            id="salao-entrada"
            disabled={readOnly}
            value={plan.entrance?.wall ?? ""}
            onChange={(e) => {
              const wall = e.target.value as PlanWall | "";
              onChange({
                ...plan,
                entrance: wall === "" ? null : { wall, offsetCm: Math.min(plan.entrance?.offsetCm ?? 0, maxOffset(wall, plan)) },
              });
            }}
            className="h-10 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="">Nenhuma</option>
            {WALLS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <CampoNumero
          id="salao-offset"
          label="Deslocamento (cm)"
          value={plan.entrance?.offsetCm ?? 0}
          min={0}
          max={plan.entrance ? maxOffset(plan.entrance.wall, plan) : 0}
          disabled={readOnly || !plan.entrance}
          onCommit={(offsetCm) => plan.entrance && onChange({ ...plan, entrance: { ...plan.entrance, offsetCm } })}
        />
      </div>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Paredes com janela</legend>
        <div className="grid grid-cols-2 gap-1">
          {WALLS.map((w) => (
            <label key={w.value} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={readOnly}
                checked={plan.windowWalls.includes(w.value)}
                onChange={(e) => toggleWindow(w.value, e.target.checked)}
                className="h-4 w-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {w.label}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

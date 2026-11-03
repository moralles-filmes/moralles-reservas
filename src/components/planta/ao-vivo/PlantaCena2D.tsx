import type { HallPlan, TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";
import { WINDOW_STRIPES, entranceRect, wallRect } from "./scene-geometry";
import { useContainerWidth } from "./useContainerWidth";

export interface CenaProps {
  plan: HallPlan;
  boxes: TableBox[];
  states: Map<string, TableState>;
  timeLabels: Map<string, string>;
  selectedId: string | null;
  onSelect: (tableId: string) => void;
  now: Date;
}

const WALL_PX = 4;

/** Vista de cima, mesmas caixas da cena 3D. */
export function PlantaCena2D({ plan, boxes, states, timeLabels, selectedId, onSelect, now }: CenaProps) {
  const { ref, width } = useContainerWidth();
  const scale = width / plan.widthCm;
  const entrance = entranceRect(plan, scale, WALL_PX + 4);
  return (
    <div ref={ref} className="w-full">
      <div
        data-testid="planta-2d"
        className="surface relative w-full overflow-hidden rounded-lg"
        style={{ aspectRatio: `${plan.widthCm} / ${plan.depthCm}` }}
      >
        {plan.windowWalls.map((wall) => (
          <div
            key={wall}
            aria-hidden="true"
            className="absolute"
            style={{ ...wallRect(wall, WALL_PX), backgroundImage: WINDOW_STRIPES }}
          />
        ))}
        {entrance && <div aria-hidden="true" className="absolute rounded-sm bg-muted-foreground" style={entrance} />}
        {boxes.map((box) => (
          <MesaBotao
            key={box.tableId}
            variant="2d"
            box={box}
            state={states.get(box.tableId)}
            scale={scale}
            selected={box.tableId === selectedId}
            onSelect={onSelect}
            timeLabel={timeLabels.get(box.tableId)}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

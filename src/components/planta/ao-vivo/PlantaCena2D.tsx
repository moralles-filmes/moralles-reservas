import { useEffect, useRef, useState } from "react";
import { ENTRANCE_CM } from "@/lib/hall-plan-core";
import type { HallPlan, PlanWall, TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";

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

export const WINDOW_STRIPES =
  "repeating-linear-gradient(90deg, hsl(var(--primary)) 0 8px, transparent 8px 14px)";

export function wallRect(wall: PlanWall, thickness: number): React.CSSProperties {
  switch (wall) {
    case "top":
      return { top: 0, left: 0, right: 0, height: thickness };
    case "bottom":
      return { bottom: 0, left: 0, right: 0, height: thickness };
    case "left":
      return { left: 0, top: 0, bottom: 0, width: thickness };
    default:
      return { right: 0, top: 0, bottom: 0, width: thickness };
  }
}

export function entranceRect(plan: HallPlan, scale: number, thickness: number): React.CSSProperties | null {
  const e = plan.entrance;
  if (!e) return null;
  const horizontal = e.wall === "top" || e.wall === "bottom";
  return horizontal
    ? { [e.wall]: 0, left: e.offsetCm * scale, width: ENTRANCE_CM * scale, height: thickness }
    : { [e.wall]: 0, top: e.offsetCm * scale, height: ENTRANCE_CM * scale, width: thickness };
}

/** Largura útil do contêiner; jsdom não tem ResizeObserver, então cai num padrão. */
export function useContainerWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

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

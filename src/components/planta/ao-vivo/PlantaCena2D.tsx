import { useRef } from "react";
import type { HallPlan, TableBox } from "@/lib/hall-plan-core";
import { HALL_LABEL_CM } from "@/lib/hall-arrange-core";
import type { TableState } from "@/lib/table-situation-core";
import { cn } from "@/lib/utils";
import { PlanViewport } from "../viewport/PlanViewport";
import type { PlanViewportApi } from "../viewport/usePlanViewport";
import { MesaBotao } from "./MesaBotao";
import { WINDOW_STRIPES, entranceRect, wallRect } from "./scene-geometry";
import { useContainerWidth } from "./useContainerWidth";
import { useFocusTable } from "./useFocusTable";

export interface SceneHall {
  id: string;
  name: string;
  plan: HallPlan;
  boxes: TableBox[];
  /** Canto da planta dentro do layout, em cm. */
  xCm: number;
  yCm: number;
  /** Sem planta desenhada (grade automática). */
  undrawn: boolean;
}

export interface CenaProps {
  halls: SceneHall[];
  layout: { widthCm: number; depthCm: number };
  showLabels: boolean;
  states: Map<string, TableState>;
  timeLabels: Map<string, string>;
  selectedId: string | null;
  onSelect: (tableId: string) => void;
  now: Date;
  /** Quando muda, o viewport centraliza a mesa (medida pelo DOM; vale no 2D e no 3D). */
  focus?: { tableId: string; nonce: number };
  /** Altura máxima da cena (tela cheia); sem ela vale o limite padrão de cada vista. */
  maxHeightPx?: number;
}

const WALL_PX = 4;

function HallLabel2D({ hall, scale }: { hall: SceneHall; scale: number }) {
  return (
    <div
      className="absolute flex items-end whitespace-nowrap pb-1 text-sm font-semibold leading-none text-foreground"
      style={{ left: hall.xCm * scale, top: (hall.yCm - HALL_LABEL_CM) * scale, height: HALL_LABEL_CM * scale }}
    >
      <span>
        {hall.name}
        {hall.undrawn && <span className="font-normal text-muted-foreground">{" · grade automática"}</span>}
      </span>
    </div>
  );
}

/** Vista de cima, mesmas caixas da cena 3D. */
export function PlantaCena2D({
  halls,
  layout,
  showLabels,
  states,
  timeLabels,
  selectedId,
  onSelect,
  now,
  focus,
  maxHeightPx,
}: CenaProps) {
  const { ref, width: containerWidth } = useContainerWidth();
  const apiRef = useRef<PlanViewportApi | null>(null);
  useFocusTable(apiRef, focus);
  const width =
    maxHeightPx != null
      ? Math.max(1, Math.min(containerWidth, (maxHeightPx * layout.widthCm) / layout.depthCm))
      : containerWidth;
  const scale = width / layout.widthCm;
  return (
    <div ref={ref} className="w-full">
      <div className={maxHeightPx != null ? "mx-auto" : undefined} style={maxHeightPx != null ? { width } : undefined}>
      <PlanViewport
        data-testid="planta-2d"
        apiRef={apiRef}
        className={cn("w-full rounded-lg", !showLabels && "surface")}
        style={{ aspectRatio: `${layout.widthCm} / ${layout.depthCm}` }}
      >
        {halls.map((hall) => {
          const entrance = entranceRect(hall.plan, scale, WALL_PX + 4);
          return (
            <div key={hall.id}>
              {showLabels && <HallLabel2D hall={hall} scale={scale} />}
              <div
                data-testid={showLabels ? `salao-2d-${hall.id}` : undefined}
                className={cn("absolute", showLabels && "surface rounded-lg")}
                style={{
                  left: hall.xCm * scale,
                  top: hall.yCm * scale,
                  width: hall.plan.widthCm * scale,
                  height: hall.plan.depthCm * scale,
                }}
              >
                {hall.plan.windowWalls.map((wall) => (
                  <div
                    key={wall}
                    aria-hidden="true"
                    className="absolute"
                    style={{ ...wallRect(wall, WALL_PX), backgroundImage: WINDOW_STRIPES }}
                  />
                ))}
                {entrance && (
                  <div aria-hidden="true" className="absolute rounded-sm bg-muted-foreground" style={entrance} />
                )}
                {hall.boxes.map((box) => (
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
        })}
      </PlanViewport>
      </div>
    </div>
  );
}

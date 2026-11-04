import type { PlanWall } from "@/lib/hall-plan-core";
import { HALL_LABEL_CM } from "@/lib/hall-arrange-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";
import type { SceneHall } from "./PlantaCena2D";
import { SCENE_ROT_X, SCENE_ROT_Z, WINDOW_STRIPES, entranceRect, wallRect } from "./scene-geometry";

const WALL_PX = 6;
/** Acima da etiqueta da mesa (30 px): o nome do salão nunca fica atrás de uma mesa. */
const LABEL_RISE_PX = 40;
const WALL_RISE_PX = 18;
const RAISED: PlanWall[] = ["top", "right"];

interface Props {
  hall: SceneHall;
  /** cm → px. */
  scale: number;
  showLabel: boolean;
  states: Map<string, TableState>;
  timeLabels: Map<string, string>;
  selectedId: string | null;
  onSelect: (tableId: string) => void;
  now: Date;
}

/** Um salão dentro do plano girado: chão, paredes elevadas, janelas, entrada e mesas. */
export function SalaoPlano3D({ hall, scale, showLabel, states, timeLabels, selectedId, onSelect, now }: Props) {
  const { plan } = hall;
  const entrance = entranceRect(plan, scale, WALL_PX + 2);
  return (
    <>
      {showLabel && (
        // Cartaz em pé no canto do salão, acima das mesas e de frente para a câmera (mesma
        // contra-rotação da etiqueta da mesa). Deitado no chão inclinado, o nome ficava achatado
        // e as mesas elevadas do salão vizinho passavam por cima dele.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-0 w-0"
          style={{
            left: hall.xCm * scale,
            top: (hall.yCm - HALL_LABEL_CM / 2) * scale,
            transform: `translateZ(${LABEL_RISE_PX}px) rotateZ(${SCENE_ROT_Z}deg) rotateX(-${SCENE_ROT_X}deg)`,
            transformStyle: "preserve-3d",
          }}
        >
          <span className="surface absolute bottom-0 left-0 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold leading-none text-foreground">
            {hall.name}
            {hall.undrawn && <span className="font-normal text-muted-foreground">{" · grade automática"}</span>}
          </span>
        </div>
      )}
      <div
        className="pointer-events-none absolute"
        style={{
          left: hall.xCm * scale,
          top: hall.yCm * scale,
          width: plan.widthCm * scale,
          height: plan.depthCm * scale,
          transformStyle: "preserve-3d",
        }}
      >
        <div aria-hidden="true" className="surface pointer-events-none absolute inset-0 rounded-md" />
        {RAISED.map((wall) => (
          <div key={wall} aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
            <div className="pointer-events-none absolute bg-muted-foreground/30" style={wallRect(wall, WALL_PX)} />
            <div
              className="pointer-events-none absolute bg-muted-foreground/60"
              style={{ ...wallRect(wall, WALL_PX), transform: `translateZ(${WALL_RISE_PX}px)` }}
            />
          </div>
        ))}
        {plan.windowWalls.map((wall) => (
          <div
            key={wall}
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              ...wallRect(wall, WALL_PX),
              backgroundImage: WINDOW_STRIPES,
              transform: `translateZ(${RAISED.includes(wall) ? WALL_RISE_PX + 1 : 1}px)`,
            }}
          />
        ))}
        {entrance && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-sm bg-foreground"
            style={{ ...entrance, transform: "translateZ(2px)" }}
          />
        )}
        {hall.boxes.map((box) => (
          <MesaBotao
            key={box.tableId}
            variant="3d"
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
    </>
  );
}

import type { PlanWall } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";
import type { CenaProps, SceneHall } from "./PlantaCena2D";
import {
  SCENE_ROT_X,
  SCENE_ROT_Z,
  WINDOW_STRIPES,
  entranceRect,
  linkedOutlineRect,
  pickStateOf,
  wallRect,
} from "./scene-geometry";

const WALL_PX = 6;
/** Bem acima da etiqueta da mesa (30 px + texto): mesa no canto não encosta no nome. */
const LABEL_RISE_PX = 56;
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
  /** Escolha de mesas em andamento: selecionáveis, selecionadas e sugeridas. */
  pick?: CenaProps["pick"];
  /** Grupos de mesas ligados visualmente (contorno tracejado). */
  linked?: string[][];
}

/** Um salão dentro do plano girado: chão, paredes elevadas, janelas, entrada e mesas. */
export function SalaoPlano3D({
  hall,
  scale,
  showLabel,
  states,
  timeLabels,
  selectedId,
  onSelect,
  now,
  pick,
  linked,
}: Props) {
  const { plan } = hall;
  const entrance = entranceRect(plan, scale, WALL_PX + 2);
  return (
    <>
      {showLabel && (
        // Cartaz em pé, de frente para a câmera (mesma contra-rotação da etiqueta da mesa),
        // preso ao canto do fundo à direita — o ponto mais alto do salão na tela — e alinhado à
        // direita: ele se estende para a esquerda acima de todo o salão. No canto esquerdo, cobria
        // os números das mesas encostadas na parede do fundo.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute h-0 w-0"
          style={{
            left: (hall.xCm + plan.widthCm) * scale,
            top: hall.yCm * scale,
            transform: `translateZ(${LABEL_RISE_PX}px) rotateZ(${SCENE_ROT_Z}deg) rotateX(-${SCENE_ROT_X}deg)`,
            transformStyle: "preserve-3d",
          }}
        >
          <span className="surface absolute bottom-0 right-0 whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold leading-none text-foreground">
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
        {linked?.map((ids, i) => {
          const outline = linkedOutlineRect(hall.boxes, ids, scale);
          if (!outline) return null;
          return (
            <div
              key={i}
              aria-hidden="true"
              className="pointer-events-none absolute rounded-lg border-2 border-dashed border-primary/70"
              style={{ transform: "translateZ(2px)", ...outline }}
            />
          );
        })}
        {hall.boxes.map((box) => (
          <MesaBotao
            key={box.tableId}
            pickState={pickStateOf(pick, box.tableId)}
            suggested={pick?.suggested?.has(box.tableId)}
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

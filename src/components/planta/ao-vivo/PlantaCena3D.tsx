import { Component, type ReactNode } from "react";
import type { PlanWall } from "@/lib/hall-plan-core";
import { PlanViewport } from "../viewport/PlanViewport";
import { MesaBotao } from "./MesaBotao";
import { PlantaCena2D, type CenaProps } from "./PlantaCena2D";
import {
  SCENE_PERSPECTIVE,
  SCENE_ROT_X,
  SCENE_ROT_Z,
  WINDOW_STRIPES,
  entranceRect,
  fitSceneScale,
  projectedSpanCm,
  wallRect,
} from "./scene-geometry";
import { useContainerWidth, useViewportHeight } from "./useContainerWidth";

const WALL_PX = 6;
const WALL_RISE_PX = 18;
const RAISED: PlanWall[] = ["top", "right"];

function PlantaCena3DInner({ plan, boxes, states, timeLabels, selectedId, onSelect, now }: CenaProps) {
  const { ref, width } = useContainerWidth();
  // Altura disponível: no máximo 70% da janela e 640 px; a escala cabe a caixa projetada nos dois eixos.
  const viewportH = useViewportHeight();
  const maxH = Math.min(viewportH * 0.7, 640);
  const scale = fitSceneScale(plan.widthCm, plan.depthCm, width, maxH);
  const span = projectedSpanCm(plan.widthCm, plan.depthCm);
  const height = Math.min(maxH, Math.max(240, span.h * scale + 64));
  const wPx = plan.widthCm * scale;
  const dPx = plan.depthCm * scale;
  const entrance = entranceRect(plan, scale, WALL_PX + 2);

  return (
    <div ref={ref} className="w-full">
      <PlanViewport
        data-testid="planta-3d"
        className="w-full"
        style={{ height }}
        contentClassName="pointer-events-none"
      >
        <div className="pointer-events-none relative h-full w-full" style={{ perspective: SCENE_PERSPECTIVE }}>
        {/* A entrada anima este invólucro: a animação sobrescreve `transform`, então a rotação fica no filho. */}
        <div
          data-testid="planta-3d-entrada"
          className="pointer-events-none absolute left-1/2 top-1/2 motion-safe:animate-settle"
          style={{
            width: wPx,
            height: dPx,
            marginLeft: -wPx / 2,
            marginTop: -dPx / 2,
            transformStyle: "preserve-3d",
          }}
        >
          <div
            data-testid="planta-3d-plano"
            className="pointer-events-none absolute inset-0"
            style={{
              transform: `rotateX(${SCENE_ROT_X}deg) rotateZ(-${SCENE_ROT_Z}deg)`,
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
            {boxes.map((box) => (
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
        </div>
        </div>
      </PlanViewport>
    </div>
  );
}

/** Se o 3D lançar erro de render, a tela cai para a vista de cima. */
class Cena3DBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Cena 3D do salão falhou; usando a vista 2D.", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function PlantaCena3D(props: CenaProps) {
  return (
    <Cena3DBoundary fallback={<PlantaCena2D {...props} />}>
      <PlantaCena3DInner {...props} />
    </Cena3DBoundary>
  );
}

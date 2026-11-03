import { Component, type ReactNode } from "react";
import type { PlanWall } from "@/lib/hall-plan-core";
import { MesaBotao } from "./MesaBotao";
import { PlantaCena2D, type CenaProps } from "./PlantaCena2D";
import { WINDOW_STRIPES, entranceRect, wallRect } from "./scene-geometry";
import { useContainerWidth } from "./useContainerWidth";

const ROT_Z = 36;
const ROT_X = 56;
const WALL_PX = 6;
const WALL_RISE_PX = 18;
const RAISED: PlanWall[] = ["top", "right"];

function PlantaCena3DInner({ plan, boxes, states, timeLabels, selectedId, onSelect, now }: CenaProps) {
  const { ref, width } = useContainerWidth();
  const z = (ROT_Z * Math.PI) / 180;
  const x = (ROT_X * Math.PI) / 180;
  // Pegada do plano girado: largura na tela e altura achatada pela inclinação.
  const spanW = plan.widthCm * Math.cos(z) + plan.depthCm * Math.sin(z);
  const spanH = (plan.widthCm * Math.sin(z) + plan.depthCm * Math.cos(z)) * Math.cos(x);
  const scale = (width * 0.92) / spanW;
  const height = Math.max(240, spanH * scale + 64);
  const wPx = plan.widthCm * scale;
  const dPx = plan.depthCm * scale;
  const entrance = entranceRect(plan, scale, WALL_PX + 2);

  return (
    <div ref={ref} className="w-full">
      <div data-testid="planta-3d" className="relative w-full" style={{ height, perspective: 1500 }}>
        {/* A entrada anima este invólucro: a animação sobrescreve `transform`, então a rotação fica no filho. */}
        <div
          data-testid="planta-3d-entrada"
          className="absolute left-1/2 top-1/2 motion-safe:animate-settle"
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
            className="absolute inset-0"
            style={{
              transform: `rotateX(${ROT_X}deg) rotateZ(-${ROT_Z}deg)`,
              transformStyle: "preserve-3d",
            }}
          >
            <div aria-hidden="true" className="surface absolute inset-0 rounded-md" />
            {RAISED.map((wall) => (
              <div key={wall} aria-hidden="true" className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
                <div className="absolute bg-muted-foreground/30" style={wallRect(wall, WALL_PX)} />
                <div
                  className="absolute bg-muted-foreground/60"
                  style={{ ...wallRect(wall, WALL_PX), transform: `translateZ(${WALL_RISE_PX}px)` }}
                />
              </div>
            ))}
            {plan.windowWalls.map((wall) => (
              <div
                key={wall}
                aria-hidden="true"
                className="absolute"
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
                className="absolute rounded-sm bg-foreground"
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

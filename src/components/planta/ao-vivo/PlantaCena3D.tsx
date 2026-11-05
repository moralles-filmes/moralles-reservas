import { Component, useRef, type ReactNode } from "react";
import { PlanViewport } from "../viewport/PlanViewport";
import type { PlanViewportApi } from "../viewport/usePlanViewport";
import { PlantaCena2D, type CenaProps } from "./PlantaCena2D";
import { useFocusTable } from "./useFocusTable";
import { SalaoPlano3D } from "./SalaoPlano3D";
import { SCENE_PERSPECTIVE, SCENE_ROT_X, SCENE_ROT_Z, fitSceneScale, projectedSpanCm } from "./scene-geometry";
import { useContainerWidth, useViewportHeight } from "./useContainerWidth";

function PlantaCena3DInner({ halls, layout, showLabels, states, timeLabels, selectedId, onSelect, now, focus, onFocusHandled, maxHeightPx, pick, linked }: CenaProps) {
  const { ref, width } = useContainerWidth();
  const apiRef = useRef<PlanViewportApi | null>(null);
  useFocusTable(apiRef, focus, onFocusHandled);
  // Altura disponível: no máximo 70% da janela e 640 px; a escala cabe a caixa projetada nos dois eixos.
  const viewportH = useViewportHeight();
  const maxH = maxHeightPx != null ? Math.max(240, maxHeightPx) : Math.min(viewportH * 0.7, 640);
  const scale = fitSceneScale(layout.widthCm, layout.depthCm, width, maxH);
  const span = projectedSpanCm(layout.widthCm, layout.depthCm);
  const height = Math.min(maxH, Math.max(240, span.h * scale + 64));
  const wPx = layout.widthCm * scale;
  const dPx = layout.depthCm * scale;

  return (
    <div ref={ref} className="w-full">
      <PlanViewport
        data-testid="planta-3d"
        apiRef={apiRef}
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
            {halls.map((hall) => (
              <SalaoPlano3D
                key={hall.id}
                pick={pick}
                linked={linked}
                hall={hall}
                scale={scale}
                showLabel={showLabels}
                states={states}
                timeLabels={timeLabels}
                selectedId={selectedId}
                onSelect={onSelect}
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

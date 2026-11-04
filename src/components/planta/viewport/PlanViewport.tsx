import { useEffect, useId, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PlanViewportControls } from "./PlanViewportControls";
import { usePlanViewport, type PlanViewportApi } from "./usePlanViewport";

interface PlanViewportProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  label?: string;
  /** Quando muda, o enquadramento volta ao inicial. */
  resetKey?: string | number;
  /** Classes extras do div que recebe o transform (ex.: pointer-events-none na cena 3D). */
  contentClassName?: string;
  /** Opcional: recebe a api do viewport (centerOn etc.) para quem precisa comandá-lo. */
  apiRef?: MutableRefObject<PlanViewportApi | null>;
  "data-testid"?: string;
}

export function PlanViewport({
  children,
  className,
  style,
  label = "Planta do salão",
  resetKey,
  contentClassName,
  apiRef,
  "data-testid": testId,
}: PlanViewportProps) {
  const vp = usePlanViewport();
  const hintId = useId();
  const { reset } = vp;

  useEffect(() => {
    if (apiRef) apiRef.current = vp;
  });

  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  return (
    <div
      ref={vp.containerRef}
      data-testid={testId}
      role="region"
      aria-label={label}
      aria-describedby={hintId}
      tabIndex={0}
      className={cn("relative overflow-hidden", className)}
      style={{ ...style, touchAction: vp.touchAction }}
      {...vp.handlers}
    >
      <span id={hintId} className="sr-only">
        Arraste o fundo para mover; pinça ou Ctrl + roda para zoom
      </span>
      <div
        ref={vp.contentRef}
        data-testid={testId ? `${testId}-conteudo` : undefined}
        className={cn("absolute inset-0", contentClassName)}
        style={{ transformOrigin: "0 0", willChange: "transform" }}
      >
        {children}
      </div>
      <PlanViewportControls zoom={vp.zoom} onZoomIn={vp.zoomIn} onZoomOut={vp.zoomOut} onReset={vp.reset} />
    </div>
  );
}

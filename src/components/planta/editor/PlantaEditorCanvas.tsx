import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PlanViewportControls } from "@/components/planta/viewport/PlanViewportControls";
import { usePlanViewport } from "@/components/planta/viewport/usePlanViewport";
import {
  ENTRANCE_CM,
  GRID_CM,
  clampBox,
  entranceAt,
  resizedSize,
  snap,
} from "@/lib/hall-plan-core";
import type { HallPlan, PlanWall, TableBox } from "@/lib/hall-plan-core";

interface Props {
  plan: HallPlan;
  boxes: TableBox[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Recebe a posição final em cm, já com snap e clamp aplicados aqui. */
  onMove: (id: string, xCm: number, yCm: number) => void;
  /** Recebe o tamanho final em cm (30–600, de 5 em 5); em mesa não retangular, w = h. */
  onResize: (id: string, wCm: number, hCm: number) => void;
  onEntranceChange: (entrance: NonNullable<HallPlan["entrance"]>) => void;
  readOnly?: boolean;
}

interface ResizeState {
  id: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
}

interface DragState {
  id: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

const WALL_THICKNESS = 4;
/** Deslocamento mínimo para um toque virar arrasto: o tremor do dedo não move a mesa. */
const DRAG_THRESHOLD_PX = 5;

function wallStyle(wall: PlanWall): React.CSSProperties {
  switch (wall) {
    case "top":
      return { top: 0, left: 0, right: 0, height: WALL_THICKNESS };
    case "bottom":
      return { bottom: 0, left: 0, right: 0, height: WALL_THICKNESS };
    case "left":
      return { left: 0, top: 0, bottom: 0, width: WALL_THICKNESS };
    default:
      return { right: 0, top: 0, bottom: 0, width: WALL_THICKNESS };
  }
}

export function PlantaEditorCanvas({
  plan,
  boxes,
  selectedId,
  onSelect,
  onMove,
  onResize,
  onEntranceChange,
  readOnly = false,
}: Props) {
  const vp = usePlanViewport();
  const containerRef = vp.containerRef;
  const [scale, setScale] = useState(1);
  const [drag, setDrag] = useState<{
    id: string;
    dx: number;
    dy: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [resize, setResize] = useState<{
    id: string;
    w: number;
    h: number;
  } | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [entranceDraft, setEntranceDraft] =
    useState<HallPlan["entrance"]>(null);
  const entrancePointerRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0 && plan.widthCm > 0) setScale(w / plan.widthCm);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [plan.widthCm, containerRef]);

  // Escala efetiva em px de tela por cm: ajuste à largura vezes o zoom do viewport.
  const eff = scale * vp.zoom;
  const gridPx = GRID_CM * scale;

  const onPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    box: TableBox,
  ) => {
    onSelect(box.tableId);
    if (readOnly) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: box.tableId,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (
      !d.moved &&
      Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) <
        DRAG_THRESHOLD_PX
    )
      return;
    d.moved = true;
    setDrag({
      id: d.id,
      dx: (e.clientX - d.startClientX) / vp.zoom,
      dy: (e.clientY - d.startClientY) / vp.zoom,
    });
  };

  const endDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    commit: boolean,
  ) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!commit || !d.moved) return;
    const box = boxes.find((b) => b.tableId === d.id);
    if (!box) return;
    const dxCm = (e.clientX - d.startClientX) / eff;
    const dyCm = (e.clientY - d.startClientY) / eff;
    const next = clampBox(
      { ...box, x: snap(box.x + dxCm), y: snap(box.y + dyCm) },
      plan,
    );
    onMove(box.tableId, next.x, next.y);
  };

  const onResizeDown = (
    e: React.PointerEvent<HTMLSpanElement>,
    box: TableBox,
  ) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    resizeRef.current = {
      id: box.tableId,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
  };

  const resizeFor = (e: React.PointerEvent<HTMLSpanElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return null;
    const box = boxes.find((b) => b.tableId === r.id);
    if (!box) return null;
    return {
      box,
      ...resizedSize(
        box,
        e.clientX - r.startClientX,
        e.clientY - r.startClientY,
        eff,
      ),
    };
  };

  const onResizeMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const next = resizeFor(e);
    if (next) setResize({ id: next.box.tableId, w: next.w, h: next.h });
  };

  const endResize = (
    e: React.PointerEvent<HTMLSpanElement>,
    commit: boolean,
  ) => {
    const next = resizeFor(e);
    resizeRef.current = null;
    setResize(null);
    if (commit && next && (next.w !== next.box.w || next.h !== next.box.h))
      onResize(next.box.tableId, next.w, next.h);
  };

  const entranceFromPointer = (e: React.PointerEvent<HTMLElement>) => {
    const rect = vp.contentRef.current?.getBoundingClientRect();
    if (!rect || eff <= 0) return null;
    return entranceAt(
      (e.clientX - rect.left) / eff,
      (e.clientY - rect.top) / eff,
      plan,
    );
  };

  const onEntranceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (readOnly) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    entrancePointerRef.current = e.pointerId;
  };

  const onEntranceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (entrancePointerRef.current !== e.pointerId) return;
    const next = entranceFromPointer(e);
    if (next) setEntranceDraft(next);
  };

  const endEntrance = (
    e: React.PointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    if (entrancePointerRef.current !== e.pointerId) return;
    entrancePointerRef.current = null;
    const next = entranceDraft;
    setEntranceDraft(null);
    if (
      commit &&
      next &&
      (next.wall !== plan.entrance?.wall ||
        next.offsetCm !== plan.entrance?.offsetCm)
    ) {
      onEntranceChange(next);
    }
  };

  const entrance = entranceDraft ?? plan.entrance;
  const entranceStyle: React.CSSProperties | null = entrance
    ? entrance.wall === "top" || entrance.wall === "bottom"
      ? {
          [entrance.wall]: 0,
          left: entrance.offsetCm * scale,
          width: ENTRANCE_CM * scale,
          height: WALL_THICKNESS + 4,
        }
      : {
          [entrance.wall]: 0,
          top: entrance.offsetCm * scale,
          height: ENTRANCE_CM * scale,
          width: WALL_THICKNESS + 4,
        }
    : null;

  return (
    <div
      ref={containerRef}
      data-testid="planta-canvas"
      data-planta-canvas=""
      role="region"
      aria-label="Planta do salão"
      tabIndex={0}
      className="surface relative w-full overflow-hidden rounded-lg border border-border bg-background"
      style={{
        aspectRatio: `${plan.widthCm} / ${plan.depthCm}`,
        touchAction: "none",
      }}
      {...vp.handlers}
    >
      <div
        ref={vp.contentRef}
        data-testid="planta-canvas-conteudo"
        className="absolute inset-0"
        style={{
          transformOrigin: "0 0",
          willChange: "transform",
          backgroundImage:
            "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: `${gridPx}px ${gridPx}px`,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !vp.wasPanning()) onSelect(null);
        }}
      >
        {plan.windowWalls.map((wall) => (
          <div
            key={wall}
            aria-hidden="true"
            className="absolute bg-primary/60"
            style={wallStyle(wall)}
            title="Janela"
          />
        ))}
        {entranceStyle && (
          // Arrastável; o seletor e o campo de deslocamento no painel são a alternativa por teclado.
          <div
            aria-hidden="true"
            data-testid="planta-entrada"
            className={cn(
              "absolute z-10 rounded-sm bg-muted-foreground",
              // Área de pega maior que o traço, sem mudar o desenho.
              "after:absolute after:-inset-2 after:content-[''] coarse:after:-inset-5",
              !readOnly && "cursor-move",
            )}
            style={{ ...entranceStyle, touchAction: "none" }}
            title={
              readOnly ? "Entrada" : "Entrada (arraste para mudar de lugar)"
            }
            onPointerDown={onEntranceDown}
            onPointerMove={onEntranceMove}
            onPointerUp={(e) => endEntrance(e, true)}
            onPointerCancel={(e) => endEntrance(e, false)}
          />
        )}
        {boxes.map((box) => {
          const selected = box.tableId === selectedId;
          const dragging = drag?.id === box.tableId;
          const dx = dragging ? drag.dx : 0;
          const dy = dragging ? drag.dy : 0;
          const size = resize?.id === box.tableId ? resize : box;
          const wPx = size.w * scale;
          const hPx = size.h * scale;
          // A lotação só cabe abaixo do número quando a mesa desenhada tem altura para duas linhas.
          const showCapacity = Math.min(wPx, hPx) >= 34;
          return (
            <div
              key={box.tableId}
              className="absolute"
              style={{
                left: (box.x - size.w / 2) * scale,
                top: (box.y - size.h / 2) * scale,
                width: wPx,
                height: hPx,
                transform: `translate(${dx}px, ${dy}px) rotate(${box.rotation}deg)`,
              }}
            >
              <button
                type="button"
                data-x={box.x}
                data-y={box.y}
                data-positioned={box.positioned ? "true" : "false"}
                aria-label={`Mesa ${box.number}, ${box.capacity} lugares${box.positioned ? "" : ", sem posição"}`}
                aria-pressed={selected}
                onPointerDown={(e) => onPointerDown(e, box)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endDrag(e, true)}
                onPointerCancel={(e) => endDrag(e, false)}
                onClick={() => onSelect(box.tableId)}
                className={cn(
                  "absolute inset-0 flex flex-col items-center justify-center border-2 bg-[hsl(var(--status-free)/0.15)] border-[hsl(var(--status-free))] text-xs font-semibold leading-none text-foreground",
                  "select-none",
                  // Alvo de toque de 44 px em ponteiro grosso sem mudar o desenho nem o centro.
                  "after:absolute after:left-1/2 after:top-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                  "coarse:after:h-11 coarse:after:w-11",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  box.shape === "round" ? "rounded-full" : "rounded-md",
                  !box.positioned && "border-dashed",
                  selected && "ring-2 ring-ring",
                  !readOnly && "cursor-grab",
                  dragging && "cursor-grabbing",
                )}
                style={{ touchAction: "none" }}
              >
                <span>{box.number}</span>
                {showCapacity && (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[10px] font-normal text-muted-foreground"
                  >
                    {`${box.capacity} lug.`}
                  </span>
                )}
              </button>
              {selected && !readOnly && (
                // Alça de tamanho; largura e profundidade no painel são a alternativa por teclado.
                <span
                  aria-hidden="true"
                  data-testid="planta-alca-tamanho"
                  className={cn(
                    "absolute -bottom-1.5 -right-1.5 z-10 h-3 w-3 cursor-nwse-resize rounded-sm border border-background bg-primary",
                    "after:absolute after:-inset-1.5 after:content-[''] coarse:after:-inset-4",
                  )}
                  style={{ touchAction: "none" }}
                  onPointerDown={(e) => onResizeDown(e, box)}
                  onPointerMove={onResizeMove}
                  onPointerUp={(e) => endResize(e, true)}
                  onPointerCancel={(e) => endResize(e, false)}
                />
              )}
            </div>
          );
        })}
      </div>
      <PlanViewportControls
        zoom={vp.zoom}
        onZoomIn={vp.zoomIn}
        onZoomOut={vp.zoomOut}
        onReset={vp.reset}
      />
    </div>
  );
}

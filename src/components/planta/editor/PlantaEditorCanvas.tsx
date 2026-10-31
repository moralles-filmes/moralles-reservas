import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { GRID_CM, clampBox, snap } from "@/lib/hall-plan-core";
import type { HallPlan, PlanWall, TableBox } from "@/lib/hall-plan-core";

interface Props {
  plan: HallPlan;
  boxes: TableBox[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Recebe a posição final em cm, já com snap e clamp aplicados aqui. */
  onMove: (id: string, xCm: number, yCm: number) => void;
  readOnly?: boolean;
}

interface DragState {
  id: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

const WALL_THICKNESS = 4;

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

export function PlantaEditorCanvas({ plan, boxes, selectedId, onSelect, onMove, readOnly = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);

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
  }, [plan.widthCm]);

  const gridPx = GRID_CM * scale;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, box: TableBox) => {
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
    d.moved = true;
    setDrag({ id: d.id, dx: e.clientX - d.startClientX, dy: e.clientY - d.startClientY });
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!commit || !d.moved) return;
    const box = boxes.find((b) => b.tableId === d.id);
    if (!box) return;
    const dxCm = (e.clientX - d.startClientX) / scale;
    const dyCm = (e.clientY - d.startClientY) / scale;
    const next = clampBox({ ...box, x: snap(box.x + dxCm), y: snap(box.y + dyCm) }, plan);
    onMove(box.tableId, next.x, next.y);
  };

  const entrance = plan.entrance;
  const entranceStyle: React.CSSProperties | null = entrance
    ? entrance.wall === "top" || entrance.wall === "bottom"
      ? {
          [entrance.wall]: 0,
          left: entrance.offsetCm * scale,
          width: 90 * scale,
          height: WALL_THICKNESS + 2,
        }
      : {
          [entrance.wall]: 0,
          top: entrance.offsetCm * scale,
          height: 90 * scale,
          width: WALL_THICKNESS + 2,
        }
    : null;

  return (
    <div
      ref={containerRef}
      data-testid="planta-canvas"
      className="surface relative w-full overflow-hidden rounded-lg border border-border bg-background"
      style={{
        aspectRatio: `${plan.widthCm} / ${plan.depthCm}`,
        backgroundImage:
          "linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)",
        backgroundSize: `${gridPx}px ${gridPx}px`,
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
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
        <div
          aria-hidden="true"
          className="absolute bg-[hsl(var(--status-free))]"
          style={entranceStyle}
          title="Entrada"
        />
      )}
      {boxes.map((box) => {
        const selected = box.tableId === selectedId;
        const dragging = drag?.id === box.tableId;
        const dx = dragging ? drag.dx : 0;
        const dy = dragging ? drag.dy : 0;
        return (
          <button
            key={box.tableId}
            type="button"
            data-x={box.x}
            data-y={box.y}
            data-positioned={box.positioned ? "true" : "false"}
            aria-label={`Mesa ${box.number}, ${box.capacity} lugares`}
            aria-pressed={selected}
            onPointerDown={(e) => onPointerDown(e, box)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
            onClick={() => onSelect(box.tableId)}
            className={cn(
              "absolute flex items-center justify-center border-2 bg-[hsl(var(--status-free)/0.15)] border-[hsl(var(--status-free))] text-xs font-semibold text-foreground",
              "min-h-5 min-w-5 select-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              box.shape === "round" ? "rounded-full" : "rounded-md",
              !box.positioned && "border-dashed",
              selected && "ring-2 ring-ring",
              !readOnly && "cursor-grab",
              dragging && "cursor-grabbing",
            )}
            style={{
              left: (box.x - box.w / 2) * scale,
              top: (box.y - box.h / 2) * scale,
              width: box.w * scale,
              height: box.h * scale,
              transform: `translate(${dx}px, ${dy}px) rotate(${box.rotation}deg)`,
              touchAction: "none",
            }}
          >
            {box.number}
          </button>
        );
      })}
    </div>
  );
}

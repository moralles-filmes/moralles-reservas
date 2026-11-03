import { cn } from "@/lib/utils";
import type { TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { SITUATION_TONE, SITUATION_LABEL, TONE_CLASS, situationText } from "../situation-labels";

interface Props {
  box: TableBox;
  state: TableState;
  /** cm → px. */
  scale: number;
  selected: boolean;
  onSelect: (tableId: string) => void;
  /** Horário da reserva em foco (HH:MM), mostrado na etiqueta. */
  timeLabel?: string;
  now: Date;
  variant: "3d" | "2d";
}

export function mesaAriaLabel(box: TableBox, state: TableState, now: Date): string {
  const head = `Mesa ${box.number}, ${box.capacity} lugares`;
  if (state.situation === "occupied" && state.occupant) {
    const min = Math.max(0, Math.floor((now.getTime() - new Date(state.occupant.since).getTime()) / 60_000));
    return `${head}, ${SITUATION_LABEL.occupied} há ${min} min${state.overtime ? ", passou do tempo" : ""}`;
  }
  return `${head}, ${situationText(state)}`;
}

export function MesaBotao({ box, state, scale, selected, onSelect, timeLabel, now, variant }: Props) {
  const cls = TONE_CLASS[SITUATION_TONE[state.situation]];
  const pulses = state.situation === "arriving" || state.situation === "late";
  const is3d = variant === "3d";
  const shape = box.shape === "round" ? "rounded-full" : "rounded-md";

  return (
    <div
      className="absolute"
      style={{
        left: (box.x - box.w / 2) * scale,
        top: (box.y - box.h / 2) * scale,
        width: box.w * scale,
        height: box.h * scale,
        transform: `rotate(${box.rotation}deg)`,
        transformStyle: is3d ? "preserve-3d" : undefined,
      }}
    >
      {is3d && (
        <>
          <span aria-hidden="true" className={cn("absolute inset-0 bg-foreground/25", shape)} />
          <span
            aria-hidden="true"
            className={cn("absolute inset-0 bg-foreground/40", shape)}
            style={{ transform: "translateZ(8px)" }}
          />
        </>
      )}
      {pulses && (
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-0 opacity-0 motion-safe:animate-halo", cls.halo, shape)}
          style={is3d ? { transform: "translateZ(16px)" } : undefined}
        />
      )}
      <button
        type="button"
        aria-label={mesaAriaLabel(box, state, now)}
        aria-pressed={selected}
        onClick={() => onSelect(box.tableId)}
        className={cn(
          "absolute inset-0 flex select-none items-center justify-center border-2 text-foreground",
          "transition-transform duration-200 ease-out-expo motion-safe:active:scale-95",
          "after:absolute after:left-1/2 after:top-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
          "coarse:after:h-11 coarse:after:w-11",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          shape,
          cls.cap,
          selected && "ring-2 ring-ring",
        )}
        style={is3d ? { transform: "translateZ(16px)" } : undefined}
      >
        <span
          className="pointer-events-none flex flex-col items-center text-[11px] font-semibold leading-tight"
          style={{
            transform: is3d
              ? `rotate(${-box.rotation}deg) rotateZ(36deg) rotateX(-56deg)`
              : `rotate(${-box.rotation}deg)`,
          }}
        >
          <span>{box.number}</span>
          {timeLabel && <span className="text-[10px] font-normal">{timeLabel}</span>}
        </span>
      </button>
    </div>
  );
}

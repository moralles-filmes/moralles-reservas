import { cn } from "@/lib/utils";
import type { TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { elapsedLabel } from "@/lib/elapsed-label";
import { SITUATION_TONE, TONE_CLASS } from "../situation-labels";
import { SCENE_ROT_X, SCENE_ROT_Z, mesaAriaLabel } from "./scene-geometry";

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

export function MesaBotao({ box, state, scale, selected, onSelect, timeLabel, now, variant }: Props) {
  const cls = TONE_CLASS[SITUATION_TONE[state.situation]];
  const pulses = state.situation === "arriving" || state.situation === "late";
  const is3d = variant === "3d";
  const shape = box.shape === "round" ? "rounded-full" : "rounded-md";
  // O deslocamento em Z fica no invólucro; animação e escala de toque agem nos filhos.
  const lift = (z: number): React.CSSProperties | undefined =>
    is3d ? { transform: `translateZ(${z}px)`, transformStyle: "preserve-3d" } : undefined;

  // Mesa ocupada mostra o tempo de permanência no lugar do horário de reserva.
  const occupied = state.situation === "occupied" && !!state.occupant;
  const elapsed = occupied && state.occupant ? elapsedLabel(state.occupant.since, now) : undefined;
  const lateTone = state.overtime ? cn("rounded border px-1", TONE_CLASS[SITUATION_TONE.late].pill) : undefined;
  // Rótulo secundário: contador quando ocupada, senão o HH:MM de reserva.
  const secondary = occupied ? elapsed : timeLabel;

  return (
    <div
      className={cn("absolute", is3d && "pointer-events-none")}
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
          <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 bg-foreground/25", shape)} />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={lift(8)}>
            <span className={cn("absolute inset-0 bg-foreground/40", shape)} />
          </div>
        </>
      )}
      {pulses && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={lift(16)}>
          <span className={cn("absolute inset-0 opacity-0 motion-safe:animate-halo", cls.halo, shape)} />
        </div>
      )}
      <div className={cn("absolute inset-0", is3d && "pointer-events-none")} style={lift(16)}>
        <button
          type="button"
          data-table-id={box.tableId}
          aria-label={mesaAriaLabel(box, state, now)}
          aria-pressed={selected}
          onClick={() => onSelect(box.tableId)}
          className={cn(
            "pointer-events-auto absolute inset-0 flex select-none items-center justify-center border-2 text-foreground",
            "transition-transform duration-200 ease-out-expo motion-safe:active:scale-95",
            "after:absolute after:left-1/2 after:top-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
            // No 3D o plano está inclinado (rotateX 56°): a altura projetada encolhe para cos(56°) ≈ 0,56,
            // então o alvo precisa de ≥ 44/0,56 ≈ 79 px de altura no plano para seguir com 44 px na tela.
            is3d ? "coarse:after:h-20 coarse:after:w-11" : "coarse:after:h-11 coarse:after:w-11",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            shape,
            cls.cap,
            selected && "ring-2 ring-ring",
          )}
        >
          {!is3d && (
              <span className="pointer-events-none flex flex-col items-center text-[11px] font-semibold leading-tight" style={{ transform: `rotate(${-box.rotation}deg)` }}>
                <span>{box.number}</span>
                {secondary && (
                  <span className={cn("text-[10px] font-normal", occupied && lateTone)}>{secondary}</span>
                )}
              </span>
          )}
        </button>
      </div>
      {is3d && (
        // Etiqueta em pé, de frente para a câmera: irmã do botão (um <button> sem preserve-3d achataria o texto).
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0"
          style={{
            transform: `translateZ(30px) rotate(${-box.rotation}deg) rotateZ(${SCENE_ROT_Z}deg) rotateX(-${SCENE_ROT_X}deg)`,
            transformStyle: "preserve-3d",
          }}
        >
          <span className="absolute left-0 top-0 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center whitespace-nowrap text-sm font-bold leading-none text-foreground [text-shadow:0_0_4px_hsl(var(--background))]">
            <span>{box.number}</span>
            {secondary && (
              <span className={cn("mt-0.5 text-[11px] font-medium", occupied && lateTone)}>{secondary}</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

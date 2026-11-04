import type { TableSituation, TableState } from "@/lib/table-situation-core";

export type SituationTone = "late" | "seated" | "arriving" | "reserved" | "free" | "pending";

export const SITUATION_LABEL: Record<TableSituation, string> = {
  blocked: "Bloqueada",
  occupied: "Ocupada",
  late: "Atrasada",
  arriving: "Chegando",
  reserved: "Reservada",
  free: "Livre",
};

export const SITUATION_TONE: Record<TableSituation, SituationTone> = {
  blocked: "pending",
  occupied: "seated",
  late: "late",
  arriving: "arriving",
  reserved: "reserved",
  free: "free",
};

export const SITUATION_ORDER: TableSituation[] = ["blocked", "occupied", "late", "arriving", "reserved", "free"];

/** Classes literais (o Tailwind precisa vê-las inteiras): ponto de legenda, tampa, pílula e halo por tom. */
export const TONE_CLASS: Record<SituationTone, { dot: string; cap: string; pill: string; halo: string }> = {
  late: {
    dot: "bg-[hsl(var(--status-late))]",
    cap: "bg-[hsl(var(--status-late)/0.8)] border-[hsl(var(--status-late))]",
    pill: "bg-[hsl(var(--status-late)/0.15)] text-foreground border-[hsl(var(--status-late))]",
    halo: "bg-[hsl(var(--status-late))]",
  },
  seated: {
    dot: "bg-[hsl(var(--status-seated))]",
    cap: "bg-[hsl(var(--status-seated)/0.8)] border-[hsl(var(--status-seated))]",
    pill: "bg-[hsl(var(--status-seated)/0.15)] text-foreground border-[hsl(var(--status-seated))]",
    halo: "bg-[hsl(var(--status-seated))]",
  },
  arriving: {
    dot: "bg-[hsl(var(--status-arriving))]",
    cap: "bg-[hsl(var(--status-arriving)/0.8)] border-[hsl(var(--status-arriving))]",
    pill: "bg-[hsl(var(--status-arriving)/0.15)] text-foreground border-[hsl(var(--status-arriving))]",
    halo: "bg-[hsl(var(--status-arriving))]",
  },
  reserved: {
    dot: "bg-[hsl(var(--status-reserved))]",
    cap: "bg-[hsl(var(--status-reserved)/0.8)] border-[hsl(var(--status-reserved))]",
    pill: "bg-[hsl(var(--status-reserved)/0.15)] text-foreground border-[hsl(var(--status-reserved))]",
    halo: "bg-[hsl(var(--status-reserved))]",
  },
  free: {
    dot: "bg-[hsl(var(--status-free))]",
    cap: "bg-[hsl(var(--status-free)/0.25)] border-[hsl(var(--status-free))]",
    pill: "bg-[hsl(var(--status-free)/0.15)] text-foreground border-[hsl(var(--status-free))]",
    halo: "bg-[hsl(var(--status-free))]",
  },
  pending: {
    dot: "bg-[hsl(var(--status-pending))]",
    cap: "bg-[hsl(var(--status-pending)/0.5)] border-[hsl(var(--status-pending))]",
    pill: "bg-[hsl(var(--status-pending)/0.15)] text-foreground border-[hsl(var(--status-pending))]",
    halo: "bg-[hsl(var(--status-pending))]",
  },
};

export function situationText(state: TableState): string {
  if (state.situation === "late" && state.minutesLate != null) return `Atrasada ${state.minutesLate} min`;
  if (state.situation === "arriving" && state.minutesUntil != null) return `Chega em ${state.minutesUntil} min`;
  if (state.situation === "occupied" && state.overtime) return "Ocupada · passou do tempo";
  return SITUATION_LABEL[state.situation];
}

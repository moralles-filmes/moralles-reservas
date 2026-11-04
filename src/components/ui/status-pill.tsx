import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone =
  | "free"
  | "reserved"
  | "arriving"
  | "seated"
  | "late"
  | "pending"
  | "destructive"
  | "muted"
  | "success";

// Classes literais (o Tailwind só gera o que vê escrito por inteiro). Só tokens, nenhuma cor fixa.
const TONE_CLASSES: Record<StatusTone, string> = {
  free: "bg-status-free/15 text-status-free border-status-free/25",
  reserved: "bg-status-reserved/15 text-status-reserved border-status-reserved/25",
  arriving: "bg-status-arriving/15 text-status-arriving border-status-arriving/25",
  seated: "bg-status-seated/15 text-status-seated border-status-seated/25",
  late: "bg-status-late/15 text-status-late border-status-late/25",
  pending: "bg-status-pending/15 text-status-pending border-status-pending/25",
  destructive: "bg-destructive/15 text-destructive border-destructive/25",
  muted: "bg-muted text-muted-foreground border-border",
  success: "bg-success/15 text-success border-success/25",
};

/** Pílula única de situação/status das listas: a cor vem do tom, o sentido vem do texto. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium shrink-0",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

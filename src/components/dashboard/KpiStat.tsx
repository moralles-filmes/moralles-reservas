import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  title: string;
  value: number | string | null | undefined;
  icon: React.ElementType;
  color: string;
  /** Delta vs período anterior. Em % por padrão; em valor absoluto se deltaUnit='abs'. */
  delta?: number | null;
  /** Quando true, queda é "boa" (ex: taxa de no-show caiu = bom). */
  invertDelta?: boolean;
  /** Unidade do delta. 'pct' (default) renderiza "X%"; 'abs' renderiza "+X.X". */
  deltaUnit?: "pct" | "abs";
  /** Sufixo opcional para o valor (ex: "%", "⭐"). */
  suffix?: string;
}

export function formatValue(value: number | string | null | undefined): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(1);
  }
  return value;
}

export function KpiStat({ title, value, icon: Icon, color, delta, invertDelta, deltaUnit = "pct", suffix }: KpiCardProps) {
  const isLoading = value === undefined;
  const hasNumericValue = typeof value === "number" && Number.isFinite(value);
  const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
  const positive = hasDelta && delta! > 0;
  const negative = hasDelta && delta! < 0;
  const isGood = invertDelta ? negative : positive;
  const isBad = invertDelta ? positive : negative;

  const deltaColor = !hasDelta
    ? "text-muted-foreground"
    : isGood
    ? "text-success"
    : isBad
    ? "text-destructive"
    : "text-muted-foreground";

  const DeltaIcon = !hasDelta || delta === 0 ? Minus : positive ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="p-4 sm:p-6">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-snug text-tertiary">{title}</p>
          {isLoading ? (
            <Skeleton className="h-9 w-20 mt-2" />
          ) : (
            <p className="tabular text-3xl font-semibold tracking-tight mt-1.5">
              {formatValue(value)}
              {suffix && hasNumericValue && (
                <span className="text-lg font-medium text-tertiary ml-0.5">{suffix}</span>
              )}
            </p>
          )}
          {hasDelta && !isLoading && (
            <div className={cn("flex items-center gap-0.5 mt-1.5 text-xs font-medium tabular", deltaColor)}>
              <DeltaIcon className="h-3 w-3" />
              <span>
                {delta === 0
                  ? "—"
                  : deltaUnit === "abs"
                  ? Math.abs(delta!).toFixed(1)
                  : `${Math.abs(delta!).toFixed(1)}%`}
              </span>
            </div>
          )}
        </div>
        <div className={cn("p-2 rounded-item shrink-0", color)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

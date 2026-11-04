import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { KpiDelta } from "@/lib/relatorio-passantes";
import { deltaText, roundedDelta } from "./format";

interface Props {
  title: string;
  value: string;
  icon: React.ElementType;
  subtitle?: string | null;
  delta?: KpiDelta;
  /** Queda é boa (espera, desistência). */
  invertDelta?: boolean;
}

export function PassanteKpiCard({ title, value, icon: Icon, subtitle, delta, invertDelta }: Props) {
  const text = deltaText(delta);
  const d = roundedDelta(delta) ?? 0;
  const good = invertDelta ? d < 0 : d > 0;
  const bad = invertDelta ? d > 0 : d < 0;
  const DeltaIcon = d === 0 ? Minus : d > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Card>
      <div className="p-4 sm:p-6">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-xs leading-snug text-tertiary">{title}</p>
          <div className="p-2 rounded-item shrink-0 bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <p className="tabular font-semibold tracking-tight mt-1 break-words text-3xl">{value}</p>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
        {text && (
          <div
            className={cn(
              "flex items-center gap-0.5 mt-1.5 text-xs font-medium tabular",
              good ? "text-success" : bad ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <DeltaIcon className="h-3 w-3" />
            <span>{text}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

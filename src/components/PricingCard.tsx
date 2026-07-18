import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCentsBRL, parsePlanFeatures, type BillingPlan } from "@/types/billing";
import { planIntervalLabel } from "@/lib/billing-plan-display";

type CtaState =
  | { kind: "choose"; label?: string }
  | { kind: "current" }
  | { kind: "change"; label?: string }
  | { kind: "hidden" };

interface Props {
  plan: BillingPlan;
  cta: CtaState;
  onAction?: () => void;
  loading?: boolean;
}

export function PricingCard({ plan, cta, onAction, loading }: Props) {
  const features = parsePlanFeatures(plan.features);
  // `recommended` (migration 063) é o destaque canônico. A coluna `popular` é
  // legado: continua no banco, mas a UI não lê nem escreve mais nela.
  const isHighlighted = plan.recommended === true;
  const isCurrent = cta.kind === "current";
  const intervalLabel = planIntervalLabel(plan);

  return (
    <Card
      className={cn(
        "relative flex flex-col h-full",
        isHighlighted && "border-2 border-primary shadow-lg",
        isCurrent && "ring-2 ring-success/40",
      )}
    >
      {isHighlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge className="bg-primary text-primary-foreground text-xs px-3 py-0.5">Recomendado</Badge>
        </div>
      )}

      <CardContent className="pt-6 pb-6 flex flex-col flex-1 gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">{plan.name}</h3>
          {plan.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{plan.description}</p>
          )}
        </div>

        <div className="space-y-0.5">
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold">{formatCentsBRL(plan.amount_cents)}</span>
            {/* null = cobrança única: mostrar "/mês" num pacote avulso diria ao
                cliente que ele vai ser cobrado todo mês. */}
            <span className="text-sm text-muted-foreground">
              {intervalLabel === null
                ? "pagamento único"
                : `/${plan.interval === "year" ? "ano" : "mês"}`}
            </span>
          </div>
          {plan.trial_days > 0 && (
            <p className="text-xs text-success font-medium">
              {plan.trial_days} dias grátis pra testar
            </p>
          )}
        </div>

        {features.length > 0 && (
          <ul className="space-y-2 flex-1">
            {features.map((feature, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Check className="h-4 w-4 text-success shrink-0 mt-0.5" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        )}

        {features.length === 0 && (
          <div className="flex-1" />
        )}

        {cta.kind !== "hidden" && (
          <Button
            className="w-full mt-2"
            variant={isCurrent ? "outline" : isHighlighted ? "default" : "secondary"}
            disabled={isCurrent || loading}
            onClick={onAction}
          >
            {cta.kind === "current" && "Plano atual"}
            {cta.kind === "choose" && (cta.label ?? "Escolher este plano")}
            {cta.kind === "change" && (cta.label ?? "Trocar para este plano")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

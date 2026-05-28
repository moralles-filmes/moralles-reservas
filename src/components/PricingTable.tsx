import { PricingCard } from "./PricingCard";
import type { BillingPlan } from "@/types/billing";

interface Props {
  plans: BillingPlan[];
  currentPlanId: string | null;
  onChoose: (plan: BillingPlan) => void;
  onChange: (plan: BillingPlan) => void;
  loadingPlanId?: string | null;
}

/**
 * Grid de cards de plano lado a lado. Decide o CTA de cada card:
 *  - Sem subscription ativa: "Escolher este plano"
 *  - Com sub ativa no mesmo plan: "Plano atual" (disabled)
 *  - Com sub ativa em outro plan: "Trocar para este plano"
 */
export function PricingTable({ plans, currentPlanId, onChoose, onChange, loadingPlanId }: Props) {
  if (!plans.length) {
    return (
      <p className="text-center text-muted-foreground py-8">
        Nenhum plano disponível no momento.
      </p>
    );
  }

  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {sorted.map((plan) => {
        const isCurrent = currentPlanId === plan.id;
        const cta = isCurrent
          ? ({ kind: "current" } as const)
          : currentPlanId
            ? ({ kind: "change" } as const)
            : ({ kind: "choose" } as const);

        return (
          <PricingCard
            key={plan.id}
            plan={plan}
            cta={cta}
            loading={loadingPlanId === plan.id}
            onAction={() => {
              if (currentPlanId) onChange(plan);
              else onChoose(plan);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Núcleo PURO dos marcos da franquia (spec §18.2). ZERO IMPORTS.
 *
 * FONTE CANÔNICA ÚNICA dos quatro `event_type`. Nenhum produtor pode emitir
 * string fora daqui — é a SEXTA ocorrência do acoplamento por string com
 * `TEMPLATE_BY_EVENT` de `process-billing-notifications`, e sem a entrada lá a
 * linha enfileirada morre em `failed/unknown_event_type` exatamente quando
 * importa. O teste bidirecional está em `src/lib/ai-budget-dispatcher.test.ts`.
 *
 * Os marcos são PERCENTUAIS do `limit_cents` do ciclo, não valores absolutos.
 * Com o limite de R$ 100 eles caem exatamente em R$ 70/80/90/100 da spec; com
 * um limite diferente (plano CUSTOM futuro) a escada acompanha, em vez de um
 * marco de R$ 70 virar "94% do teto" sem ninguém decidir isso.
 */

export const AI_BUDGET_MILESTONE_PERCENTS = [70, 80, 90, 100] as const;

export type AiBudgetMilestonePercent = (typeof AI_BUDGET_MILESTONE_PERCENTS)[number];

export const EVENT_TYPE_BY_MILESTONE_PERCENT: Record<number, string> = {
  70: "admin_ai_budget_70",
  80: "admin_ai_budget_80",
  90: "admin_ai_budget_90",
  100: "admin_ai_budget_stop",
};

/** Lista achatada, derivada — nunca redigitada. */
export const CANONICAL_AI_BUDGET_EVENT_TYPES: string[] = AI_BUDGET_MILESTONE_PERCENTS.map(
  (p) => EVENT_TYPE_BY_MILESTONE_PERCENT[p],
);

/**
 * Marcos já ultrapassados pelo custo LIQUIDADO do ciclo.
 *
 * Devolve TODOS os cruzados, não só o último: uma passada que salte de 60% para
 * 95% (turno caro) precisa registrar os três marcos, senão o ledger fica com
 * buracos e o admin nunca vê o aviso de 70%. A unicidade por ciclo é do ledger,
 * não desta função.
 */
export function crossedMilestonePercents(settledCents: number, limitCents: number): number[] {
  if (!Number.isFinite(settledCents) || !Number.isFinite(limitCents) || limitCents <= 0) return [];
  return AI_BUDGET_MILESTONE_PERCENTS.filter((p) => settledCents * 100 >= limitCents * p);
}

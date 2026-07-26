// Elegibilidade por categoria de plano. Na Fase 5a só WHATSAPP_SUBSCRIPTION tem
// regra própria (Task 11); SYSTEM_SUBSCRIPTION passa direto.
import type { CheckoutContext, PlanRow, HandlerFailure } from "./context.ts";

export async function assertCanContractPlan(
  _ctx: CheckoutContext,
  _plan: PlanRow,
): Promise<{ ok: true } | HandlerFailure> {
  return { ok: true };
}

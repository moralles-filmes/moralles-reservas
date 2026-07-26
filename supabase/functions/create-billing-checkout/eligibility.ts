// Elegibilidade por categoria de plano.
//
// Só WHATSAPP_SUBSCRIPTION tem regra própria na Fase 5a. SYSTEM_SUBSCRIPTION
// passa direto: as condições dele (org existe, plano ativo, não é one_time) já
// foram verificadas no handler.

import { jsonLog } from "../_shared/security.ts";
import { checkFlagEnabled } from "../_shared/platform-flags.ts";
import { resolveOrgEntitlements } from "../_shared/entitlements.ts";
import { canContractInstance, type InstanceBlockReason } from "../_shared/whatsapp-implementation-core.ts";
import { supabase, type CheckoutContext, type PlanRow, type HandlerFailure } from "./context.ts";

const BLOCK_MESSAGE: Record<InstanceBlockReason, { status: number; error: string }> = {
  flag_off: {
    status: 403,
    error: "A contratação da mensalidade da instância ainda não está disponível.",
  },
  implementation_incomplete: {
    status: 409,
    error: "A mensalidade da instância só pode ser contratada depois que a implantação for concluída.",
  },
  system_not_allowed: {
    status: 409,
    error: "Regularize a assinatura do sistema antes de contratar a automação do WhatsApp.",
  },
  already_subscribed: {
    status: 409,
    error: "Esta empresa já tem a mensalidade da instância ativa.",
  },
  override_active: {
    // Cobrar quem tem cortesia é pior que negar a venda.
    status: 409,
    error: "O WhatsApp desta empresa já está liberado pela plataforma, sem cobrança mensal.",
  },
};

export async function assertCanContractPlan(
  ctx: CheckoutContext,
  plan: PlanRow,
): Promise<{ ok: true } | HandlerFailure> {
  if (plan.category !== "WHATSAPP_SUBSCRIPTION") return { ok: true };

  // Barato primeiro: a flag é leitura de cache (sem I/O na maioria das
  // chamadas), as outras três checagens abaixo fazem consulta ao banco. Não
  // vale a pena gastar três round-trips pra descobrir no fim que a flag está
  // OFF.
  const flag = await checkFlagEnabled("whatsapp_subscription_checkout");

  const [implRes, entitlements, subsRes] = await Promise.all([
    supabase
      .from("whatsapp_implementations")
      .select("operational_status")
      .eq("organization_id", ctx.organizationId)
      .neq("operational_status", "CANCELED")
      .maybeSingle(),
    resolveOrgEntitlements(supabase, ctx.organizationId),
    supabase
      .from("billing_subscriptions")
      .select("id, billing_plans!inner(category)")
      .eq("organization_id", ctx.organizationId)
      .neq("status", "canceled")
      .eq("billing_plans.category", "WHATSAPP_SUBSCRIPTION"),
  ]);

  // Falha de leitura aqui tem direção OPOSTA à de billing-category.ts: lá um
  // erro que vira "sim" deixa passar um evento indevido; aqui um erro que vira
  // "pode contratar" deixa passar uma COMPRA indevida (ex.: implantação
  // incompleta lida como "sem linha" liberaria a mensalidade antes da entrega).
  // Prefere-se barrar em dúvida — o cliente tenta de novo; o log garante que a
  // falha não fica muda.
  if (implRes.error) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "instance_eligibility_impl_read_failed",
      orgId: ctx.organizationId,
      err: implRes.error.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar a implantação da empresa." };
  }
  if (subsRes.error) {
    jsonLog("error", {
      reqId: ctx.reqId,
      evt: "instance_eligibility_subs_read_failed",
      orgId: ctx.organizationId,
      err: subsRes.error.message,
    });
    return { ok: false, status: 500, error: "Falha ao consultar as assinaturas da empresa." };
  }

  const verdict = canContractInstance({
    flagEnabled: flag.enabled,
    implementationOperationalStatus:
      (implRes.data?.operational_status as never) ?? null,
    systemAllowed: entitlements.system.allowed,
    hasActiveWhatsappSubscription: (subsRes.data ?? []).length > 0,
    // `source === "override"` distingue cortesia de assinatura paga — as duas
    // dão allowed=true, e só a primeira impede a venda.
    hasActiveWhatsappOverride:
      entitlements.whatsapp.allowed && entitlements.whatsapp.source === "override",
  });

  if (verdict.ok) return { ok: true };

  jsonLog("info", {
    reqId: ctx.reqId,
    evt: "instance_checkout_blocked",
    orgId: ctx.organizationId,
    reason: verdict.reason,
  });
  const msg = BLOCK_MESSAGE[verdict.reason!];
  return { ok: false, status: msg.status, error: msg.error };
}

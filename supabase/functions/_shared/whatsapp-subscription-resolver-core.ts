/**
 * Nucleo PURO: qual assinatura financia o WhatsApp de uma organizacao.
 * ZERO IMPORTS.
 *
 * Substitui a query com `.maybeSingle()` que existia em DOIS lugares
 * (whatsapp-service-gate.ts e process-whatsapp-enforcement/index.ts) e que
 * precisava ser mantida campo-a-campo identica por disciplina humana. A
 * garantia passa a ser estrutural: os dois chamam esta funcao, e um guardrail
 * estatico prova que continuam chamando.
 *
 * `.maybeSingle()` LANCA com mais de uma linha — e a transicao entre o modelo
 * antigo e o de dois planos produz exatamente duas linhas elegiveis.
 *
 * NAO decide se o servico esta ativo (isso e do gate de sete estados). Decide
 * QUAL assinatura e a fonte financeira, e se ha ambiguidade.
 */

const FUNDING_STATUSES = new Set(["active", "trialing", "past_due"]);
const WHATSAPP_CATEGORY = "WHATSAPP_SUBSCRIPTION";
const SYSTEM_CATEGORY = "SYSTEM_SUBSCRIPTION";

/**
 * Precedencia de continuidade. Menor vence. Independente da ordem das linhas,
 * de created_at e da posicao no array — o PostgREST nao garante ordem sem
 * ORDER BY, e gate e worker podem receber as mesmas linhas em ordens
 * diferentes.
 */
const STATUS_RANK: Record<string, number> = { active: 0, trialing: 1, past_due: 2 };

export interface WhatsAppSubscriptionFact {
  id: string;
  status: string;
  category: string;
  includedFeatures: string[];
  canceledAt: string | null;
  suspendedAt: string | null;
}

export interface WhatsAppSubscriptionInput {
  subscriptions: WhatsAppSubscriptionFact[];
}

export type WhatsAppSubscriptionSource = "PLAN_INCLUDED" | "LEGACY_CATEGORY" | "TRANSITION";

export type WhatsAppSubscriptionResolution =
  | {
      kind: "RESOLVED";
      source: WhatsAppSubscriptionSource;
      subscriptionId: string;
      status: string;
      canceledAt: string | null;
      suspendedAt: string | null;
      /** Fail-closed so para PROVISIONAMENTO NOVO; envio existente segue. */
      provisioningAmbiguous: boolean;
      adminPendency: "LEGACY_WHATSAPP_SUBSCRIPTION_OPEN" | null;
      /** Ordem canonica (id crescente) — insensivel a ordem de entrada. */
      candidateIds: string[];
    }
  | { kind: "NONE" }
  | { kind: "AMBIGUOUS"; reasonCode: "DUPLICATE_SAME_CATEGORY"; candidateIds: string[] };

const canonical = (ids: string[]): string[] => [...ids].sort();

export function resolveWhatsAppSubscription(
  input: WhatsAppSubscriptionInput,
): WhatsAppSubscriptionResolution {
  const funding = input.subscriptions.filter((s) => FUNDING_STATUSES.has(s.status));

  const legacy = funding.filter((s) => s.category === WHATSAPP_CATEGORY);

  // ESTRITO: so SYSTEM_SUBSCRIPTION vira PLAN_INCLUDED. Um array preenchido
  // por engano num plano CUSTOM/TRIAL/AI_CREDIT_PACKAGE/WHATSAPP_IMPLEMENTATION
  // nao pode virar fonte financeira do WhatsApp.
  const included = funding.filter(
    (s) => s.category === SYSTEM_CATEGORY && s.includedFeatures.includes("whatsapp"),
  );

  // D — duplicidade inesperada DENTRO da mesma categoria: erro/revisao.
  if (legacy.length > 1) {
    return {
      kind: "AMBIGUOUS",
      reasonCode: "DUPLICATE_SAME_CATEGORY",
      candidateIds: canonical(legacy.map((s) => s.id)),
    };
  }
  if (included.length > 1) {
    return {
      kind: "AMBIGUOUS",
      reasonCode: "DUPLICATE_SAME_CATEGORY",
      candidateIds: canonical(included.map((s) => s.id)),
    };
  }

  const legacyOne = legacy[0] ?? null;
  const includedOne = included[0] ?? null;

  if (!legacyOne && !includedOne) return { kind: "NONE" };

  // C — transicao. Continuidade do servico pela MELHOR posicao de status;
  // empate resolve pelo modelo NOVO, deterministicamente.
  if (legacyOne && includedOne) {
    const rankInc = STATUS_RANK[includedOne.status] ?? Number.MAX_SAFE_INTEGER;
    const rankLeg = STATUS_RANK[legacyOne.status] ?? Number.MAX_SAFE_INTEGER;
    const chosen = rankLeg < rankInc ? legacyOne : includedOne;
    return {
      kind: "RESOLVED",
      source: "TRANSITION",
      subscriptionId: chosen.id,
      status: chosen.status,
      canceledAt: chosen.canceledAt,
      suspendedAt: chosen.suspendedAt,
      provisioningAmbiguous: true,
      adminPendency: "LEGACY_WHATSAPP_SUBSCRIPTION_OPEN",
      candidateIds: canonical([legacyOne.id, includedOne.id]),
    };
  }

  const one = legacyOne ?? includedOne!;
  return {
    kind: "RESOLVED",
    source: legacyOne ? "LEGACY_CATEGORY" : "PLAN_INCLUDED",
    subscriptionId: one.id,
    status: one.status,
    canceledAt: one.canceledAt,
    suspendedAt: one.suspendedAt,
    provisioningAmbiguous: false,
    adminPendency: null,
    candidateIds: [one.id],
  };
}

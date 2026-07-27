/**
 * Núcleo PURO da correlação de um evento financeiro do Asaas com a
 * organização, a assinatura e o plano dele.
 *
 * ZERO dependências (sem Deno, sem supabase-js) — importável pelas Edge
 * Functions e pelo vitest do frontend (src/lib/billing-correlation-core.test.ts),
 * que é o único lugar onde isto roda em CI (Deno não está instalado).
 *
 * A CAMADA DE I/O levanta os candidatos (cada um é uma consulta ao banco); este
 * módulo só decide. Nenhuma correlação por valor, data aproximada ou
 * "assinatura mais recente" — só identificadores do provedor.
 *
 * REDEPLOY: consumido por asaas-billing-events-apply.ts; ver o checklist do
 * CLAUDE.md para a lista de Edge Functions que precisam voltar juntas.
 */

// `import type` — não emite nada em runtime, então não quebra a regra de
// núcleo puro (zero Deno, zero supabase-js, zero rede). asaas-billing-events.ts
// também é núcleo puro (mesmo cabeçalho de garantia), então essa dependência é
// legal: puro importando puro.
import type { AsaasPurpose } from "./asaas-billing-events.ts";

export type CorrelationSource =
  | "known_invoice"
  | "provider_subscription"
  | "external_reference"
  | "checkout_session"
  | "billing_customer";

/**
 * Ordem da escada. Menor número vence. A ordem é por QUANTO cada fonte resolve
 * com certeza, não por conveniência:
 *  1. fatura já conhecida — a linha já existe aqui, tem tudo;
 *  2. assinatura do provedor — é o ÚNICO elo que a renovação do mês 2+ carrega;
 *  3. referência externa — presente na cobrança direta, ausente no checkout;
 *  4. sessão de checkout — traz org, plano e propósito da 1ª cobrança;
 *  5. cliente do provedor — resolve só a organização, e no checkout hospedado
 *     o pagador gera um cliente NOVO, então nem sempre resolve.
 */
export const CORRELATION_RANK: Record<CorrelationSource, number> = {
  known_invoice: 1,
  provider_subscription: 2,
  external_reference: 3,
  checkout_session: 4,
  billing_customer: 5,
};

export interface CorrelationCandidate {
  source: CorrelationSource;
  organizationId: string | null;
  /** id interno de billing_subscriptions, não o `sub_…` do provedor. */
  subscriptionId: string | null;
  planId: string | null;
  /**
   * `null` ≠ "purpose desconhecido" — significa "este degrau não carrega
   * purpose nenhum" (ex.: provider_subscription só traz o id da assinatura, e
   * isso é legítimo). Um purpose que não bate com `AsaasPurpose` é INVÁLIDO,
   * não ausente: é barrado na fronteira (via `isAsaasPurpose`, em
   * asaas-billing-events.ts) antes de virar um `CorrelationCandidate` — nunca
   * chega aqui como string solta. Não trocar de volta para `string | null`.
   */
  purpose: AsaasPurpose | null;
}

export type CorrelationOutcome =
  | {
      kind: "resolved";
      organizationId: string;
      subscriptionId: string | null;
      planId: string | null;
      purpose: AsaasPurpose | null;
      /** Degraus que contribuíram com algum campo, do mais forte ao mais fraco. */
      via: CorrelationSource[];
      /** Degraus que discordaram em plano/purpose. Não é fatal; é para log. */
      softDivergence: CorrelationSource[];
    }
  | { kind: "unresolved"; reason: "no_candidate" }
  | {
      kind: "conflict";
      reason: "organization_divergence";
      sources: { source: CorrelationSource; organizationId: string }[];
    };

export function resolveCorrelation(candidates: CorrelationCandidate[]): CorrelationOutcome {
  const ordered = [...candidates].sort(
    (a, b) => CORRELATION_RANK[a.source] - CORRELATION_RANK[b.source],
  );

  // Divergência de ORGANIZAÇÃO é fatal e é checada ANTES de qualquer outra
  // coisa: escrever no tenant errado é pior que atrasar um pagamento. Candidato
  // sem organização não participa — ele não discorda, ele não sabe.
  const withOrg = ordered.filter(
    (x): x is CorrelationCandidate & { organizationId: string } => !!x.organizationId,
  );
  const distinctOrgs = new Set(withOrg.map((x) => x.organizationId));
  if (distinctOrgs.size > 1) {
    return {
      kind: "conflict",
      reason: "organization_divergence",
      sources: withOrg.map((x) => ({ source: x.source, organizationId: x.organizationId })),
    };
  }

  if (withOrg.length === 0) {
    return { kind: "unresolved", reason: "no_candidate" };
  }

  const organizationId = withOrg[0].organizationId;
  let subscriptionId: string | null = null;
  let planId: string | null = null;
  let purpose: AsaasPurpose | null = null;
  const via: CorrelationSource[] = [];
  const softDivergence: CorrelationSource[] = [];

  for (const cand of ordered) {
    let contributed = cand.organizationId === organizationId;

    if (cand.subscriptionId) {
      if (subscriptionId === null) {
        subscriptionId = cand.subscriptionId;
        contributed = true;
      } else if (subscriptionId !== cand.subscriptionId) {
        softDivergence.push(cand.source);
      }
    }
    if (cand.planId) {
      if (planId === null) {
        planId = cand.planId;
        contributed = true;
      } else if (planId !== cand.planId) {
        softDivergence.push(cand.source);
      }
    }
    if (cand.purpose) {
      if (purpose === null) {
        purpose = cand.purpose;
        contributed = true;
      } else if (purpose !== cand.purpose) {
        softDivergence.push(cand.source);
      }
    }

    if (contributed && !via.includes(cand.source)) via.push(cand.source);
  }

  return { kind: "resolved", organizationId, subscriptionId, planId, purpose, via, softDivergence };
}

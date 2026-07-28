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

/**
 * Resultado de comparar o carimbo de `billing_events.organization_id` de uma
 * passagem ANTERIOR do aplicador com o resultado da escada NESTA passagem.
 *
 * `MATCH` cobre dois casos: não há carimbo anterior (nada a comparar) OU o
 * carimbo bate com a organização resolvida agora.
 */
export type PreviousStampComparison =
  | { status: "MATCH" }
  | {
      status: "DIVERGENT_NEW_RESULT_WINS";
      previousOrganizationId: string;
      resolvedOrganizationId: string;
    }
  | {
      status: "DIVERGENT_REQUIRES_REVIEW";
      previousOrganizationId: string;
      resolvedOrganizationId?: string;
      reason: string;
    };

/**
 * Compara o carimbo anterior de `billing_events.organization_id` (só existe em
 * REPROCESSAMENTO — `asaas-webhook` sempre insere a linha com `organization_id:
 * null` e é o UPDATE pós-`applyAsaasEvent` que carimba o resultado; o
 * `process-asaas-reconcile` é quem lê esse carimbo de volta e o repassa) com o
 * resultado ATUAL da escada de correlação, ANTES do aplicador escrever
 * qualquer efeito financeiro.
 *
 * DECISÃO DO DONO (Fix round 1, achado Important #2): o carimbo NUNCA volta a
 * ser candidato de `resolveCorrelation` — a escada continua sendo a ÚNICA
 * fonte autoritativa. Ele serve só como DETECTOR de divergência a posteriori:
 * fonte atual determinística vence carimbo histórico; histórico nunca pode
 * impedir para sempre uma correção segura (por isso a review é um sinal, não
 * um bloqueio permanente — a próxima passagem pode resolver diferente de novo,
 * e cada uma é reavaliada do zero).
 *
 * `previousSource` é a fonte (`CorrelationSource`) que produziu o carimbo
 * anterior. HOJE sempre chega `undefined`: não persistimos a fonte anterior em
 * lugar nenhum — `billing_events` só guarda a coluna `organization_id`, não
 * qual degrau a resolveu. O parâmetro existe porque o contrato já aceita essa
 * informação para quando ela existir; enquanto não existir, o ramo "carimbo de
 * rank superior à fonte vencedora atual" (ver `DIVERGENT_REQUIRES_REVIEW`
 * abaixo) fica inalcançável NA PRÁTICA — e é para ficar assim: não crie coluna
 * nova, não invente um jeito de adivinhar a fonte anterior, e não force esse
 * ramo a disparar hoje.
 */
export function comparePreviousStamp(
  previousOrganizationId: string | null,
  correlation: CorrelationOutcome,
  previousSource?: CorrelationSource,
): PreviousStampComparison {
  // Sem carimbo anterior, não há do que divergir — MATCH incondicional, ANTES
  // de olhar pro `kind` da escada (inclusive antes de `conflict`: o tipo exige
  // `previousOrganizationId: string` de verdade nos dois ramos DIVERGENT_*, e
  // é este `if` que garante essa invariante pro resto da função).
  if (!previousOrganizationId) {
    return { status: "MATCH" };
  }

  if (correlation.kind === "conflict") {
    // Defesa de TOTALIDADE DO TIPO: por construção, o aplicador já retornou
    // (via `failWith`, após avisar o admin) antes de chamar este helper quando
    // a escada conflita — este ramo não é alcançado em produção hoje. Mas o
    // carimbo NUNCA desempata ambiguidade entre degraus da MESMA passagem, e
    // esta função continua correta mesmo que um caller futuro a chame sem ter
    // retornado antes: a resposta certa é sempre "revisão", nunca "aplica
    // sozinho escolhendo um lado".
    return {
      status: "DIVERGENT_REQUIRES_REVIEW",
      previousOrganizationId,
      reason: "escada em conflito de organização nesta passagem — carimbo anterior não desempata ambiguidade",
    };
  }

  if (correlation.kind === "unresolved") {
    // A escada não achou organização NENHUMA nesta passagem. O carimbo NÃO É
    // APAGADO por este resultado — quem decide isso é o aplicador (que
    // simplesmente não sobrescreve `organizationId` fora do ramo `resolved`);
    // aqui só sinalizamos que a resolução determinística falhou desta vez.
    return {
      status: "DIVERGENT_REQUIRES_REVIEW",
      previousOrganizationId,
      reason: "escada não resolveu nenhuma organização nesta passagem",
    };
  }

  // kind === "resolved" daqui pra baixo — os dois ramos anteriores já
  // retornaram.
  if (correlation.organizationId === previousOrganizationId) {
    return { status: "MATCH" };
  }

  // `via[0]` é sempre o degrau de rank mais forte (menor número) que
  // contribuiu nesta resolução: `resolveCorrelation` popula `via` iterando
  // `ordered` (já ordenado por `CORRELATION_RANK` ascendente) e empurra em
  // ordem de encontro — o primeiro elemento é, por construção, o de rank mais
  // alto, e em `resolved` o array nunca vem vazio (`withOrg.length >= 1` é
  // pré-condição de `resolved`, e esse candidato sempre contribui a própria
  // organização).
  const winningSource = correlation.via[0];
  const winningRank = CORRELATION_RANK[winningSource];
  const previousRank = previousSource ? CORRELATION_RANK[previousSource] : null;

  if (previousRank !== null && previousRank < winningRank) {
    // Fonte anterior CONHECIDA e de rank SUPERIOR (número menor = mais forte)
    // à fonte que venceu agora. A nova resolução é MENOS confiável que o
    // vínculo histórico — sinaliza para revisão em vez de trocar o tenant
    // sozinha. Inalcançável hoje (`previousSource` sempre `undefined`, ver
    // JSDoc da função) — mantido para quando a fonte anterior passar a ser
    // persistida.
    return {
      status: "DIVERGENT_REQUIRES_REVIEW",
      previousOrganizationId,
      resolvedOrganizationId: correlation.organizationId,
      reason: `fonte anterior (${previousSource}, rank ${previousRank}) é mais confiável que a fonte vencedora atual (${winningSource}, rank ${winningRank}) — requer revisão antes de trocar a organização carimbada`,
    };
  }

  // Fonte atual é determinística e não perde para uma fonte anterior mais
  // forte (porque não há fonte anterior conhecida, ou porque ela é de rank
  // igual/inferior à vencedora atual) — corrige o carimbo. Histórico não pode
  // travar uma correção segura para sempre.
  return {
    status: "DIVERGENT_NEW_RESULT_WINS",
    previousOrganizationId,
    resolvedOrganizationId: correlation.organizationId,
  };
}

// Decisão dos efeitos de negócio dos eventos Asaas — NÚCLEO PURO (zero
// imports, zero Deno.*), testado em src/lib/asaas-billing-events.test.ts.
//
// O aplicador de I/O (`applyAsaasEvent`) mora em asaas-billing-events-apply.ts
// — arquivo IRMÃO, não seção deste. Um import (mesmo só de tipo) de
// `https://esm.sh/@supabase/supabase-js` neste módulo quebra a resolução do
// Vite para quem importa o núcleo puro (`Only URLs with a scheme in: file and
// data are supported by the default ESM loader`), então a metade de I/O foi
// deliberadamente extraída — mesmo particionamento de asaas-core.ts (puro) /
// asaas.ts (I/O).
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito:
// quando `processing_status='processed'` passou a significar "assinatura
// ativada", o reconcile precisou executar a MESMA lógica — senão marca como
// resolvido um evento que nunca ativou nada.

// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO PURO
// ─────────────────────────────────────────────────────────────────────────────

/** Espelha o CHECK de billing_invoices.purpose (migration 063). */
export type AsaasPurpose = "subscription" | "implementation" | "ai_topup" | "other";

const PURPOSES: ReadonlySet<string> = new Set<AsaasPurpose>([
  "subscription",
  "implementation",
  "ai_topup",
  "other",
]);

/** Type guard do purpose. Fonte única: o Set `PURPOSES` acima, que espelha o
 *  CHECK de billing_invoices.purpose (063). Valor vindo do banco ou do provedor
 *  passa por aqui ANTES de entrar em qualquer estrutura tipada. */
export function isAsaasPurpose(value: unknown): value is AsaasPurpose {
  return typeof value === "string" && PURPOSES.has(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExternalReferenceParts {
  orgId: string;
  planId: string | null;
  purpose: AsaasPurpose;
}

/**
 * Correlação que viaja até o Asaas e volta no webhook. Cabe no limite de 200
 * chars de `externalReference` (§9): 3 UUIDs + rótulos ≈ 110.
 */
export function buildExternalReference(parts: ExternalReferenceParts): string {
  return `org:${parts.orgId}|plan:${parts.planId ?? "none"}|purpose:${parts.purpose}`;
}

/**
 * Parse defensivo: é dado NOSSO voltando de terceiro, então qualquer shape
 * inesperado vira `null` e o caller cai nos fallbacks (provider_payment_id,
 * asaas_customer_id). Nunca lança.
 */
export function parseExternalReference(raw: unknown): ExternalReferenceParts | null {
  if (typeof raw !== "string" || !raw) return null;

  const match = /^org:([^|]+)\|plan:([^|]+)\|purpose:([^|]+)$/.exec(raw);
  if (!match) return null;

  const [, orgId, planRaw, purpose] = match;
  if (!UUID_RE.test(orgId)) return null;
  if (planRaw !== "none" && !UUID_RE.test(planRaw)) return null;
  if (!isAsaasPurpose(purpose)) return null;

  return {
    orgId,
    planId: planRaw === "none" ? null : planRaw,
    purpose,
  };
}

export type AsaasEffectKind =
  | "activate_subscription"
  | "mark_invoice_overdue"
  | "record_refund"
  | "upsert_open_invoice"
  | "noop"
  | "unknown";

export interface EventDecisionInput {
  eventType: string;
  /** billing_invoices.status atual: draft|open|paid|void|uncollectible, ou null. */
  invoiceStatus: string | null;
}

export interface AsaasEffect {
  kind: AsaasEffectKind;
  /** Motivo legível — vai pro log e pro billing_events.error_message. */
  reason: string;
}

/**
 * Eventos que liberam acesso. São DOIS de propósito.
 *
 * `PAYMENT_CONFIRMED` = pago, saldo ainda indisponível.
 * `PAYMENT_RECEIVED`  = liquidado.
 *
 * O cartão emite os dois (RECEIVED até ~30 dias depois). PIX e boleto pulam o
 * CONFIRMED e vão direto pro RECEIVED — provado por teste ao vivo em 18/07/2026
 * (§5 do doc 03). Escutar só CONFIRMED deixaria todo cliente de PIX/boleto
 * pagando sem receber acesso, e funcionaria no cartão — bug silencioso e
 * enganoso. Ativar nos dois exige idempotência, que é o `invoiceStatus==='paid'`
 * logo abaixo.
 */
// Exportado (além de usado abaixo) pra que o teste do catálogo REVERSO em
// src/lib/asaas-billing-events.test.ts enumere os ativadores sem redeclará-los:
// todo evento aqui TEM que estar no catálogo de asaas-core.ts, senão o
// short-circuit do asaas-webhook o carimba 'ignored' e a ativação some.
export const ACTIVATING_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
]);

/**
 * Estorno e chargeback. Lista EXPLÍCITA, nunca `startsWith`:
 * `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` não começa com `PAYMENT_CHARGEBACK_`
 * e um matcher por prefixo o perderia (armadilha registrada no §4 do doc 03).
 */
// Exportado pelo mesmo motivo de ACTIVATING_EVENTS: o teste do catálogo
// REVERSO enumera estes eventos acionáveis (kind='record_refund') e prova que
// todos vivem no catálogo de asaas-core.ts.
export const REFUND_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  // Estorno de recebimento em dinheiro (baixa manual desfeita) — dinheiro que
  // tinha sido registrado como recebido deixa de estar. Mesmo efeito de
  // negócio que um estorno normal: precisa reverter, não é um `noop`.
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
]);

/**
 * Eventos reconhecidos que não geram efeito. Distinguir de `unknown` importa:
 * `noop` é "conhecido, nada a fazer" e vira `processing_status='processed'`;
 * `unknown` vira `'ignored'` e é sinal de que o catálogo mudou.
 */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_UPDATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_AWAITING_RISK_ANALYSIS",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_ANTICIPATED",
  "PAYMENT_DELETED",
  "PAYMENT_RESTORED",
  // O pagamento continua de pé — só o PEDIDO de estorno foi negado pelo
  // Asaas. NÃO entra em REFUND_EVENTS: não há dinheiro a reverter aqui.
  "PAYMENT_REFUND_DENIED",
  "PAYMENT_DUNNING_RECEIVED",
  "PAYMENT_DUNNING_REQUESTED",
  "PAYMENT_BANK_SLIP_CANCELLED",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
  // Família `*_SPLIT_*` (payment e subscription): split payment do Asaas não é
  // usado por este produto — nenhum efeito de negócio nosso depende disso.
  "PAYMENT_SPLIT_CANCELLED",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_SPLIT_DISABLED",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK_FINISHED",
]);

const TERMINAL_INVOICE_STATUSES: ReadonlySet<string> = new Set(["paid", "void"]);

/**
 * CONTRATO com quem consome `AsaasEffect` (asaas-webhook, process-asaas-reconcile):
 *
 * 1. Ao tratar `kind === "activate_subscription"`, o consumidor DEVE SEMPRE
 *    transicionar a invoice correlacionada para `paid` — e se não existir
 *    nenhuma invoice correlacionada, DEVE criar uma já em `paid`. A
 *    idempotência do segundo evento do cartão (`PAYMENT_CONFIRMED` seguido
 *    de `PAYMENT_RECEIVED`, até ~30 dias depois) depende INTEIRAMENTE dessa
 *    escrita: é o `invoiceStatus ∈ {paid, void}` abaixo que faz o segundo
 *    evento virar `noop` em vez de reativar (inofensivo) ou, pior, mascarar
 *    a ausência de registro do pagamento. Pular esse UPDATE/INSERT quebra
 *    silenciosamente essa garantia — o próximo evento do mesmo pagamento não
 *    vai encontrar `invoiceStatus` terminal e vai reprocessar como se fosse
 *    a primeira vez.
 *
 * 2. `decideEventEffect` NÃO enxerga `purpose` — só recebe `invoiceStatus`.
 *    Antes de conceder qualquer coisa, o consumidor DEVE resolver `purpose`
 *    via `parseExternalReference` e tratar `activate_subscription` como DOIS
 *    passos com gates diferentes:
 *    - SEMPRE: registrar o dinheiro (obrigação 1 acima — a invoice vira
 *      `paid` não importa o `purpose`);
 *    - SOMENTE quando `purpose === "subscription"`: conceder acesso, ou
 *      seja, ativar a assinatura e mexer em `organizations.billing_status`.
 *    Sem esse segundo gate, um `PAYMENT_RECEIVED` liquidado de uma compra
 *    avulsa de crédito de IA (`purpose: "ai_topup"`) reativaria o acesso ao
 *    sistema de uma organização com a mensalidade em atraso.
 *
 * 3. `kind === "mark_invoice_overdue"` pode chegar com nenhuma invoice
 *    correlacionada (`invoiceStatus === null`). O consumidor DEVE tratar
 *    esse caso como no-op, não como erro: a cobrança existe no Asaas mas não
 *    temos registro dela aqui, e fechar essa lacuna é papel do worker
 *    `process-asaas-reconcile`, não deste evento.
 *
 * 4. `kind === "upsert_open_invoice"` só escreve quando a flag
 *    `billing_invoice_ingestion` está ligada; com ela desligada o consumidor
 *    trata como `noop` e o evento sai `processed` mesmo assim — a flag gateia
 *    a ESCRITA, não a classificação do evento.
 */
export function decideEventEffect(input: EventDecisionInput): AsaasEffect {
  const { eventType, invoiceStatus } = input;

  if (ACTIVATING_EVENTS.has(eventType)) {
    // Idempotência: o segundo evento do cartão encontra a invoice já paga.
    if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
      if (invoiceStatus === "void") {
        // Anomalia, não duplicata benigna: um pagamento chegou sobre uma
        // cobrança que já tinha sido anulada. Precisa de conferência humana,
        // não é o caminho feliz do cartão emitindo CONFIRMED+RECEIVED.
        return {
          kind: "noop",
          reason: `Invoice está 'void' — pagamento recebido sobre cobrança anulada, requer conferência.`,
        };
      }
      return {
        kind: "noop",
        reason: `Invoice já em '${invoiceStatus}' — ${eventType} duplicado ou tardio.`,
      };
    }
    // Qualquer outro estado ativa. Errar para o lado de REGISTRAR o dinheiro é
    // o lado seguro: o aplicador usa UPDATE condicional, então repetir a
    // ativação é inofensiva, enquanto descartar um pagamento genuíno bloqueia
    // um cliente que pagou. Cobre inclusive `invoiceStatus === null` na
    // renovação mensal (cobrança nova, ainda sem linha de invoice
    // correlacionada) — não é "nada a fazer".
    return { kind: "activate_subscription", reason: `${eventType} libera o acesso.` };
  }

  if (eventType === "PAYMENT_OVERDUE") {
    if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
      return { kind: "noop", reason: `Invoice em '${invoiceStatus}' — vencimento irrelevante.` };
    }
    return { kind: "mark_invoice_overdue", reason: "Cobrança vencida." };
  }

  if (REFUND_EVENTS.has(eventType)) {
    return { kind: "record_refund", reason: `${eventType} — registra estorno/chargeback.` };
  }

  if (eventType === "PAYMENT_CREATED") {
    // Já existe linha para esta cobrança: nada a criar. Vale tanto para a
    // fatura em aberto (webhook duplicado, reconcile passou antes) quanto para
    // a terminal (evento tardio sobre cobrança já liquidada).
    if (invoiceStatus) {
      return { kind: "noop", reason: `Invoice já em '${invoiceStatus}' — cobrança já registrada.` };
    }
    // ESTE é o elo que faltava: sem ele a cobrança da renovação nunca vira
    // fatura interna, o PAYMENT_OVERDUE seguinte não acha linha para marcar, e
    // process-billing-overdue roda sobre entrada vazia para sempre.
    return { kind: "upsert_open_invoice", reason: "Cobrança criada no provedor — registrar fatura em aberto." };
  }

  if (INFORMATIONAL_EVENTS.has(eventType)) {
    return { kind: "noop", reason: `${eventType} é informativo.` };
  }

  return { kind: "unknown", reason: `Evento fora do catálogo conhecido: ${eventType}.` };
}

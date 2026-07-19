// Decisão e aplicação dos efeitos de negócio dos eventos Asaas.
//
// COMPARTILHADO por asaas-webhook e process-asaas-reconcile de propósito:
// quando `processing_status='processed'` passou a significar "assinatura
// ativada", o reconcile precisou executar a MESMA lógica — senão marca como
// resolvido um evento que nunca ativou nada.
//
// A metade de cima é PURA (zero imports, zero Deno.*) e testada em
// src/lib/asaas-billing-events.test.ts. A metade de baixo faz I/O e nunca é
// importada por src/.

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
  if (!PURPOSES.has(purpose)) return null;

  return {
    orgId,
    planId: planRaw === "none" ? null : planRaw,
    purpose: purpose as AsaasPurpose,
  };
}

export type AsaasEffectKind =
  | "activate_subscription"
  | "mark_invoice_paid"
  | "mark_invoice_overdue"
  | "record_refund"
  | "noop"
  | "unknown";

export interface EventDecisionInput {
  eventType: string;
  /** billing_invoices.status atual: draft|open|paid|void|uncollectible, ou null. */
  invoiceStatus: string | null;
  /** billing_subscriptions.status atual, ou null se ainda não existe. */
  subscriptionStatus: string | null;
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
const ACTIVATING_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
]);

/**
 * Estorno e chargeback. Lista EXPLÍCITA, nunca `startsWith`:
 * `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` não começa com `PAYMENT_CHARGEBACK_`
 * e um matcher por prefixo o perderia (armadilha registrada no §4 do doc 03).
 */
const REFUND_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_REFUNDED",
  "PAYMENT_PARTIALLY_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
]);

/**
 * Eventos reconhecidos que não geram efeito. Distinguir de `unknown` importa:
 * `noop` é "conhecido, nada a fazer" e vira `processing_status='processed'`;
 * `unknown` vira `'ignored'` e é sinal de que o catálogo mudou.
 */
const INFORMATIONAL_EVENTS: ReadonlySet<string> = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_AWAITING_RISK_ANALYSIS",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
  "PAYMENT_ANTICIPATED",
  "CHECKOUT_CREATED",
  "CHECKOUT_PAID",
  "CHECKOUT_CANCELED",
  "CHECKOUT_EXPIRED",
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED",
  "SUBSCRIPTION_DELETED",
]);

const TERMINAL_INVOICE_STATUSES: ReadonlySet<string> = new Set(["paid", "void"]);

export function decideEventEffect(input: EventDecisionInput): AsaasEffect {
  const { eventType, invoiceStatus, subscriptionStatus } = input;

  if (ACTIVATING_EVENTS.has(eventType)) {
    // Idempotência: o segundo evento do cartão encontra a invoice já paga.
    if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
      return {
        kind: "noop",
        reason: `Invoice já em '${invoiceStatus}' — ${eventType} duplicado ou tardio.`,
      };
    }
    if (subscriptionStatus === "active" && invoiceStatus === null) {
      return { kind: "noop", reason: "Assinatura já ativa e sem invoice pendente." };
    }
    if (invoiceStatus === null && subscriptionStatus === null) {
      return {
        kind: "mark_invoice_paid",
        reason: `${eventType} sem assinatura correlacionada — registra pagamento.`,
      };
    }
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

  if (INFORMATIONAL_EVENTS.has(eventType)) {
    return { kind: "noop", reason: `${eventType} é informativo.` };
  }

  return { kind: "unknown", reason: `Evento fora do catálogo conhecido: ${eventType}.` };
}

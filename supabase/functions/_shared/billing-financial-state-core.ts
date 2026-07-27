/**
 * Núcleo PURO que traduz o mundo do provedor em estado financeiro interno.
 *
 * POR QUE EXISTE: `active`, `past_due`, `unpaid`, `RECEIVED`, `CONFIRMED`,
 * `OVERDUE` são vocabulário do Asaas e do Stripe. Deixar esses nomes vazarem
 * para o núcleo de decisão amarra a regra de negócio ao provedor da vez — e a
 * migração Stripe→Asaas em curso é a prova de que ele muda.
 *
 * Importa APENAS outro núcleo puro (billing-delinquency-core.ts), de onde vêm a
 * escada de dias e as contas de data em BRT. Nenhum import de Deno ou
 * supabase-js: isto roda em vitest, que é o único CI que alcança esta lógica.
 */

import {
  BLOCK_AFTER_DAYS,
  GRACE_PERIOD_DAYS,
  addDaysToDate,
  daysOverdue,
  todayBrt,
} from "./billing-delinquency-core.ts";

export type FinancialState =
  /** Não existe assinatura da categoria para esta organização. */
  | "NO_SUBSCRIPTION"
  /** Em dia: sem fatura vencida em aberto. */
  | "PAID"
  /** Vencida, dentro da tolerância (D+1..D+5). */
  | "IN_GRACE"
  /** Vencida além da tolerância (D+6 em diante) — suspender. */
  | "OVERDUE_BEYOND_GRACE"
  /** Assinatura cancelada. */
  | "CANCELED";

export interface FinancialStateInput {
  /** ISO. Injetável nos testes; a camada de I/O passa `new Date().toISOString()`. */
  now: string;
  /** billing_subscriptions.status, ou null quando não há assinatura. */
  subscriptionStatus: string | null;
  canceledAt: string | null;
  /**
   * Fatura em aberto mais ANTIGA da assinatura. A camada de I/O já exclui as
   * que estão com `enforcement_hold` — fatura retida para revisão não conta
   * como atraso, por definição.
   */
  oldestOpenInvoice: { dueDate: string; status: string } | null;
}

export interface FinancialStateResult {
  state: FinancialState;
  /** due_date + GRACE_PERIOD_DAYS. Derivado, nunca armazenado. */
  graceEndsAt: string | null;
  daysOverdue: number | null;
}

/** Status de fatura que representam dívida viva. Os demais não geram atraso. */
const OPEN_INVOICE_STATUSES = new Set(["open", "draft"]);

export function normalizeFinancialState(i: FinancialStateInput): FinancialStateResult {
  const none: FinancialStateResult = { state: "PAID", graceEndsAt: null, daysOverdue: null };

  if (i.canceledAt || i.subscriptionStatus === "canceled") {
    return { state: "CANCELED", graceEndsAt: null, daysOverdue: null };
  }
  if (!i.subscriptionStatus) {
    return { state: "NO_SUBSCRIPTION", graceEndsAt: null, daysOverdue: null };
  }

  const inv = i.oldestOpenInvoice;
  if (!inv || !OPEN_INVOICE_STATUSES.has(inv.status)) return none;

  const today = todayBrt(new Date(i.now).getTime());
  const overdue = daysOverdue(inv.dueDate, today);
  const graceEndsAt = addDaysToDate(inv.dueDate, GRACE_PERIOD_DAYS);

  if (overdue < 1) return none;
  if (overdue >= BLOCK_AFTER_DAYS) {
    return { state: "OVERDUE_BEYOND_GRACE", graceEndsAt, daysOverdue: overdue };
  }
  return { state: "IN_GRACE", graceEndsAt, daysOverdue: overdue };
}

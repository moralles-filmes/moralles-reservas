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

/**
 * Espelha o CHECK de `billing_invoices.status`
 * (supabase/migrations/20260528000000_billing_module.sql:194). Vocabulário
 * fechado — os 5 valores são todos os que o banco aceita.
 */
export type BillingInvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

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
  oldestOpenInvoice: { dueDate: string; status: BillingInvoiceStatus } | null;
}

export interface FinancialStateResult {
  state: FinancialState;
  /** due_date + GRACE_PERIOD_DAYS. Derivado, nunca armazenado. */
  graceEndsAt: string | null;
  daysOverdue: number | null;
}

/**
 * Classificação EXAUSTIVA de `BillingInvoiceStatus` em dívida viva (`true`) ou
 * quitada/anulada (`false`) — fonte única, `isBillingInvoiceStatus` deriva
 * daqui. `Record` completo por design: acrescentar um 6º status ao tipo sem
 * atualizar esta linha quebra `tsc -b --noEmit` (propriedade faltando) até
 * alguém decidir conscientemente o lado da classificação; renomear ou
 * remover um status quebra por propriedade em excesso. Essa quebra em
 * compilação é intencional — não "conserte" suprimindo o erro, atualize o
 * `Record`.
 */
const IS_LIVE_DEBT: Record<BillingInvoiceStatus, boolean> = {
  draft: true,
  open: true,
  paid: false,
  void: false,
  uncollectible: false,
};

/**
 * Type guard de `BillingInvoiceStatus`, derivado do mesmo `IS_LIVE_DEBT`
 * acima (nenhuma lista paralela). Não é usado por este núcleo — existe para a
 * camada de I/O (Tasks 11 e 17), que lê a coluna do banco como `string` e
 * precisa validar ANTES de montar um `FinancialStateInput`.
 */
export function isBillingInvoiceStatus(value: unknown): value is BillingInvoiceStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(IS_LIVE_DEBT, value);
}

export function normalizeFinancialState(i: FinancialStateInput): FinancialStateResult {
  const none: FinancialStateResult = { state: "PAID", graceEndsAt: null, daysOverdue: null };

  if (i.canceledAt || i.subscriptionStatus === "canceled") {
    return { state: "CANCELED", graceEndsAt: null, daysOverdue: null };
  }
  if (!i.subscriptionStatus) {
    return { state: "NO_SUBSCRIPTION", graceEndsAt: null, daysOverdue: null };
  }

  const inv = i.oldestOpenInvoice;
  if (!inv || !IS_LIVE_DEBT[inv.status]) return none;

  const today = todayBrt(new Date(i.now).getTime());
  const overdue = daysOverdue(inv.dueDate, today);
  const graceEndsAt = addDaysToDate(inv.dueDate, GRACE_PERIOD_DAYS);

  if (overdue < 1) return none;
  if (overdue >= BLOCK_AFTER_DAYS) {
    return { state: "OVERDUE_BEYOND_GRACE", graceEndsAt, daysOverdue: overdue };
  }
  return { state: "IN_GRACE", graceEndsAt, daysOverdue: overdue };
}

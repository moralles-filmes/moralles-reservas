/**
 * Núcleo PURO do worker process-asaas-invoice-reconcile (Fase 5b, Task 11).
 *
 * Decide, sem I/O, os quatro ramos da reconciliação de cobrança por
 * assinatura do Asaas: (1) classificar o status remoto como "dinheiro
 * entrou" ou não; (2) mapear o método de pagamento; (3) cobrança que existe
 * no Asaas e não existe em `billing_invoices` — separar RECONCILE de
 * BACKFILL e decidir a retenção; (4) fatura `open` local que já foi paga no
 * Asaas → decidir se liquida; (5) divergência de valor → decidir se retém.
 *
 * ZERO imports de Deno/supabase-js — roda em vitest (src/lib) e é importado
 * cru pelo worker Deno, mesmo particionamento de asaas-core.ts/asaas.ts e de
 * billing-financial-state-core.ts (ver os headers desses arquivos: um import,
 * mesmo só de tipo, do SDK do Supabase quebra a resolução do Vite quando vive
 * no mesmo módulo que o vitest importa).
 */

import type { BillingInvoiceStatus } from "./billing-financial-state-core.ts";

/**
 * Status do Asaas que significam "o dinheiro entrou": `RECEIVED` (liquidado),
 * `CONFIRMED` (cartão aprovado, saldo ainda não disponível) e
 * `RECEIVED_IN_CASH` (baixa manual em dinheiro). Mesma régua de
 * `REMOTE_PAID_STATUSES` em process-asaas-reconcile/index.ts, ACRESCIDA de
 * `RECEIVED_IN_CASH`: aquele worker só vê o evento sintético
 * `PAYMENT_RECEIVED` (nunca baixa em espécie); este varre o HISTÓRICO
 * completo de cobranças de uma assinatura, onde uma baixa manual em dinheiro
 * é um desfecho real — sem esta entrada ela viraria uma fatura `open`
 * fantasma que nunca foi cobrada de verdade.
 */
export const SETTLED_ASAAS_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
]);

export function isSettledAsaasPaymentStatus(status: string): boolean {
  return SETTLED_ASAAS_PAYMENT_STATUSES.has(status);
}

/**
 * Espelha `PAYMENT_METHOD_BY_BILLING_TYPE` de `asaas-billing-events-apply.ts`
 * — CÓPIA deliberada, não import: aquele mapa é privado (não exportado) do
 * arquivo do aplicador, e esse arquivo declara no próprio header "NUNCA
 * importado por src/" (um import, mesmo só de tipo, do SDK do Supabase quebra
 * a resolução do Vite quando o módulo é alcançado pelo vitest — mesma razão
 * documentada acima). Duplicar 3 linhas de tabela é mais simples e mais
 * seguro do que expor um símbolo do aplicador só para isto. Mudar um dos dois
 * exige mudar o outro — mesma tríade CREDIT_CARD/PIX/BOLETO nos dois lugares.
 */
const PAYMENT_METHOD_BY_BILLING_TYPE: Readonly<Record<string, "card" | "pix" | "boleto">> = {
  CREDIT_CARD: "card",
  PIX: "pix",
  BOLETO: "boleto",
};

/**
 * `billingType` cru do Asaas (`AsaasPaymentSummary.billingType`) → CHECK
 * `card|pix|boleto` de `billing_invoices.payment_method`. `null` para
 * ausente/`UNDEFINED`/desconhecido — nunca chuta um método (a coluna é
 * nullable exatamente pra isso, mesma régua de `mapPaymentMethod` no
 * aplicador).
 */
export function mapAsaasBillingTypeToPaymentMethod(
  billingType: string | null,
): "card" | "pix" | "boleto" | null {
  if (billingType === null) return null;
  return PAYMENT_METHOD_BY_BILLING_TYPE[billingType] ?? null;
}

export interface MissingInvoiceIngestionDecision {
  ingestionSource: "RECONCILE" | "BACKFILL";
  hold: boolean;
  holdReason: "INITIAL_BACKFILL" | null;
}

/**
 * Cobrança que existe no Asaas e não existe em `billing_invoices` — o buraco
 * que este worker existe para tapar (webhook perdido, ou ingestão ligada
 * DEPOIS da cobrança já existir no provedor).
 *
 * RETENÇÃO É EXCEPCIONAL, NÃO A REGRA (mesmo princípio da migration 077):
 * cobrança recente encontrada tarde por falha de webhook preserva vencimento
 * e tolerância reais — reter converteria em atraso justamente o conserto que
 * a reconciliação faz. Só entra retida quando o vencimento é ANTERIOR ao
 * carimbo de "ingestão ligada" (`sinceValue`) — sinal de que a cobrança é
 * história anterior ao go-live, não um evento recente perdido — E ainda não
 * foi paga (`settled === false`; fatura já liquidada nunca entra em hold por
 * atraso, mesmo histórica).
 *
 * `sinceValue === ""` (flag nunca configurada) nunca classifica como
 * BACKFILL — sem uma data de corte não há como saber o que é "anterior ao
 * go-live", e a régua `sinceValue !== ""` evita reter tudo por precaução.
 *
 * `ingestionSource` distingue as duas origens na própria linha: `RECONCILE`
 * é o caso comum (webhook perdeu uma cobrança recente); `BACKFILL` é
 * especificamente a varredura de histórico anterior ao go-live — mesmo
 * quando paga (`settled === true`), o carimbo de origem continua BACKFILL,
 * só o hold que não se aplica a dinheiro já liquidado.
 */
export function decideMissingInvoiceIngestion(args: {
  /** `billing_invoice_ingestion_since`, `""` quando nunca configurada. */
  sinceValue: string;
  /** `dueDate` (YYYY-MM-DD) da cobrança no Asaas. */
  dueDate: string;
  settled: boolean;
}): MissingInvoiceIngestionDecision {
  const isBackfill = args.sinceValue !== "" && args.dueDate < args.sinceValue;
  const hold = isBackfill && !args.settled;
  return {
    ingestionSource: isBackfill ? "BACKFILL" : "RECONCILE",
    hold,
    holdReason: hold ? "INITIAL_BACKFILL" : null,
  };
}

/**
 * Paga lá, `open` aqui — webhook de pagamento perdido. Só a decisão; a
 * atualização em si é sempre condicional no UPDATE (`.eq('status','open')`)
 * do worker, pra idempotência sob concorrência com o webhook.
 */
export function shouldSettleOpenInvoice(
  localStatus: BillingInvoiceStatus,
  remoteSettled: boolean,
): boolean {
  return remoteSettled && localStatus === "open";
}

/**
 * Valor divergente entre o que o Asaas cobra e o que `billing_invoices`
 * registra — anomalia que pede revisão humana, nunca correção silenciosa
 * (nem o valor local nem o remoto é presumido correto: nenhum dos dois é
 * sobrescrito, só a fatura é retida). Só qualifica fatura `open` ainda não
 * retida — `draft`/`paid`/`void`/`uncollectible` não entram (estado terminal
 * ou ainda não cobrado de verdade), e uma fatura já retida não tem
 * motivo/data reescritos por uma segunda divergência encontrada depois.
 */
export function shouldHoldValueMismatch(args: {
  localStatus: BillingInvoiceStatus;
  alreadyHeld: boolean;
  localAmountCents: number;
  remoteAmountCents: number;
}): boolean {
  return (
    args.localStatus === "open" &&
    !args.alreadyHeld &&
    args.localAmountCents !== args.remoteAmountCents
  );
}

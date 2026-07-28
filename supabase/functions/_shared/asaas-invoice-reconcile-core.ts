/**
 * Núcleo PURO do worker process-asaas-invoice-reconcile (Fase 5b, Task 11).
 *
 * Decide, sem I/O, TUDO que a reconciliação de cobrança por assinatura do
 * Asaas precisa decidir: (1) classificar o `payment.status` remoto numa
 * cobrabilidade interna (dinheiro entrou / ainda devido / estornado-chargeback
 * / desconhecido); (2) validar a data de corte de ingestão
 * (`billing_invoice_ingestion_since`); (3) a decisão INTEIRA de uma cobrança
 * — criar fatura nova (RECONCILE vs BACKFILL + retenção), liquidar fatura
 * `open`, reter por divergência de valor, reter por não-cobrabilidade, ou
 * pular sem criar dívida — sai de UMA ÚNICA função (`decideReconcileAction`),
 * a partir de um snapshot coerente. Isso existe por causa de um bug real do
 * fix round 1: duas consultas SEQUENCIAIS ao núcleo (uma pra "liquidar?",
 * outra pra "valor diverge?") deixavam a segunda decidir com o status ANTIGO
 * da fatura, porque o UPDATE da primeira nunca era refletido de volta antes
 * da segunda pergunta — uma fatura que acabava de ser marcada `paid` na MESMA
 * passagem ainda era vista como `open` na hora de checar divergência de valor,
 * e ficava retida por engano. Centralizar a decisão numa função só, chamada
 * uma vez por cobrança, torna esse tipo de bug estruturalmente impossível: não
 * há como consultar o núcleo duas vezes com dado desatualizado entre as
 * chamadas, porque só existe uma chamada.
 *
 * ZERO imports de Deno/supabase-js — roda em vitest (src/lib) e é importado
 * cru pelo worker Deno, mesmo particionamento de asaas-core.ts/asaas.ts e de
 * billing-financial-state-core.ts (ver os headers desses arquivos: um import,
 * mesmo só de tipo, do SDK do Supabase quebra a resolução do Vite quando vive
 * no mesmo módulo que o vitest importa).
 *
 * O mapeamento de `payment_method` (`AsaasInvoicePaymentMethod`/
 * `mapAsaasBillingTypeToPaymentMethod`) NÃO mora aqui — foi extraído para
 * `asaas-core.ts` no fix round 1 (ver header de lá) pra parar de duplicar o
 * mesmo mapa que já existia, privado, em `asaas-billing-events-apply.ts`. O
 * worker importa de `asaas-core.ts` diretamente.
 */

import type { BillingInvoiceStatus } from "./billing-financial-state-core.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Cobrabilidade — classificação normalizada do `payment.status` do Asaas
// (fix round 1, achado 3). Nenhuma comparação de string crua deve acontecer
// fora desta seção: todo caller usa `classifyPaymentCollectibility`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado financeiro interno derivado de `payment.status`. Vocabulário nosso,
 * não do Asaas — mesma filosofia de `BillingInvoiceStatus`
 * (billing-financial-state-core.ts): o núcleo de decisão nunca compara string
 * crua do provedor, só esta classificação.
 *
 * - `COLLECTIBLE`: ainda devido (pendente, vencido, em análise de risco, ou
 *   em régua de cobrança do PRÓPRIO Asaas) — segue o fluxo normal de criar/
 *   manter fatura em aberto.
 * - `SETTLED`: dinheiro entrou de verdade.
 * - `NON_COLLECTIBLE_REFUND` / `NON_COLLECTIBLE_CHARGEBACK`: estorno ou
 *   contestação em qualquer estágio — NUNCA fabrica dívida nova, e CONGELA
 *   (não apaga) dívida existente pra revisão humana.
 * - `CANCELED`: reservado por completude defensiva — nenhum dos 14 valores
 *   documentados de `payment.status` (§9 de 03-ASAAS-API-VERIFICADO.md, linha
 *   "status (14)") mapeia pra cá hoje. O Asaas não expõe cobrança cancelada
 *   via `status`: `DELETE /v3/payments/{id}` remove a linha inteiramente da
 *   lista (nunca aparece com um status "cancelado"). Tratado igual a
 *   `NON_COLLECTIBLE_*` em `decideReconcileAction` (nunca gera dívida, sempre
 *   congela dívida existente) caso uma fonte futura algum dia produza esse
 *   valor.
 * - `UNKNOWN`: status fora do catálogo documentado (API introduziu um valor
 *   novo, ou payload degradado). NUNCA vira `open` em silêncio — trava a
 *   criação e retém fatura existente pra revisão, mesma régua do não-cobrável.
 */
export type CollectibilityState =
  | "COLLECTIBLE"
  | "SETTLED"
  | "NON_COLLECTIBLE_REFUND"
  | "NON_COLLECTIBLE_CHARGEBACK"
  | "CANCELED"
  | "UNKNOWN";

/**
 * Os 14 valores documentados de `payment.status` (§9 de
 * 03-ASAAS-API-VERIFICADO.md, linha "status (14)"). Fechado — reconferir a
 * doc oficial antes de adicionar um 15º.
 */
type KnownAsaasPaymentStatus =
  | "PENDING"
  | "RECEIVED"
  | "CONFIRMED"
  | "OVERDUE"
  | "REFUNDED"
  | "RECEIVED_IN_CASH"
  | "REFUND_REQUESTED"
  | "REFUND_IN_PROGRESS"
  | "CHARGEBACK_REQUESTED"
  | "CHARGEBACK_DISPUTE"
  | "AWAITING_CHARGEBACK_REVERSAL"
  | "DUNNING_REQUESTED"
  | "DUNNING_RECEIVED"
  | "AWAITING_RISK_ANALYSIS";

const KNOWN_ASAAS_PAYMENT_STATUSES: ReadonlySet<string> = new Set<KnownAsaasPaymentStatus>([
  "PENDING",
  "RECEIVED",
  "CONFIRMED",
  "OVERDUE",
  "REFUNDED",
  "RECEIVED_IN_CASH",
  "REFUND_REQUESTED",
  "REFUND_IN_PROGRESS",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED",
  "DUNNING_RECEIVED",
  "AWAITING_RISK_ANALYSIS",
]);

function isKnownAsaasPaymentStatus(value: string): value is KnownAsaasPaymentStatus {
  return KNOWN_ASAAS_PAYMENT_STATUSES.has(value);
}

/**
 * Record EXAUSTIVO — mesma técnica das Tasks 6/7 (`IS_LIVE_DEBT` em
 * billing-financial-state-core.ts, `NEW_PROVISIONING_ALLOWED_BY_STATE` em
 * whatsapp-service-state-core.ts): as 14 chaves são TODAS as que o tipo
 * `KnownAsaasPaymentStatus` aceita — remover, renomear ou (via esse tipo)
 * adicionar uma chave sem atualizar aqui quebra `tsc -b --noEmit` por
 * propriedade faltando/em excesso. Essa quebra em compilação é intencional.
 *
 * Decisões por status, sem eufemismo:
 * - `PENDING`/`OVERDUE`/`AWAITING_RISK_ANALYSIS`: ainda não resolvido, dinheiro
 *   não entrou nem saiu — COLLECTIBLE.
 * - `DUNNING_REQUESTED`/`DUNNING_RECEIVED`: régua de cobrança do PRÓPRIO
 *   Asaas (carta de cobrança/protesto) — a dívida com A GENTE continua de pé,
 *   nada foi pago — COLLECTIBLE.
 * - `RECEIVED`/`CONFIRMED`/`RECEIVED_IN_CASH`: dinheiro entrou — SETTLED.
 * - `REFUNDED`/`REFUND_REQUESTED`/`REFUND_IN_PROGRESS`: estorno concluído ou
 *   em qualquer estágio anterior — tratados IGUAIS (conservador: o pedido de
 *   estorno já é sinal suficiente pra não continuar cobrando enquanto ele
 *   não se resolve) — NON_COLLECTIBLE_REFUND.
 * - `CHARGEBACK_REQUESTED`/`CHARGEBACK_DISPUTE`/`AWAITING_CHARGEBACK_REVERSAL`:
 *   contestação em qualquer estágio, INCLUSIVE aguardando reversão a favor do
 *   lojista (o desfecho ainda não é definitivo, e decidir a favor do lojista
 *   aqui seria inventar semântica que esta fase não cobre) —
 *   NON_COLLECTIBLE_CHARGEBACK.
 */
const COLLECTIBILITY_BY_STATUS: Record<KnownAsaasPaymentStatus, CollectibilityState> = {
  PENDING: "COLLECTIBLE",
  OVERDUE: "COLLECTIBLE",
  AWAITING_RISK_ANALYSIS: "COLLECTIBLE",
  DUNNING_REQUESTED: "COLLECTIBLE",
  DUNNING_RECEIVED: "COLLECTIBLE",
  RECEIVED: "SETTLED",
  CONFIRMED: "SETTLED",
  RECEIVED_IN_CASH: "SETTLED",
  REFUNDED: "NON_COLLECTIBLE_REFUND",
  REFUND_REQUESTED: "NON_COLLECTIBLE_REFUND",
  REFUND_IN_PROGRESS: "NON_COLLECTIBLE_REFUND",
  CHARGEBACK_REQUESTED: "NON_COLLECTIBLE_CHARGEBACK",
  CHARGEBACK_DISPUTE: "NON_COLLECTIBLE_CHARGEBACK",
  AWAITING_CHARGEBACK_REVERSAL: "NON_COLLECTIBLE_CHARGEBACK",
};

/**
 * Classifica o `payment.status` cru do Asaas. Desconhecido (API introduziu
 * status novo, ou payload corrompido) → `UNKNOWN`, NUNCA um chute pra
 * `COLLECTIBLE`/`SETTLED` — ver `decideReconcileAction` pro tratamento.
 */
export function classifyPaymentCollectibility(status: string): CollectibilityState {
  return isKnownAsaasPaymentStatus(status) ? COLLECTIBILITY_BY_STATUS[status] : "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────────────────────
// Data de corte de ingestão (`billing_invoice_ingestion_since`) — fix round 1,
// achado 2. Com a ingestão ligada, o worker EXIGE essa data; nunca trata
// ausente/vazia/inválida como "sem corte".
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedBillingIngestionSince =
  | { ok: true; value: string }
  | { ok: false; code: "MISSING" | "INVALID_FORMAT" | "IMPOSSIBLE_DATE" };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida `billing_invoice_ingestion_since` (formato oficial do projeto:
 * `YYYY-MM-DD`, mesma convenção de `pay.dueDate`/`reservations.date`).
 * NUNCA lança, nunca usa `new Date("")` como fallback, nunca assume "hoje",
 * nunca assume epoch — ausência/formato inválido/data impossível são os 3
 * jeitos de falhar, todos explícitos no `code`.
 *
 * A ancoragem em meio-dia UTC (`T12:00:00Z`) é a MESMA técnica de
 * `addDaysToDate`/`daysOverdue` em billing-delinquency-core.ts — não inventa
 * política de fuso nova. O propósito aqui não é "hoje em BRT" (não há
 * `now` nesta função), é rejeitar data impossível sem cruzar fuso: o JS
 * `Date` "corrige" silenciosamente uma data inválida (`2026-02-30` vira
 * `2026-03-02`) em vez de lançar, então comparar os componentes formatados de
 * volta contra o que foi digitado é o único jeito de pegar isso.
 */
export function parseBillingIngestionSince(value: unknown): ParsedBillingIngestionSince {
  if (typeof value !== "string") return { ok: false, code: "MISSING" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, code: "MISSING" };
  if (!ISO_DATE_RE.test(trimmed)) return { ok: false, code: "INVALID_FORMAT" };

  const anchored = new Date(trimmed + "T12:00:00Z");
  if (Number.isNaN(anchored.getTime()) || anchored.toISOString().slice(0, 10) !== trimmed) {
    return { ok: false, code: "IMPOSSIBLE_DATE" };
  }

  return { ok: true, value: trimmed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-decisões — cada uma testável isoladamente, todas compostas por
// `decideReconcileAction` (única função que o worker chama por cobrança).
// ─────────────────────────────────────────────────────────────────────────────

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
 * `sinceValue` chega aqui SEMPRE não-vazia e validada — `parseBillingIngestionSince`
 * é a fronteira que garante isso no worker (achado 2 do fix round 1); esta
 * função continua pura e não impõe essa obrigação, mas o único caller real
 * (`decideReconcileAction`) só é alcançado depois daquele guard.
 *
 * `ingestionSource` distingue as duas origens na própria linha: `RECONCILE`
 * é o caso comum (webhook perdeu uma cobrança recente); `BACKFILL` é
 * especificamente a varredura de histórico anterior ao go-live — mesmo
 * quando paga (`settled === true`), o carimbo de origem continua BACKFILL,
 * só o hold que não se aplica a dinheiro já liquidado.
 */
export function decideMissingInvoiceIngestion(args: {
  /** `billing_invoice_ingestion_since` já validada. `""` só em teste isolado
   *  desta função — o worker nunca chama com vazio (ver docstring acima). */
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

// ─────────────────────────────────────────────────────────────────────────────
// Decisão única e composta — o worker chama SÓ esta função por cobrança.
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalInvoiceSnapshot {
  /** `billing_invoices.id` — carregado nas ações que operam sobre esta linha
   *  (`SETTLE_INVOICE`/`HOLD_VALUE_MISMATCH`/`HOLD_NON_COLLECTIBLE`) pra que o
   *  worker NUNCA precise lembrar do snapshot original fora da ação
   *  devolvida. É exatamente esse tipo de "contexto que sobrevive fora da
   *  decisão" que causou o achado 1 — a ação agora é AUTOSSUFICIENTE. */
  id: string;
  status: BillingInvoiceStatus;
  amountCents: number;
  enforcementHold: boolean;
}

export interface ReconcileInvoiceContext {
  collectibility: CollectibilityState;
  /** `null` = nenhuma fatura local pra este `provider_payment_id` ainda. */
  localInvoice: LocalInvoiceSnapshot | null;
  remoteAmountCents: number;
  /** `dueDate` (YYYY-MM-DD) da cobrança no Asaas. */
  dueDate: string;
  /** `billing_invoice_ingestion_since` já validada (nunca `""` no uso real do worker). */
  sinceValue: string;
}

export type ReconcileInvoiceAction =
  | ({ kind: "CREATE_INVOICE"; status: "open" | "paid" } & MissingInvoiceIngestionDecision)
  | { kind: "SETTLE_INVOICE"; invoiceId: string }
  | { kind: "HOLD_VALUE_MISMATCH"; invoiceId: string; localAmountCents: number }
  | { kind: "HOLD_NON_COLLECTIBLE"; invoiceId: string }
  | { kind: "SKIP_NON_COLLECTIBLE_NO_INVOICE" }
  | { kind: "SKIP_UNKNOWN_NO_INVOICE" }
  | { kind: "NO_ACTION" };

/**
 * Decide a ação INTEIRA pra uma cobrança, a partir de UM snapshot coerente —
 * fatura local (se existir) e cobrabilidade remota. Ver o header do arquivo
 * pro porquê desta função existir centralizada (achado 1 do fix round 1: bug
 * de composição quando liquidação e divergência de valor eram decididas por
 * duas chamadas separadas ao núcleo).
 *
 * Ordem de decisão, sem eufemismo:
 *
 * 1. NÃO-COBRÁVEL (`NON_COLLECTIBLE_REFUND`/`NON_COLLECTIBLE_CHARGEBACK`/
 *    `CANCELED`) — NUNCA fabrica fatura nova (`SKIP_NON_COLLECTIBLE_NO_INVOICE`
 *    quando não há fatura local). Fatura local `open` E ainda não retida →
 *    `HOLD_NON_COLLECTIBLE` (congela pra revisão humana, nunca settle
 *    automático, nunca segunda fatura). Fatura já retida/paga/draft/void/
 *    uncollectible → `NO_ACTION` (idempotente: aplicar duas vezes não reabre
 *    nem duplica).
 * 2. DESCONHECIDO (`UNKNOWN`) — mesma régua do item 1: nunca cria fatura
 *    `open` às cegas: sem fatura local, pula e loga (`SKIP_UNKNOWN_NO_INVOICE`);
 *    com fatura local `open` não retida, congela pra revisão
 *    (`HOLD_NON_COLLECTIBLE` — mesma ação, ambiguidade também é motivo de
 *    congelar, não só estorno/chargeback).
 * 3. SEM FATURA LOCAL (`COLLECTIBLE`/`SETTLED`) — `CREATE_INVOICE`, delegando
 *    RECONCILE-vs-BACKFILL e retenção pra `decideMissingInvoiceIngestion`.
 * 4. COM FATURA LOCAL, liquidada agora (`shouldSettleOpenInvoice`) →
 *    `SETTLE_INVOICE`. Retorna AQUI — divergência de valor NUNCA é avaliada
 *    depois de uma liquidação decidida NESTA MESMA chamada (é exatamente o
 *    bug do achado 1: uma fatura que acabou de ser liquidada não pode, na
 *    mesma passagem, ser vista como teoricamente `open` para fins de
 *    divergência).
 * 5. COM FATURA LOCAL, não liquidada agora, valor diverge
 *    (`shouldHoldValueMismatch`) → `HOLD_VALUE_MISMATCH`.
 * 6. Nenhuma das anteriores → `NO_ACTION`.
 */
export function decideReconcileAction(ctx: ReconcileInvoiceContext): ReconcileInvoiceAction {
  const { collectibility, localInvoice } = ctx;

  const isFrozenCategory =
    collectibility === "NON_COLLECTIBLE_REFUND" ||
    collectibility === "NON_COLLECTIBLE_CHARGEBACK" ||
    collectibility === "CANCELED";

  if (isFrozenCategory) {
    if (!localInvoice) return { kind: "SKIP_NON_COLLECTIBLE_NO_INVOICE" };
    if (localInvoice.status === "open" && !localInvoice.enforcementHold) {
      return { kind: "HOLD_NON_COLLECTIBLE", invoiceId: localInvoice.id };
    }
    return { kind: "NO_ACTION" };
  }

  if (collectibility === "UNKNOWN") {
    if (!localInvoice) return { kind: "SKIP_UNKNOWN_NO_INVOICE" };
    if (localInvoice.status === "open" && !localInvoice.enforcementHold) {
      return { kind: "HOLD_NON_COLLECTIBLE", invoiceId: localInvoice.id };
    }
    return { kind: "NO_ACTION" };
  }

  const settled = collectibility === "SETTLED";

  if (!localInvoice) {
    const decision = decideMissingInvoiceIngestion({
      sinceValue: ctx.sinceValue,
      dueDate: ctx.dueDate,
      settled,
    });
    return { kind: "CREATE_INVOICE", status: settled ? "paid" : "open", ...decision };
  }

  if (shouldSettleOpenInvoice(localInvoice.status, settled)) {
    return { kind: "SETTLE_INVOICE", invoiceId: localInvoice.id };
  }

  if (
    shouldHoldValueMismatch({
      localStatus: localInvoice.status,
      alreadyHeld: localInvoice.enforcementHold,
      localAmountCents: localInvoice.amountCents,
      remoteAmountCents: ctx.remoteAmountCents,
    })
  ) {
    return {
      kind: "HOLD_VALUE_MISMATCH",
      invoiceId: localInvoice.id,
      localAmountCents: localInvoice.amountCents,
    };
  }

  return { kind: "NO_ACTION" };
}

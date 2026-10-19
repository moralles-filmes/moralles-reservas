/**
 * Núcleo PURO do orçamento de franquia de IA (Plano D, spec §17.3-17.7).
 *
 * Importa APENAS outro núcleo puro (`whatsapp-instance-cycle-core.ts`) — a
 * aritmética de âncora de calendário já foi resolvida e testada na 6b, e
 * reimplementá-la aqui criaria uma segunda verdade sobre a mesma pergunta
 * (§18.5: "Reusar a solução, não reinventar").
 *
 * NÃO EXISTE NENHUMA CONTAGEM DE CONVERSA, MENSAGEM OU INTERAÇÃO NESTE ARQUIVO.
 * O único teto é financeiro (§18.1) — e é intencional que a única unidade que
 * aparece aqui seja centavo.
 */

import { clampDayToMonth } from "./whatsapp-instance-cycle-core.ts";
import type { AiUsageTokens } from "./ai-price-core.ts";

/** R$ 100,00. Congelado no ciclo na abertura — nunca relido do plano. */
export const AI_BUDGET_DEFAULT_LIMIT_CENTS = 10000;

/**
 * Quantas chamadas a reserva inicial do turno cobre.
 *
 * Reservar as 12 iterações de `MAX_ITERATIONS` de uma vez bloquearia organizações
 * com saldo real por causa de um pior caso que quase nunca ocorre; reservar uma
 * só faria toda segunda chamada passar por extensão. Duas é o meio: cobre o
 * turno típico (pergunta + tool + resposta) e deixa a extensão para o turno longo.
 */
export const AI_TURN_INITIAL_CALLS = 2;

/**
 * TTL da reserva. Pior caso real: 12 iterações × 12s de timeout + retries, com
 * o hard limit de 60s da Edge Function como teto verdadeiro. 5 minutos está
 * confortavelmente acima e ainda devolve capacidade rápido depois de um crash.
 */
export const AI_RESERVATION_TTL_SECONDS = 300;

/**
 * Estimativa conservadora de tokens. Erra PARA CIMA de propósito: subestimar
 * autoriza uma chamada que não cabe.
 */
export const AI_ESTIMATE_BASE_INPUT_TOKENS = 6000;
export const AI_ESTIMATE_INPUT_GROWTH_PER_ITERATION = 1200;
// >= o maior `MAX_OUTPUT_TOKENS_BY_PROVIDER` (agent-output-core.ts, hoje Gemini
// 3072, que inclui o raciocínio). Subestimar a saída subestima a reserva. O teste
// gêmeo em `src/lib/agent-output-core.test.ts` amarra os dois valores.
export const AI_ESTIMATE_OUTPUT_TOKENS = 3072;

export interface BudgetSnapshot {
  limitCents: number;
  settledCents: number;
  /** Σ(reserved_cents − consumed_cents) das reservas HELD. */
  activeReservedRemainingCents: number;
}

/**
 * available = limite − LIQUIDADO − COMPROMETIDO.
 *
 * As três grandezas entram SEPARADAS (§17.5). Colapsar liquidado e reserva num
 * campo só torna impossível responder "quanto essa organização realmente custou
 * neste ciclo?" — que é a pergunta de que a margem da §13 depende.
 *
 * O comprometido é o RESTANTE (`reserved − consumed`), não o valor original: a
 * parte já consumida migra para `settled` na liquidação, e contá-la duas vezes
 * bloquearia organizações que ainda têm saldo.
 */
export function computeAvailableCents(s: BudgetSnapshot): number {
  const v = s.limitCents - s.settledCents - s.activeReservedRemainingCents;
  return v > 0 ? v : 0;
}

// ─── Janela do ciclo ────────────────────────────────────────────────────────

export interface CycleWindowInput {
  /** Data de HOJE em BRT (YYYY-MM-DD). O adapter converte; o núcleo não conhece fuso. */
  todayIso: string;
  /** Persistido no orçamento anterior. NUNCA re-derivado do vencimento atual. */
  anchorDay: number | null;
  subscriptionPeriodStartIso: string | null;
  subscriptionPeriodEndIso: string | null;
  orgCreatedAtIso: string;
}

export interface CycleWindow {
  /** INCLUSIVO. */
  cycleStart: string;
  /** EXCLUSIVO: primeiro dia NÃO coberto. */
  cycleEnd: string;
  anchorDay: number;
}

function dayOf(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCDate();
}

function ymd(year: number, month1: number, day: number): string {
  const dd = clampDayToMonth(year, month1, day);
  return `${year}-${String(month1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Resolve [cycleStart, cycleEnd) a partir do dia-âncora.
 *
 * A âncora é PERSISTIDA e nunca re-derivada do vencimento atual: sem isso,
 * âncora 31 degrada para 28 depois do primeiro fevereiro e nunca mais volta —
 * defeito já pago na 6b (`provider_cycle_anchor_day`).
 *
 * Origem da âncora, em ordem: orçamento anterior → fim do período da assinatura
 * de sistema → criação da organização. A terceira é fallback de organização sem
 * assinatura (cortesia, legado) e existe para que o ciclo nunca fique indefinido.
 */
export function resolveCycleWindow(input: CycleWindowInput): CycleWindow {
  const anchorDay =
    input.anchorDay ??
    dayOf(input.subscriptionPeriodEndIso) ??
    dayOf(input.subscriptionPeriodStartIso) ??
    dayOf(input.orgCreatedAtIso) ??
    1;

  const today = new Date(`${input.todayIso}T00:00:00Z`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;

  // Marco deste mês, com clamp (30/02 vira 28/02).
  const thisMonthMark = ymd(y, m, anchorDay);

  let startY = y;
  let startM = m;
  if (input.todayIso < thisMonthMark) {
    // Ainda não chegamos à âncora deste mês: o ciclo corrente abriu no mês passado.
    startM = m - 1;
    if (startM === 0) {
      startM = 12;
      startY = y - 1;
    }
  }

  let endY = startY;
  let endM = startM + 1;
  if (endM === 13) {
    endM = 1;
    endY = startY + 1;
  }

  return {
    cycleStart: ymd(startY, startM, anchorDay),
    cycleEnd: ymd(endY, endM, anchorDay),
    anchorDay,
  };
}

// ─── Estimativa conservadora ────────────────────────────────────────────────

/**
 * `iteration` é 1-based. O contexto cresce a cada iteração (histórico acumulado,
 * tool results embutidos) — a 1ª e a 11ª têm perfis de custo diferentes, e é por
 * isso que `iteration`/`max_iterations` entram no contexto do `beforeCall`
 * (§17.7.2).
 *
 * `cache_read_tokens` estimado é ZERO de propósito: assumir cache hit barateia a
 * estimativa e a estimativa existe para ser cara.
 */
export function estimateCallTokens(iteration: number): AiUsageTokens {
  const it = iteration > 1 ? iteration : 1;
  return {
    input_tokens: AI_ESTIMATE_BASE_INPUT_TOKENS + (it - 1) * AI_ESTIMATE_INPUT_GROWTH_PER_ITERATION,
    output_tokens: AI_ESTIMATE_OUTPUT_TOKENS,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
  };
}

/** Estimativa da reserva inicial do turno: as primeiras `AI_TURN_INITIAL_CALLS` chamadas. */
export function estimateTurnCents(costOfCall: (usage: AiUsageTokens) => number): number {
  let total = 0;
  for (let i = 1; i <= AI_TURN_INITIAL_CALLS; i++) total += costOfCall(estimateCallTokens(i));
  return total;
}

// ─── Decisão por chamada ────────────────────────────────────────────────────

/**
 * D6: resultado DISCRIMINADO, nunca boolean.
 *
 * Um `Promise<boolean>` não diferencia teto atingido, preço desconhecido, usage
 * anterior pendente, erro de banco e falha de lock — e transformaria soluço de
 * infraestrutura em "franquia esgotada", com a copy errada ao cliente e o alerta
 * errado ao admin. `ERROR` e `DENY_BUDGET` levam ao mesmo destino operacional,
 * mas dizem coisas OPOSTAS, e só uma delas significa que a franquia acabou.
 */
export type BeforeCallDecision =
  | { kind: "ALLOW"; reservationId: string; remainingReservedCents: number }
  | { kind: "DENY_BUDGET"; reasonCode: string }
  | { kind: "DENY_PRICE_UNKNOWN"; provider: string; model: string }
  | { kind: "DENY_USAGE_UNRESOLVED"; reasonCode: string }
  | { kind: "ERROR"; retryable: boolean; sanitizedCode: string };

export interface BeforeCallContext {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  provider: string;
  model: string;
  /** 1-based. */
  iteration: number;
  maxIterations: number;
  reservationId: string;
  consumedCents: number;
  reservedCents: number;
  /** Estimativa máxima da PRÓXIMA chamada, já precificada. */
  nextCallEstimateCents: number;
}

export type NextCallPlan =
  | { kind: "ALLOW" }
  | { kind: "EXTEND"; additionalCents: number }
  | { kind: "DENY_USAGE_UNRESOLVED"; reasonCode: string };

/**
 * Parte PURA do `beforeCall`: dado o estado da reserva, o que precisa acontecer
 * antes da próxima chamada.
 *
 * `usageUnresolved` é checado PRIMEIRO e vence saldo: existe consumo anterior
 * cujo custo não pôde ser determinado, então não é possível afirmar que a
 * próxima chamada cabe — a mesma consequência do preço desconhecido, por uma
 * ignorância diferente (§17.2.1).
 */
export function planNextCall(
  ctx: BeforeCallContext,
  opts: { usageUnresolved: boolean },
): NextCallPlan {
  if (opts.usageUnresolved) {
    return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: "prior_usage_unresolved" };
  }
  const remaining = ctx.reservedCents - ctx.consumedCents;
  if (remaining >= ctx.nextCallEstimateCents) return { kind: "ALLOW" };
  // SEM clamp de `remaining` a zero. Quando o turno já gastou mais do que
  // reservou (overage), `remaining` é NEGATIVO e a extensão precisa cobrir as
  // duas coisas: o déficit já incorrido E a próxima chamada. Clampar descarta a
  // magnitude do overage e devolve uma extensão que deixa o restante em zero —
  // autorizando uma chamada sem cobertura real, que é precisamente o que a
  // estimativa conservadora existe para impedir.
  const deficit = ctx.nextCallEstimateCents - remaining;
  return { kind: "EXTEND", additionalCents: deficit };
}

/** Linha devolvida pelas RPCs `reserve_ai_budget` / `extend_ai_reservation`. */
export interface ReserveDecisionRow {
  decision?: string | null;
  reason_code?: string | null;
  reservation_id?: string | null;
  reserved_cents?: number | null;
  consumed_cents?: number | null;
}

/**
 * Traduz a linha da RPC em decisão tipada.
 *
 * QUALQUER valor inesperado vira `ERROR` retriável — nunca `DENY_BUDGET`. Um
 * `decision` desconhecido é ignorância nossa sobre o banco, não afirmação de que
 * o cliente gastou a franquia.
 */
export function mapReserveDecision(row: ReserveDecisionRow | null | undefined): BeforeCallDecision {
  if (!row) return { kind: "ERROR", retryable: true, sanitizedCode: "reserve_no_row" };
  switch (row.decision) {
    case "ALLOW": {
      const reserved = row.reserved_cents ?? 0;
      const consumed = row.consumed_cents ?? 0;
      const remaining = reserved - consumed;
      return {
        kind: "ALLOW",
        reservationId: row.reservation_id ?? "",
        remainingReservedCents: remaining > 0 ? remaining : 0,
      };
    }
    case "DENY_BUDGET":
      return { kind: "DENY_BUDGET", reasonCode: row.reason_code ?? "cycle_exhausted" };
    case "DENY_USAGE_UNRESOLVED":
      return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: row.reason_code ?? "prior_usage_unresolved" };
    default:
      return { kind: "ERROR", retryable: true, sanitizedCode: "reserve_unknown_decision" };
  }
}

/** Só o teto comercial. Falha técnica NUNCA responde `true` aqui. */
export function isCommercialHardStop(d: BeforeCallDecision): boolean {
  return d.kind === "DENY_BUDGET";
}

/** Um `evt` distinto por variante — a diferença que o boolean apagava. */
export function telemetryEventFor(d: BeforeCallDecision): string {
  switch (d.kind) {
    case "ALLOW":
      return "ai_budget_allow";
    case "DENY_BUDGET":
      return "ai_budget_deny_budget";
    case "DENY_PRICE_UNKNOWN":
      return "ai_budget_deny_price_unknown";
    case "DENY_USAGE_UNRESOLVED":
      return "ai_budget_deny_usage_unresolved";
    default:
      return "ai_budget_error";
  }
}

/** Razão de handoff exclusiva do teto — distingue de `agent_error` na telemetria e no painel. */
export const AI_BUDGET_HANDOFF_REASON = "ai_budget_exhausted";

/**
 * O auto-resolve de 12h devolveria a conversa para uma IA que não pode responder.
 * Com `ai_budget_exhausted`, só a virada do ciclo (orçamento não mais esgotado)
 * devolve — nunca o decurso do prazo.
 */
export function shouldAutoResolveHandoff(args: {
  handoffReason: string | null;
  ageMs: number;
  thresholdMs: number;
  budgetExhausted: boolean;
}): boolean {
  if (args.ageMs <= args.thresholdMs) return false;
  if (args.handoffReason === AI_BUDGET_HANDOFF_REASON && args.budgetExhausted) return false;
  return true;
}

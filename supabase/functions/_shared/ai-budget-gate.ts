/**
 * ADAPTER de I/O do orçamento de franquia de IA (Plano D).
 *
 * ZERO DECISÃO PRÓPRIA. Toda pergunta — "cabe?", "qual preço vigente?", "qual
 * marco cruzou?", "que janela é o ciclo?", "isto é teto comercial ou soluço de
 * infraestrutura?" — é respondida por núcleo puro (`ai-budget-core.ts`,
 * `ai-price-core.ts`, `ai-budget-milestones-core.ts`). Este arquivo importa
 * supabase-js e o vitest não o alcança: regra escrita aqui só seria verificável
 * por leitura, e leitura já deixou passar um `ReferenceError` de autorização e
 * um conflito FK × CHECK na 6b. O que sobra aqui é I/O, ordem de escrita e
 * sanitização — e mesmo isso é vigiado por `src/lib/ai-budget-wiring-guard.test.ts`.
 *
 * MODO OBSERVAÇÃO (flag `ai_wallet_enforced` OFF): medição e ledger funcionam,
 * hard stop NÃO aplica. Nenhuma negação comercial acontece — é assim que se vê
 * o custo real por organização ANTES de qualquer bloqueio ligar. A flag é lida
 * por `isFlagEnabled`, que devolve `false` também quando a leitura falha: falhar
 * para o lado de NÃO negar é a única direção aceitável aqui, porque a
 * consequência de negar por engano recai sobre o cliente do restaurante.
 *
 * O ÚNICO TETO É FINANCEIRO. Nenhuma contagem de conversa, mensagem ou
 * interação aparece neste arquivo.
 *
 * NUNCA lê credencial de IA, nunca loga chave, nunca devolve SQL ou mensagem do
 * Postgres ao chamador — detalhe vai para `jsonLog`, o chamador recebe um código
 * curto e estável.
 *
 * REDEPLOY: consumidor único hoje é `webhook-whatsapp`.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog } from "./security.ts";
import { isFlagEnabled } from "./platform-flags.ts";
import {
  AI_BUDGET_DEFAULT_LIMIT_CENTS,
  AI_RESERVATION_TTL_SECONDS,
  computeAvailableCents,
  estimateCallTokens,
  estimateTurnCents,
  isCommercialHardStop,
  mapReserveDecision,
  planNextCall,
  resolveCycleWindow,
  type BeforeCallContext,
  type BeforeCallDecision,
} from "./ai-budget-core.ts";
import {
  priceUsage,
  selectEffectivePrice,
  type AiModelPrice,
  type AiUsageTokens,
} from "./ai-price-core.ts";
import {
  crossedMilestonePercents,
  EVENT_TYPE_BY_MILESTONE_PERCENT,
} from "./ai-budget-milestones-core.ts";
import type { AgentBudgetHooks, AgentCallMeta, AgentCallOutcome } from "./ai-providers.ts";
import type { PriceLookup } from "./ai-call-authorizer-core.ts";
import { enqueueBillingNotification, resolvePlatformAdminRecipients } from "./billing-notify.ts";

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Data de HOJE em BRT. Deno roda em UTC; sem isto a virada do ciclo erra 3h. */
function todayBrt(): string {
  return new Date(Date.now() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

const PRICE_COLUMNS =
  "id, provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, " +
  "cache_write_usd_per_mtok, reasoning_usd_per_mtok, usd_to_brl, effective_from, effective_to";

export interface TurnBudget {
  cycleId: string;
  limitCents: number;
  settledCents: number;
  state: string;
  reservationId: string;
  reservedCents: number;
  enforced: boolean;
}

export type OpenTurnResult =
  | { kind: "READY"; budget: TurnBudget }
  | { kind: "EXHAUSTED"; cycleId: string }
  | { kind: "ERROR"; sanitizedCode: string };

// ─── Preços ────────────────────────────────────────────────────────────────

function toPriceRows(data: unknown): AiModelPrice[] {
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    provider: r.provider as string,
    model: r.model as string,
    inputUsdPerMtok: Number(r.input_usd_per_mtok),
    outputUsdPerMtok: Number(r.output_usd_per_mtok),
    cacheReadUsdPerMtok: Number(r.cache_read_usd_per_mtok),
    cacheWriteUsdPerMtok: Number(r.cache_write_usd_per_mtok),
    reasoningUsdPerMtok: r.reasoning_usd_per_mtok === null ? null : Number(r.reasoning_usd_per_mtok),
    usdToBrl: Number(r.usd_to_brl),
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string | null) ?? null,
  }));
}

/**
 * Preço VIGENTE completo do par (provider, model), ou `null`.
 *
 * Falha de LEITURA e ausência de linha devolvem a mesma coisa de propósito: a
 * consequência é idêntica e é a segura — sem preço confirmado, nenhuma chamada
 * autorizada e nenhum evento gravado. Quem precisa saber POR QUE lê o log.
 */
async function loadPrice(
  supabase: SupabaseClient,
  provider: string,
  model: string,
): Promise<AiModelPrice | null> {
  const { data, error } = await supabase
    .from("ai_model_prices")
    .select(PRICE_COLUMNS)
    .eq("provider", provider)
    .eq("model", model);
  if (error) {
    jsonLog("error", { evt: "ai_price_read_failed", provider, model, err: error.message });
    return null;
  }
  // A escolha entre vigências é do núcleo (mais recente vence; nunca linha
  // arbitrária, que é o defeito de `ilike + limit(1)` num campo financeiro).
  return selectEffectivePrice(toPriceRows(data), provider, model, new Date().toISOString());
}

/**
 * Resolvedor de `price_id` para o autorizador, com cache POR INVOCAÇÃO — não por
 * processo: a Edge Function pode ficar quente e um preço recém-cadastrado
 * precisa valer na próxima requisição, mesma razão de `unitCache` ser zerado no
 * início de cada invocação dos workers.
 */
function makePriceResolver(supabase: SupabaseClient) {
  const cache = new Map<string, AiModelPrice | null>();
  return async function priceFor(provider: string, model: string): Promise<PriceLookup> {
    const key = `${provider}:${model}`;
    let price = cache.get(key);
    if (price === undefined) {
      price = await loadPrice(supabase, provider, model);
      cache.set(key, price);
    }
    if (!price) {
      // Registro sanitizado: provedor e modelo. NUNCA a credencial da unidade.
      jsonLog("warn", { evt: "ai_price_unknown", provider, model });
      return { kind: "PRICE_UNKNOWN", provider, model };
    }
    return { kind: "PRICED", priceId: price.id };
  };
}

/**
 * Custo em centavos de BRL de um consumo, já precificado.
 *
 * `PRICE_UNKNOWN` aqui é inalcançável (o preço chega carregado), e devolver 0 em
 * silêncio seria exatamente a falha que esta frente existe para matar — daí o
 * valor máximo, que faz qualquer decisão de cobertura recusar em vez de
 * autorizar de graça.
 */
function costOf(price: AiModelPrice, usage: AiUsageTokens, provider: string, model: string): number {
  const r = priceUsage(price, usage, provider, model);
  if (r.kind !== "PRICED") return Number.MAX_SAFE_INTEGER;
  return r.brlCents;
}

// ─── Franquia (leitura para o entitlement) ─────────────────────────────────

/**
 * Estado do orçamento do ciclo corrente, para injetar em `resolveOrgEntitlements`.
 *
 * `null` = não há ciclo aberto ainda (organização que nunca usou IA). O núcleo de
 * entitlement trata ausência como "não consultado", NUNCA como "esgotado".
 */
export async function loadAiFranchise(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ state: "OPEN" | "EXHAUSTED" | "CLOSED"; remainingCents: number } | null> {
  const today = todayBrt();
  const { data, error } = await supabase
    .from("ai_cycle_budgets")
    .select("id, limit_cents, settled_cents, state")
    .eq("organization_id", organizationId)
    .lte("cycle_start", today)
    .gt("cycle_end", today)
    .maybeSingle();
  if (error) {
    jsonLog("error", { evt: "ai_budget_franchise_read_failed", org: organizationId, err: error.message });
    return null;
  }
  if (!data) return null;

  const { data: held, error: heldErr } = await supabase
    .from("ai_cost_reservations")
    .select("reserved_cents, consumed_cents")
    .eq("organization_id", organizationId)
    .eq("cycle_id", data.id)
    .eq("status", "HELD");
  if (heldErr) {
    jsonLog("error", { evt: "ai_budget_held_read_failed", org: organizationId, err: heldErr.message });
    return null;
  }

  // Comprometido é o RESTANTE de cada reserva viva. A regra de por que é o
  // restante (e não o valor original) vive no núcleo, junto da fórmula.
  const committed = (held ?? []).reduce(
    (s: number, r: { reserved_cents: number; consumed_cents: number }) =>
      s + Math.max(r.reserved_cents - r.consumed_cents, 0),
    0,
  );

  return {
    state: data.state as "OPEN" | "EXHAUSTED" | "CLOSED",
    remainingCents: computeAvailableCents({
      limitCents: data.limit_cents,
      settledCents: data.settled_cents,
      activeReservedRemainingCents: committed,
    }),
  };
}

// ─── Abertura do ciclo + reserva do turno ──────────────────────────────────

/**
 * Abre (ou reencontra) o ciclo e reserva capacidade para UM turno.
 *
 * `ERROR` NÃO é "franquia esgotada": as duas levam ao mesmo destino operacional
 * e dizem coisas opostas ao cliente e ao admin. Só `EXHAUSTED` afirma teto, e só
 * quando o gate está ligado.
 */
export async function openTurnBudget(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    turnId: string;
    requestId: string;
    provider: string;
    model: string;
  },
): Promise<OpenTurnResult> {
  const enforced = await isFlagEnabled("ai_wallet_enforced");

  // Âncora do ciclo: orçamento anterior > fim do período da assinatura de
  // sistema > criação da organização. A ORDEM e a aritmética são do núcleo; aqui
  // só se buscam os três insumos.
  const [{ data: lastBudget }, { data: sub }, { data: org }] = await Promise.all([
    supabase
      .from("ai_cycle_budgets")
      .select("cycle_anchor_day")
      .eq("organization_id", args.organizationId)
      .order("cycle_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("billing_subscriptions")
      .select("current_period_start, current_period_end, billing_plans!inner(category)")
      .eq("organization_id", args.organizationId)
      .eq("billing_plans.category", "SYSTEM_SUBSCRIPTION")
      .neq("status", "canceled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("organizations").select("created_at").eq("id", args.organizationId).maybeSingle(),
  ]);

  const window = resolveCycleWindow({
    todayIso: todayBrt(),
    anchorDay: lastBudget?.cycle_anchor_day ?? null,
    subscriptionPeriodStartIso: sub?.current_period_start ?? null,
    subscriptionPeriodEndIso: sub?.current_period_end ?? null,
    orgCreatedAtIso: org?.created_at ?? new Date().toISOString(),
  });

  const { data: opened, error: openErr } = await supabase.rpc("open_ai_cycle_budget", {
    p_organization_id: args.organizationId,
    p_cycle_start: window.cycleStart,
    p_cycle_end: window.cycleEnd,
    p_anchor_day: window.anchorDay,
    p_limit_cents: AI_BUDGET_DEFAULT_LIMIT_CENTS,
  });
  const cycle = Array.isArray(opened) ? opened[0] : opened;
  if (openErr || !cycle) {
    jsonLog("error", {
      evt: "ai_budget_open_failed",
      org: args.organizationId,
      err: openErr?.message ?? "no_row",
    });
    return { kind: "ERROR", sanitizedCode: "budget_open_failed" };
  }

  if (cycle.state === "EXHAUSTED" && enforced) {
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }

  // Estimativa da reserva inicial, precificada pelo modelo REAL do turno.
  const price = await loadPrice(supabase, args.provider, args.model);
  if (!price) {
    // Sem preço não há como estimar, e sem estimar não há reserva honesta. Em
    // modo observação isto NÃO cala o agente: o chamador segue sem ganchos e o
    // turno roda — apenas não é medido.
    jsonLog("warn", {
      evt: "ai_price_unknown",
      org: args.organizationId,
      provider: args.provider,
      model: args.model,
    });
    return { kind: "ERROR", sanitizedCode: "price_unknown" };
  }

  const estimate = estimateTurnCents((usage) => costOf(price, usage, args.provider, args.model));

  const { data: reserved, error: resErr } = await supabase.rpc("reserve_ai_budget", {
    p_organization_id: args.organizationId,
    p_cycle_id: cycle.id,
    p_turn_id: args.turnId,
    p_idempotency_key: `turn:${args.turnId}`,
    p_estimate_cents: estimate,
    p_ttl_seconds: AI_RESERVATION_TTL_SECONDS,
  });
  if (resErr) {
    jsonLog("error", {
      evt: "ai_budget_reserve_failed",
      org: args.organizationId,
      err: resErr.message,
    });
    return { kind: "ERROR", sanitizedCode: "reserve_failed" };
  }
  const row = Array.isArray(reserved) ? reserved[0] : reserved;

  const decision = mapReserveDecision(row);
  if (isCommercialHardStop(decision)) {
    if (!enforced) {
      jsonLog("warn", {
        evt: "ai_budget_deny_budget_observed",
        org: args.organizationId,
        note: "flag_off_no_denial",
      });
      // Modo observação: segue sem ganchos. A medição DESTE turno se perde, e é
      // o preço de não bloquear — nunca o contrário.
      return { kind: "ERROR", sanitizedCode: "observed_only" };
    }
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }
  if (decision.kind !== "ALLOW") {
    jsonLog("warn", {
      evt: "ai_budget_reserve_not_allowed",
      org: args.organizationId,
      kind: decision.kind,
    });
    return { kind: "ERROR", sanitizedCode: "reserve_not_allowed" };
  }

  return {
    kind: "READY",
    budget: {
      cycleId: cycle.id,
      limitCents: cycle.limit_cents,
      settledCents: cycle.settled_cents,
      state: cycle.state,
      reservationId: decision.reservationId,
      reservedCents: row?.reserved_cents ?? estimate,
      enforced,
    },
  };
}

// ─── Ganchos entregues ao runAgentLoop ─────────────────────────────────────

export function makeBudgetHooks(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    unitId: string | null;
    conversationId: string | null;
    requestId: string;
    turnId: string;
    budget: TurnBudget;
    provider: string;
  },
): AgentBudgetHooks {
  const priceFor = makePriceResolver(supabase);
  let consumedCents = 0;
  let reservedCents = args.budget.reservedCents;
  let usageUnresolved = false;
  let callSeq = 0;
  let lastEstimateCents = 0;

  return {
    organizationId: args.organizationId,
    cycleId: args.budget.cycleId,
    turnId: args.turnId,
    requestId: args.requestId,
    reservationId: args.budget.reservationId,
    newCallId: () => `${args.turnId}:${++callSeq}`,
    priceFor,

    snapshot(iteration: number, provider: string, model: string) {
      // Provedor e modelo viajam no contrato para que ele não minta, mas a
      // AUTORIDADE sobre a cobertura não está aqui: `beforeCall` recarrega o
      // preço do modelo real e recalcula a estimativa antes de decidir. O que
      // este método devolve é o último número calculado, útil para telemetria e
      // inofensivo se estiver defasado — nenhuma autorização depende dele.
      jsonLog("info", {
        evt: "ai_budget_snapshot",
        org: args.organizationId,
        iteration,
        provider,
        model,
      });
      return { consumedCents, reservedCents, nextCallEstimateCents: lastEstimateCents };
    },

    async beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision> {
      // O PREÇO É DO MODELO REAL DESTA CHAMADA. `ctx.nextCallEstimateCents` chega
      // precificado no modelo do INÍCIO DO TURNO; confiar nele autoriza a
      // tentativa de fallback (Pro) com a folga do modelo barato (Flash), que é
      // subcontabilização direta. Recarrega-se e recalcula-se aqui, sempre.
      const price = await loadPrice(supabase, ctx.provider, ctx.model);
      if (!price) {
        if (!args.budget.enforced) {
          // Modo observação: medir não pode calar o agente de ninguém. A chamada
          // segue e simplesmente NÃO gera evento — `price_id` é NOT NULL.
          jsonLog("warn", {
            evt: "ai_budget_price_unknown_observed",
            org: args.organizationId,
            provider: ctx.provider,
            model: ctx.model,
          });
          return { kind: "ALLOW", reservationId: args.budget.reservationId, remainingReservedCents: 0 };
        }
        return { kind: "DENY_PRICE_UNKNOWN", provider: ctx.provider, model: ctx.model };
      }
      const estimateCents = costOf(price, estimateCallTokens(ctx.iteration), ctx.provider, ctx.model);
      lastEstimateCents = estimateCents;

      const plan = planNextCall(
        { ...ctx, consumedCents, reservedCents, nextCallEstimateCents: estimateCents },
        { usageUnresolved },
      );

      if (plan.kind === "DENY_USAGE_UNRESOLVED") {
        if (!args.budget.enforced) {
          jsonLog("warn", { evt: "ai_budget_usage_unresolved_observed", org: args.organizationId });
          return { kind: "ALLOW", reservationId: args.budget.reservationId, remainingReservedCents: 0 };
        }
        return { kind: "DENY_USAGE_UNRESOLVED", reasonCode: plan.reasonCode };
      }

      if (plan.kind === "ALLOW") {
        return {
          kind: "ALLOW",
          reservationId: args.budget.reservationId,
          remainingReservedCents: Math.max(reservedCents - consumedCents, 0),
        };
      }

      const { data, error } = await supabase.rpc("extend_ai_reservation", {
        p_organization_id: args.organizationId,
        p_reservation_id: args.budget.reservationId,
        p_additional_cents: plan.additionalCents,
      });
      if (error) {
        jsonLog("error", {
          evt: "ai_budget_extend_failed",
          org: args.organizationId,
          err: error.message,
        });
        // Falha de infraestrutura NÃO é franquia esgotada.
        return { kind: "ERROR", retryable: true, sanitizedCode: "extend_failed" };
      }
      const row = Array.isArray(data) ? data[0] : data;
      const decision = mapReserveDecision(row);
      if (decision.kind === "ALLOW") {
        reservedCents = row?.reserved_cents ?? reservedCents;
        consumedCents = row?.consumed_cents ?? consumedCents;
        return decision;
      }
      if (isCommercialHardStop(decision) && !args.budget.enforced) {
        jsonLog("warn", {
          evt: "ai_budget_deny_budget_observed",
          org: args.organizationId,
          note: "flag_off_no_denial",
        });
        return { kind: "ALLOW", reservationId: args.budget.reservationId, remainingReservedCents: 0 };
      }
      return decision;
    },

    async reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string) {
      // Apropriação no MODELO REAL da chamada — a mesma regra da autorização, na
      // ponta que escreve no ledger.
      const price = await loadPrice(supabase, meta.provider, meta.model);
      if (!price) {
        jsonLog("error", {
          evt: "ai_usage_price_vanished",
          org: args.organizationId,
          provider: meta.provider,
          model: meta.model,
        });
        return;
      }

      let usageState: string;
      let usage: AiUsageTokens;
      if (outcome.kind === "USAGE") {
        usageState = "SETTLED";
        usage = outcome.usage;
      } else if (outcome.kind === "PROVIDER_FAILED") {
        // Zero VERDADEIRO: o provedor falhou sem consumo apurável.
        usageState = "PROVIDER_FAILED";
        usage = {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          reasoning_tokens: 0,
        };
      } else {
        // A chamada OCORREU e o custo é indeterminado. NÃO gravar zero e NÃO
        // criar evento aparentemente liquidado: fica a estimativa conservadora
        // comprometida, a reserva sai da expiração automática (senão o TTL vira
        // porta de saída para consumo não contabilizado) e a próxima chamada não
        // é autorizada até resolução administrativa.
        usageState = "USAGE_REVIEW_REQUIRED";
        usage = estimateCallTokens(meta.iteration);
        usageUnresolved = true;
      }

      const cost = priceUsage(price, usage, meta.provider, meta.model);
      if (cost.kind !== "PRICED") {
        jsonLog("error", { evt: "ai_usage_price_unknown_on_report", org: args.organizationId });
        return;
      }

      const { data, error } = await supabase.rpc("record_ai_call_usage", {
        p_organization_id: args.organizationId,
        p_cycle_id: args.budget.cycleId,
        p_reservation_id: args.budget.reservationId,
        p_unit_id: args.unitId,
        p_conversation_id: args.conversationId,
        p_turn_id: meta.turnId,
        p_request_id: meta.requestId,
        p_call_id: meta.callId,
        p_provider: meta.provider,
        p_model: meta.model,
        p_price_id: priceId,
        p_input_tokens: usage.input_tokens,
        p_output_tokens: usage.output_tokens,
        p_cache_read_tokens: usage.cache_read_tokens,
        p_cache_write_tokens: usage.cache_creation_tokens,
        p_reasoning_tokens: usage.reasoning_tokens,
        p_cost_usd: cost.usd,
        p_usd_to_brl: cost.usdToBrl,
        p_cost_brl_cents: usageState === "PROVIDER_FAILED" ? 0 : cost.brlCents,
        p_usage_state: usageState,
        // Idempotência: a MESMA call_id não liquida duas vezes.
        p_idempotency_key: `call:${meta.turnId}:${meta.callId}`,
      });
      if (error) {
        jsonLog("error", {
          evt: "ai_usage_record_failed",
          org: args.organizationId,
          err: error.message,
        });
        // Propaga: apropriação silenciosamente perdida é o pior caso possível —
        // o custo real aconteceu e o orçamento não soube.
        throw new Error("ai_usage_record_failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        reservedCents = row.reserved_cents ?? reservedCents;
        consumedCents = row.consumed_cents ?? consumedCents;
        usageUnresolved = usageUnresolved || !!row.usage_review_required;
      }
    },
  };
}

// ─── Liquidação e marcos ───────────────────────────────────────────────────

export async function finalizeTurn(
  supabase: SupabaseClient,
  args: { organizationId: string; reservationId: string; status: "SETTLED" | "RELEASED" },
): Promise<{ settledCents: number; limitCents: number; state: string } | null> {
  const { data, error } = await supabase.rpc("finalize_ai_reservation", {
    p_organization_id: args.organizationId,
    p_reservation_id: args.reservationId,
    p_final_status: args.status,
  });
  if (error) {
    jsonLog("error", {
      evt: "ai_budget_finalize_failed",
      org: args.organizationId,
      err: error.message,
    });
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return { settledCents: row.settled_cents, limitCents: row.limit_cents, state: row.state };
}

/**
 * Registra os marcos cruzados e enfileira o aviso INTERNO (destinatário é a
 * plataforma, não o lojista).
 *
 * DISCIPLINA DE TRÊS TEMPOS (6b): o INSERT é a BARREIRA DE PERSISTÊNCIA — se ele
 * não grava, nada é enfileirado; só depois de o enfileiramento confirmar é que
 * `notified_at` é carimbado. Inverter reabre um dos dois defeitos opostos: aviso
 * repetido sem teto de um lado, ledger afirmando "avisei" sobre e-mail que nunca
 * saiu do outro.
 *
 * A CADÊNCIA VIVE NO LEDGER: o UNIQUE de `billing_notifications` é parcial e não
 * deduplica com `invoice_id` nulo — e nenhum destes avisos tem fatura.
 *
 * Best-effort: nunca derruba o turno. O custo já está liquidado.
 */
export async function recordMilestones(
  supabase: SupabaseClient,
  args: { organizationId: string; cycleId: string; settledCents: number; limitCents: number },
): Promise<void> {
  // Quais marcos cruzaram é pergunta do núcleo — inclusive o caso do turno caro
  // que salta vários de uma vez.
  const crossed = crossedMilestonePercents(args.settledCents, args.limitCents);
  if (crossed.length === 0) return;

  const recipients = await resolvePlatformAdminRecipients(supabase);
  const recipient = recipients[0] ?? null;
  const dispatchOn = await isFlagEnabled("billing_notifications_dispatch");

  for (const percent of crossed) {
    const { data: inserted, error } = await supabase
      .from("ai_budget_milestones")
      .insert({
        organization_id: args.organizationId,
        cycle_id: args.cycleId,
        milestone_percent: percent,
        settled_cents_at_cross: args.settledCents,
        limit_cents_at_cross: args.limitCents,
        dispatch_enabled_at_enqueue: dispatchOn,
      })
      .select("id")
      .maybeSingle();

    // 23505 = o marco já foi registrado neste ciclo. Cada marco dispara NO
    // MÁXIMO UMA VEZ por ciclo, e a garantia é do UNIQUE, não deste laço.
    if (error) {
      if (error.code !== "23505") {
        jsonLog("error", {
          evt: "ai_budget_milestone_insert_failed",
          org: args.organizationId,
          err: error.message,
        });
      }
      continue;
    }
    if (!inserted) continue;
    if (!recipient) {
      jsonLog("warn", { evt: "ai_budget_milestone_no_recipient", org: args.organizationId, percent });
      continue;
    }

    const queued = await enqueueBillingNotification(supabase, {
      organizationId: args.organizationId,
      // Fonte canônica única do vocabulário de evento — nunca redigitada.
      eventType: EVENT_TYPE_BY_MILESTONE_PERCENT[percent],
      invoiceId: null,
      recipient,
    });

    const { data: stamped, error: stampErr } = await supabase
      .from("ai_budget_milestones")
      .update({
        notified_at: queued ? new Date().toISOString() : null,
        enqueue_attempts: 1,
      })
      .eq("id", inserted.id)
      .eq("organization_id", args.organizationId)
      .select("id");

    // UPDATE que casa ZERO linhas devolve error:null — sem conferir o TAMANHO do
    // retorno, "o predicado de tenant negou" fica indistinguível de "gravei".
    if (stampErr || !stamped || stamped.length === 0) {
      jsonLog("error", {
        evt: "ai_budget_milestone_stamp_missed",
        org: args.organizationId,
        percent,
        err: stampErr?.message ?? "no_rows",
      });
    }
  }
}

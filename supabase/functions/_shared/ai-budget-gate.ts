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
 * hard stop NÃO aplica. Nenhuma negação COMERCIAL acontece — é assim que se vê
 * o custo real por organização ANTES de qualquer bloqueio ligar. A flag é lida
 * por `isFlagEnabled`, que devolve `false` também quando a leitura falha: falhar
 * para o lado de NÃO negar é a direção certa aqui, porque a consequência de
 * negar por engano recai sobre o cliente do restaurante.
 *
 * O MODO OBSERVAÇÃO NÃO ABRANDA PREÇO DESCONHECIDO. Modelo sem preço vigente
 * falha FECHADO em qualquer modo: sem preço não existe `price_id`, que é NOT
 * NULL em `ai_usage_events`, então "medir sem preço" não é uma coisa que exista
 * — a chamada seria consumo real sem nenhum registro possível. Negar é a única
 * saída honesta, e é o que `authorizeAndInvoke` já faz no passo 2, antes mesmo
 * de a decisão chegar aqui.
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

/**
 * Teto de tentativas de enfileiramento do MESMO marco.
 *
 * Existe porque o UNIQUE de `billing_notifications` é PARCIAL e não deduplica
 * com `invoice_id` nulo — que é o caso de todo aviso de marco. Se o carimbo de
 * `notified_at` falhar de forma persistente, o retry re-enfileiraria uma linha
 * por turno, sem fim. Cinco tentativas, com log em cada uma e um log próprio ao
 * esgotar, é preferível a multiplicar aviso sem multiplicar decisão.
 *
 * O TETO SÓ FUNCIONA PORQUE O SLOT É CONSUMIDO NO TOQUE, antes do
 * enfileiramento (ver `recordMilestones`). Incrementar depois de enfileirar
 * deixa o contador parado exatamente no cenário que este teto existe para
 * limitar — e o limite nunca chega.
 *
 * Quem APLICA o teto é a RPC `touch_ai_budget_milestone`, no mesmo UPDATE
 * atômico que incrementa. Este valor é o argumento; a checagem local antes dele
 * é só para poupar I/O.
 */
const MILESTONE_ENQUEUE_MAX_ATTEMPTS = 5;

/** Estados REAIS de um ciclo. Ver `finalizeTurn` para por que a lista importa. */
const CYCLE_STATES = new Set(["OPEN", "EXHAUSTED", "CLOSED"]);

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

/**
 * Resultado da abertura do turno. QUATRO variantes, porque o chamador precisa de
 * quatro consequências diferentes — e distingui-las por conteúdo de string
 * dentro de `sanitizedCode` empurraria a decisão para quem só tem o texto.
 *
 * - `READY`: rode com ganchos, medido. Vem com o `resolvePrice` DO TURNO — passe
 *   o mesmo a `makeBudgetHooks` para que a estimativa da reserva e o ledger
 *   falem da MESMA vigência de preço.
 * - `EXHAUSTED`: teto comercial atingido, com o gate LIGADO. Handoff.
 * - `UNMETERED`: rode NORMALMENTE, sem ganchos e sem medição. É o modo
 *   observação recusando-se a negar — nunca uma falha.
 * - `ERROR`: não deu para abrir o orçamento. `enforced` viaja junto para que o
 *   chamador saiba se o gate estava ligado sem reler a flag.
 */
export type OpenTurnResult =
  | { kind: "READY"; budget: TurnBudget; resolvePrice: PriceResolver }
  | { kind: "EXHAUSTED"; cycleId: string }
  | { kind: "UNMETERED"; reason: string }
  | { kind: "ERROR"; sanitizedCode: string; enforced: boolean };

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

/** Resolve o preço vigente de um par (provider, model). Ver `makePriceCache`. */
export type PriceResolver = (provider: string, model: string) => Promise<AiModelPrice | null>;

/**
 * Resolvedor de preço com cache POR INVOCAÇÃO — não por processo: a Edge
 * Function pode ficar quente e um preço recém-cadastrado precisa valer na
 * próxima requisição, mesma razão de `unitCache` ser zerado no início de cada
 * invocação dos workers.
 *
 * UM RESOLVEDOR POR TURNO, para os QUATRO pontos: a estimativa da reserva em
 * `openTurnBudget` e os três ganchos (`priceFor`, `beforeCall`, `reportCall`).
 * Leituras independentes não custavam só latência (até 24 idas ao banco por
 * turno, dentro do caminho de resposta do WhatsApp): `p_price_id` vinha da
 * resolução do momento da AUTORIZAÇÃO e `cost_brl_cents` de uma leitura fresca no
 * momento do REPORT, então uma vigência trocada no meio do turno gravava evento
 * cujo preço não corresponde ao custo.
 *
 * `openTurnBudget` cria o seu e o DEVOLVE no resultado `READY`; `makeBudgetHooks`
 * o aceita e só cria um próprio se o chamador não passar nada. É o que faz a
 * afirmação acima valer para o turno inteiro, e não só de dentro dos ganchos.
 */
function makePriceCache(supabase: SupabaseClient): PriceResolver {
  const cache = new Map<string, AiModelPrice | null>();
  return async function resolvePrice(provider: string, model: string): Promise<AiModelPrice | null> {
    const key = `${provider}:${model}`;
    if (!cache.has(key)) cache.set(key, await loadPrice(supabase, provider, model));
    return cache.get(key) ?? null;
  };
}

/**
 * Custo em centavos de BRL de um consumo, ou `null` quando não há como precificar.
 *
 * `null`, e não um sentinela numérico: um valor máximo estouraria os parâmetros
 * `integer` das RPCs, e devolver `0` em silêncio é exatamente a falha que esta
 * frente existe para matar. O chamador é obrigado a tratar a ignorância.
 */
function costOf(
  price: AiModelPrice,
  usage: AiUsageTokens,
  provider: string,
  model: string,
): number | null {
  const r = priceUsage(price, usage, provider, model);
  if (r.kind !== "PRICED") return null;
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
    jsonLog("error", {
      evt: "ai_budget_franchise_read_failed",
      org: organizationId,
      err: error.message,
    });
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
 * `ERROR` NÃO é "franquia esgotada" e `UNMETERED` não é falha: as três levam a
 * consequências diferentes e dizem coisas diferentes ao cliente e ao admin. Só
 * `EXHAUSTED` afirma teto, e só quando o gate está ligado.
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
    return { kind: "ERROR", sanitizedCode: "budget_open_failed", enforced };
  }

  if (cycle.state === "EXHAUSTED" && enforced) {
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }

  // Estimativa da reserva inicial, precificada pelo modelo REAL do turno.
  // FAIL-CLOSED em qualquer modo — ver o cabeçalho: sem preço não há `price_id`.
  const resolvePrice = makePriceCache(supabase);
  const price = await resolvePrice(args.provider, args.model);
  if (!price) {
    jsonLog("warn", {
      evt: "ai_price_unknown",
      org: args.organizationId,
      provider: args.provider,
      model: args.model,
    });
    return { kind: "ERROR", sanitizedCode: "price_unknown", enforced };
  }

  let unpriced = false;
  const estimate = estimateTurnCents((usage) => {
    const c = costOf(price, usage, args.provider, args.model);
    if (c === null) {
      unpriced = true;
      return 0;
    }
    return c;
  });
  if (unpriced) {
    jsonLog("error", { evt: "ai_price_unpriceable_estimate", org: args.organizationId });
    return { kind: "ERROR", sanitizedCode: "price_unknown", enforced };
  }

  const { data: reserved, error: resErr } = await supabase.rpc("reserve_ai_budget", {
    p_organization_id: args.organizationId,
    p_cycle_id: cycle.id,
    p_turn_id: args.turnId,
    p_idempotency_key: `turn:${args.turnId}`,
    p_estimate_cents: estimate,
    p_ttl_seconds: AI_RESERVATION_TTL_SECONDS,
    // MODO OBSERVAÇÃO REPASSADO, não reimplementado. Com o gate desligado a RPC
    // cria a reserva mesmo excedendo o disponível ou com usage pendente — sem
    // isso, a organização que estourou o teto rodaria todo turno seguinte sem
    // `reservationId`, logo sem ganchos e sem medição, permanentemente cega no
    // único modo que existe para medi-la. Não é consertável aqui.
    p_observation: !enforced,
  });
  if (resErr) {
    jsonLog("error", {
      evt: "ai_budget_reserve_failed",
      org: args.organizationId,
      err: resErr.message,
    });
    return { kind: "ERROR", sanitizedCode: "reserve_failed", enforced };
  }
  const row = Array.isArray(reserved) ? reserved[0] : reserved;

  const decision = mapReserveDecision(row);

  // REGISTRA, não decide. "Nunca nega, mas SEMPRE registra" — e o registro é
  // gateado em `reason_code` ALÉM de `overrun`, porque quando o único guard
  // contornado foi o de usage pendente `overrun` é `false`: sem isso, um estado
  // PEGAJOSO até resolução administrativa seria contornado a cada turno sem uma
  // linha de log. `mapReserveDecision` descarta `reason_code` no ramo ALLOW, e
  // é por isso que se lê `row` aqui.
  //
  // Gateado também no ALLOW: `reason_code` é não-nulo em toda negação legítima
  // (`insufficient_available`, `prior_usage_unresolved`, `cycle_not_found`), e
  // logar aquilo como contorno diria o contrário do que aconteceu.
  if (decision.kind === "ALLOW" && (row?.overrun || row?.reason_code)) {
    jsonLog("warn", {
      evt: "ai_budget_observed_bypass",
      org: args.organizationId,
      cycle: cycle.id,
      overrun: row.overrun === true,
      bypass: row.reason_code ?? null,
      reserved_cents: row.reserved_cents ?? estimate,
    });
  }
  if (isCommercialHardStop(decision)) {
    if (!enforced) {
      jsonLog("warn", {
        evt: "ai_budget_deny_budget_observed",
        org: args.organizationId,
        note: "flag_off_no_denial",
      });
      // Modo observação: o turno DEVE rodar, e roda sem ganchos. A medição
      // DESTE turno se perde, e é o preço de não bloquear — nunca o contrário.
      return { kind: "UNMETERED", reason: "budget_denied_observed" };
    }
    return { kind: "EXHAUSTED", cycleId: cycle.id };
  }
  if (decision.kind !== "ALLOW") {
    jsonLog("warn", {
      evt: "ai_budget_reserve_not_allowed",
      org: args.organizationId,
      kind: decision.kind,
    });
    return { kind: "ERROR", sanitizedCode: "reserve_not_allowed", enforced };
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
    // Devolvido para ser REPASSADO a `makeBudgetHooks`: a estimativa desta
    // reserva e o preço que o ledger vai gravar passam a vir da mesma vigência.
    resolvePrice,
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
    /** O que `openTurnBudget` devolveu no `READY`. Ver `makePriceCache`. */
    resolvePrice?: PriceResolver;
  },
): AgentBudgetHooks {
  // UM resolvedor por TURNO. Sem o do `openTurnBudget`, a estimativa da reserva
  // e o ledger podem falar de vigências diferentes — sem consequência contábil
  // (a estimativa só dimensiona a reserva), mas a afirmação do cabeçalho deixaria
  // de valer para o turno inteiro.
  const resolvePrice = args.resolvePrice ?? makePriceCache(supabase);
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

    async priceFor(provider: string, model: string): Promise<PriceLookup> {
      const price = await resolvePrice(provider, model);
      if (!price) {
        // Registro sanitizado: provedor e modelo. NUNCA a credencial da unidade.
        // FAIL-CLOSED em qualquer modo — o autorizador nega no passo 2 e a
        // chamada não acontece. Ver o cabeçalho do arquivo.
        jsonLog("warn", { evt: "ai_price_unknown", provider, model });
        return { kind: "PRICE_UNKNOWN", provider, model };
      }
      return { kind: "PRICED", priceId: price.id };
    },

    snapshot(iteration: number, provider: string, model: string) {
      // NÃO CONFIE NESTE NÚMERO. `nextCallEstimateCents` aqui é o último valor
      // calculado — defasado em uma chamada e precificado no modelo da chamada
      // ANTERIOR. Nada autoriza sobre ele: `beforeCall` recarrega o preço de
      // `ctx.provider`/`ctx.model` e RECALCULA a estimativa antes de decidir, e é
      // lá que mora a garantia de cobertura. Provedor e modelo estão na
      // assinatura para que o contrato não minta para um adapter futuro.
      void iteration;
      void provider;
      void model;
      return { consumedCents, reservedCents, nextCallEstimateCents: lastEstimateCents };
    },

    async beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision> {
      // O PREÇO É DO MODELO REAL DESTA CHAMADA. `ctx.nextCallEstimateCents` chega
      // precificado no modelo do INÍCIO DO TURNO; confiar nele autoriza a
      // tentativa de fallback (Pro) com a folga do modelo barato (Flash), que é
      // subcontabilização direta. Recarrega-se e recalcula-se aqui, sempre.
      const price = await resolvePrice(ctx.provider, ctx.model);
      if (!price) {
        // FAIL-CLOSED, inclusive em modo observação: sem preço não há `price_id`
        // (NOT NULL) e o evento não pode existir. Ver o cabeçalho do arquivo.
        return { kind: "DENY_PRICE_UNKNOWN", provider: ctx.provider, model: ctx.model };
      }
      const estimateCents = costOf(price, estimateCallTokens(ctx.iteration), ctx.provider, ctx.model);
      if (estimateCents === null) {
        return { kind: "DENY_PRICE_UNKNOWN", provider: ctx.provider, model: ctx.model };
      }
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
      // Apropriação no MODELO REAL da chamada, pela MESMA linha de preço que o
      // autorizador usou para resolver `priceId` — é o mesmo cache.
      const price = await resolvePrice(meta.provider, meta.model);
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

export interface FinalizeResult {
  /**
   * `false` = a reserva JÁ estava finalizada e a RPC não reprocessou (caminho
   * idempotente). Os números abaixo continuam sendo os do ciclo, e valem.
   */
  finalized: boolean;
  settledCents: number;
  limitCents: number;
  state: string;
}

/**
 * Liquida (`SETTLED`) ou libera (`RELEASED`) a reserva do turno.
 *
 * `null` = a RPC NÃO APLICOU e não devolveu números de ciclo nenhum. Os três
 * casos (`RESERVATION_NOT_FOUND`, `CYCLE_NOT_FOUND`, `INVALID_STATUS`) vêm com
 * `settled_cents = 0` e `limit_cents = 0` — indistinguíveis de um ciclo
 * legitimamente zerado, e `crossedMilestonePercents(0, 0)` devolve lista vazia:
 * um finalize que nunca aconteceu silenciaria TODO alerta de marco. Por isso o
 * discriminador é o `state`: se não é um estado real de ciclo, é sentinela de
 * erro e vira `null` com log — nunca instantâneo plausível.
 *
 * `finalized: false` COM estado real é outra coisa, e é legítima: a reserva já
 * havia sido finalizada antes (reexecução idempotente) e os números do ciclo
 * continuam valendo para os marcos.
 */
export async function finalizeTurn(
  supabase: SupabaseClient,
  args: { organizationId: string; reservationId: string; status: "SETTLED" | "RELEASED" },
): Promise<FinalizeResult | null> {
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
  if (!CYCLE_STATES.has(row.state)) {
    jsonLog("error", {
      evt: "ai_budget_finalize_not_applied",
      org: args.organizationId,
      code: row.state,
    });
    return null;
  }
  return {
    finalized: row.finalized === true,
    settledCents: row.settled_cents,
    limitCents: row.limit_cents,
    state: row.state,
  };
}

/**
 * Registra os marcos cruzados e enfileira o aviso INTERNO (destinatário é a
 * plataforma, não o lojista).
 *
 * DISCIPLINA DE TRÊS TEMPOS (6b), na ordem exata: TOCA → ENFILEIRA → CARIMBA.
 *
 * O TOQUE é um UPDATE que **não registra envio** — ele consome o slot
 * (`enqueue_attempts + 1`) e prova que a linha é gravável. Contar depois de
 * enfileirar deixa o contador parado justamente quando a escrita falha, e como o
 * UNIQUE de `billing_notifications` é PARCIAL (não deduplica com `invoice_id`
 * nulo, o caso de todo aviso daqui), cada passada enfileiraria um aviso idêntico
 * sem o teto jamais ser alcançado. Inverter para enfileirar-antes-de-tocar
 * reabre o defeito oposto: ledger dizendo "avisei" sobre e-mail que nunca saiu.
 *
 * O INSERT continua sendo a barreira ANTERIOR a tudo isso — se o marco não entra
 * no ledger, nada é tocado nem enfileirado. A CRIAÇÃO também consome o slot: o
 * marco recém-inserido passa pelos mesmos três tempos.
 *
 * RETRY DO AVISO, não do registro: `23505` no INSERT quer dizer que o marco já
 * está no ledger, e o índice parcial `where notified_at is null` da migration 103
 * existe exatamente para reencontrar o marco cujo AVISO não saiu. Sem este
 * caminho, uma falha transitória em resolver o destinatário perderia o aviso para
 * sempre — inclusive o do marco de 100%, que é o que mais importa.
 *
 * A CADÊNCIA VIVE NO LEDGER: o UNIQUE de `billing_notifications` é parcial e não
 * deduplica com `invoice_id` nulo — e nenhum destes avisos tem fatura. Quem
 * impede a repetição é `notified_at`, não a fila.
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

  // PREGUIÇOSOS: a partir de 70% esta função roda a cada turno e, na esmagadora
  // maioria das vezes, todo marco já está registrado e avisado. Resolver
  // destinatário (que faz chamada ao Auth Admin) e ler flag antes de saber se há
  // algo a enfileirar seria I/O por turno para nada.
  let recipientCache: { value: string | null } | null = null;
  const recipientOnce = async (): Promise<string | null> => {
    if (!recipientCache) {
      recipientCache = { value: (await resolvePlatformAdminRecipients(supabase))[0] ?? null };
    }
    return recipientCache.value;
  };
  let dispatchCache: { value: boolean } | null = null;
  const dispatchOnce = async (): Promise<boolean> => {
    if (!dispatchCache) {
      dispatchCache = { value: await isFlagEnabled("billing_notifications_dispatch") };
    }
    return dispatchCache.value;
  };

  for (const percent of crossed) {
    const { data: inserted, error } = await supabase
      .from("ai_budget_milestones")
      .insert({
        organization_id: args.organizationId,
        cycle_id: args.cycleId,
        milestone_percent: percent,
        settled_cents_at_cross: args.settledCents,
        limit_cents_at_cross: args.limitCents,
      })
      .select("id, notified_at, enqueue_attempts")
      .maybeSingle();

    type LedgerRow = { id: string; notified_at: string | null; enqueue_attempts: number };
    let ledger = (inserted ?? null) as LedgerRow | null;

    if (error) {
      // 23505 = o marco já foi registrado neste ciclo. Cada marco dispara NO
      // MÁXIMO UMA VEZ por ciclo, e a garantia é do UNIQUE, não deste laço — mas
      // o AVISO pode não ter saído, e é isso que se reencontra aqui.
      if (error.code !== "23505") {
        jsonLog("error", {
          evt: "ai_budget_milestone_insert_failed",
          org: args.organizationId,
          err: error.message,
        });
        continue;
      }
      const { data: existing, error: readErr } = await supabase
        .from("ai_budget_milestones")
        .select("id, notified_at, enqueue_attempts")
        .eq("organization_id", args.organizationId)
        .eq("cycle_id", args.cycleId)
        .eq("milestone_percent", percent)
        .maybeSingle();
      if (readErr || !existing) {
        jsonLog("error", {
          evt: "ai_budget_milestone_reread_failed",
          org: args.organizationId,
          percent,
          err: readErr?.message ?? "no_row",
        });
        continue;
      }
      ledger = existing as LedgerRow;
    }

    if (!ledger) continue;
    // Curto-circuitos BARATOS, não autoridade: evitam a chamada ao Auth Admin no
    // caso esmagadoramente comum (marco já avisado, toda passada a partir de
    // 70%). Quem DECIDE são as duas condições no WHERE do toque, sob a
    // atomicidade do UPDATE — reler aqui não protege de concorrência.
    if (ledger.notified_at) continue;
    if ((ledger.enqueue_attempts ?? 0) >= MILESTONE_ENQUEUE_MAX_ATTEMPTS) {
      jsonLog("error", {
        evt: "ai_budget_milestone_enqueue_exhausted",
        org: args.organizationId,
        percent,
        attempts: ledger.enqueue_attempts ?? 0,
      });
      continue;
    }

    const recipient = await recipientOnce();
    if (!recipient) {
      // Sem destinatário o slot NÃO é consumido: nada é tocado, e a próxima
      // passada tenta de novo.
      jsonLog("warn", { evt: "ai_budget_milestone_no_recipient", org: args.organizationId, percent });
      continue;
    }

    // TEMPO 1 — TOCA, via RPC. O incremento é do SERVIDOR
    // (`enqueue_attempts + 1` avaliado no banco), não um read-modify-write:
    // dois turnos concorrentes da mesma organização cruzando o mesmo marco leem
    // 0, ambos gravariam 1, ambos enfileirariam — duas linhas `pending` sem
    // dedupe (UNIQUE parcial, `invoiceId` nulo) e um slot consumido a menos que o
    // real. O toque NÃO registra envio: prova que a linha é gravável e consome o
    // slot ANTES de qualquer coisa entrar na fila.
    const { data: touchData, error: touchErr } = await supabase.rpc("touch_ai_budget_milestone", {
      p_organization_id: args.organizationId,
      p_milestone_id: ledger.id,
      p_max_attempts: MILESTONE_ENQUEUE_MAX_ATTEMPTS,
    });
    const touch = Array.isArray(touchData) ? touchData[0] : touchData;
    if (touchErr || !touch?.touched) {
      jsonLog("error", {
        evt: "ai_budget_milestone_touch_failed",
        org: args.organizationId,
        percent,
        reason: touch?.reason ?? null,
        err: touchErr?.message ?? "not_touched",
      });
      continue;
    }

    // TEMPO 2 — ENFILEIRA.
    const queued = await enqueueBillingNotification(supabase, {
      organizationId: args.organizationId,
      // Fonte canônica única do vocabulário de evento — nunca redigitada.
      eventType: EVENT_TYPE_BY_MILESTONE_PERCENT[percent],
      invoiceId: null,
      recipient,
    });
    if (!queued) {
      // O slot já foi consumido no toque: a próxima passada tenta de novo até o
      // teto, e `notified_at` continua nulo, que é a verdade.
      jsonLog("error", { evt: "ai_budget_milestone_enqueue_failed", org: args.organizationId, percent });
      continue;
    }

    // TEMPO 3 — CARIMBA. Só agora o ledger pode afirmar "avisei".
    const { data: stamped, error: stampErr } = await supabase
      .from("ai_budget_milestones")
      .update({
        notified_at: new Date().toISOString(),
        // O nome da coluna é `..._at_enqueue`: o valor pertence ao momento do
        // ENFILEIRAMENTO, não ao do registro do marco.
        dispatch_enabled_at_enqueue: await dispatchOnce(),
      })
      .eq("id", ledger.id)
      .eq("organization_id", args.organizationId)
      .select("id");

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

/**
 * Núcleo PURO do protocolo de autorização financeira POR CHAMADA (spec §17.7.3).
 *
 * POR QUE ESTE ARQUIVO EXISTE SEPARADO DE ai-providers.ts: aquele importa
 * `https://esm.sh/@anthropic-ai/sdk` e vitest não o alcança. Regra de decisão
 * escrita lá só é verificável por LEITURA — e leitura já deixou passar um
 * `ReferenceError` de autorização e um conflito FK × CHECK por duas auditorias
 * na 6b. Aqui a ordem é testada de verdade, com dependências injetadas, e os
 * cinco runners viram adaptadores finos.
 *
 * O CONTRATO VALE PARA OS CINCO PROVEDORES — claude, openai, gemini, grok e
 * deepseek. Implementar o gancho só no Gemini (o mais exercitado, o único com
 * fallback) o tornaria "o único testado".
 *
 * A CHAMADA DE FALLBACK NÃO HERDA A AUTORIZAÇÃO DA PRIMEIRA: quem chama esta
 * função uma segunda vez com outro `model` obtém preço próprio, autorização
 * própria e `call_id` próprio. Cobrar Pro a preço de Flash é subcontabilização
 * direta.
 */

import { classifyUsage, type AiUsageTokens } from "./ai-price-core.ts";
import type { BeforeCallContext, BeforeCallDecision } from "./ai-budget-core.ts";

/** Identidade e contexto de UMA chamada HTTP ao provedor. */
export interface AgentCallMeta {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  provider: string;
  /** Modelo REAL desta chamada — nunca o modelo inicial do turno. */
  model: string;
  callId: string;
  /** 1-based. */
  iteration: number;
  maxIterations: number;
}

/**
 * Desfecho financeiro de uma chamada que chegou ao provedor.
 *
 * As três variantes existem porque zero significa coisas diferentes: em
 * `PROVIDER_FAILED` sabe-se que nada foi consumido; em `NO_USAGE` a chamada
 * OCORREU e o custo é indeterminado — e tratar as duas igual é exatamente o
 * buraco que resposta vazia + fallback abriria.
 */
export type AgentCallOutcome =
  | { kind: "USAGE"; usage: AiUsageTokens }
  | { kind: "NO_USAGE" }
  | { kind: "PROVIDER_FAILED"; error: unknown };

export type ProviderInvokeResult =
  | { kind: "OK"; value: unknown; rawUsage: unknown }
  | { kind: "FAILED"; error: unknown };

export type PriceLookup =
  | { kind: "PRICED"; priceId: string }
  | { kind: "PRICE_UNKNOWN"; provider: string; model: string };

export interface AuthorizerDeps {
  /** Preço vigente do modelo REAL desta chamada. */
  priceFor(provider: string, model: string): Promise<PriceLookup>;
  beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision>;
  /** Executa a chamada HTTP. Nunca é chamada quando a decisão é negativa. */
  invoke(meta: AgentCallMeta): Promise<ProviderInvokeResult>;
  /**
   * Aproprie custo e estado DENTRO da reserva. É AGUARDADA: o consumo de cada
   * chamada precisa estar apropriado antes da próxima autorização, senão a 2ª
   * decide com o saldo de antes da 1ª.
   */
  reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string): Promise<void>;
  newCallId(): string;
}

/** Tudo o que o chamador sabe antes de gerar a identidade da chamada. */
export interface AuthorizedCallBase {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  provider: string;
  model: string;
  iteration: number;
  maxIterations: number;
  consumedCents: number;
  reservedCents: number;
  nextCallEstimateCents: number;
}

export type AuthorizedCall =
  | { kind: "EXECUTED"; result: ProviderInvokeResult; outcome: AgentCallOutcome; meta: AgentCallMeta }
  | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta };

/**
 * A ORDEM É O CONTRATO (§17.7.3):
 *   1. resolver provider e modelo (feito pelo chamador, chega em `base`);
 *   2. verificar preço vigente;
 *   3. chamar beforeCall;
 *   4. receber ALLOW com cobertura;
 *   5. executar a chamada;
 *   6. receber usage;
 *   7. calcular o custo real (no adapter, a partir do outcome);
 *   8. avançar consumed_cents de forma atômica e idempotente;
 *   9. atualizar o saldo restante da reserva;
 *  10. só então permitir a próxima iteração.
 *
 * O passo 2 vem ANTES do 3 de propósito: negar por preço desconhecido não deve
 * consumir uma tentativa de reserva nem produzir alerta de orçamento — são
 * causas, copys, telemetrias e possibilidades de retry diferentes.
 */
export async function authorizeAndInvoke(
  b: AuthorizedCallBase,
  deps: AuthorizerDeps,
): Promise<AuthorizedCall> {
  const meta: AgentCallMeta = {
    organizationId: b.organizationId,
    cycleId: b.cycleId,
    turnId: b.turnId,
    requestId: b.requestId,
    reservationId: b.reservationId,
    provider: b.provider,
    model: b.model,
    callId: deps.newCallId(),
    iteration: b.iteration,
    maxIterations: b.maxIterations,
  };

  // 2. Preço vigente do modelo REAL. Fail-closed: nenhuma chamada, nenhum
  //    custo zero, nenhum preço de "modelo semelhante", nenhum fallback
  //    silencioso. Custo operacional aceitável e preferível a furar o teto.
  const price = await deps.priceFor(b.provider, b.model);
  if (price.kind === "PRICE_UNKNOWN") {
    return {
      kind: "DENIED",
      decision: { kind: "DENY_PRICE_UNKNOWN", provider: price.provider, model: price.model },
      meta,
    };
  }

  // 3-4. Autorização financeira. A decisão negada é PROPAGADA INTACTA: o
  //      chamador precisa distinguir teto atingido de falha de infraestrutura,
  //      porque as duas dizem coisas opostas ao cliente e ao admin.
  const ctx: BeforeCallContext = {
    organizationId: b.organizationId,
    cycleId: b.cycleId,
    turnId: b.turnId,
    requestId: b.requestId,
    provider: b.provider,
    model: b.model,
    iteration: b.iteration,
    maxIterations: b.maxIterations,
    reservationId: b.reservationId,
    consumedCents: b.consumedCents,
    reservedCents: b.reservedCents,
    nextCallEstimateCents: b.nextCallEstimateCents,
  };
  const decision = await deps.beforeCall(ctx);
  if (decision.kind !== "ALLOW") {
    return { kind: "DENIED", decision, meta };
  }

  // 5. Só aqui existe I/O externo.
  const result = await deps.invoke(meta);

  // 6. Classificação do desfecho. `NO_USAGE` NÃO é consumo zero.
  let outcome: AgentCallOutcome;
  if (result.kind === "FAILED") {
    outcome = { kind: "PROVIDER_FAILED", error: result.error };
  } else {
    const c = classifyUsage(result.rawUsage);
    outcome = c.kind === "USABLE" ? { kind: "USAGE", usage: c.usage } : { kind: "NO_USAGE" };
  }

  // 8-9. AGUARDADO. Uma exceção aqui PROPAGA: apropriação silenciosamente
  //      perdida é o pior caso possível — o custo real aconteceu e o orçamento
  //      não soube. O chamador trata como erro do agente (auto-handoff), e a
  //      reserva continua HELD até liquidação ou expiração.
  await deps.reportCall(meta, outcome, price.priceId);

  return { kind: "EXECUTED", result, outcome, meta };
}

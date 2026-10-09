import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.3";
import { fetchWithRetry } from "./retry.ts";
import {
  authorizeAndInvoke,
  type AgentCallMeta,
  type AgentCallOutcome,
  type AuthorizedCall,
  type PriceLookup,
} from "./ai-call-authorizer-core.ts";
import type { BeforeCallContext, BeforeCallDecision } from "./ai-budget-core.ts";
import {
  AgentDeadlineError,
  isAgentDeadlineError,
  mayStartAnotherRound,
} from "./agent-deadline-core.ts";

export type { AgentCallMeta, AgentCallOutcome, BeforeCallDecision };
// Reexportados para que o chamador do loop (hoje `webhook-whatsapp`) importe a
// marca do deadline do MESMO lugar de onde importa `runAgentLoop` — e não
// precise saber que a decisão mora num núcleo puro à parte.
export { AgentDeadlineError, isAgentDeadlineError };

// ─── Types ────────────────────────────────────────────────────────────────────

export type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /**
   * OpenAI `completion_tokens_details.reasoning_tokens` e Gemini
   * `thoughtsTokenCount`. OPCIONAL para não quebrar caller existente; ausente é
   * tratado como zero em telemetria — mas o caminho de ORÇAMENTO usa
   * `ai-price-core.ts`, onde token de raciocínio sem faixa própria é cobrado
   * como output, nunca como grátis.
   */
  reasoning_tokens?: number;
}

/**
 * Autorização financeira POR CHAMADA (Plano D, spec §17.7).
 *
 * AUSENTE = comportamento de hoje, byte a byte: nenhuma autorização, nenhuma
 * apropriação, nenhum custo persistido. É o que mantém fora deste caminho as
 * organizações com override vitalício (Ren Sushi), a carteira legada e o BYOK
 * puro — nenhuma delas tem franquia, e nenhuma pode ser afetada por ela.
 *
 * `snapshot()` é lido ANTES de cada chamada: o adapter mantém consumido e
 * reservado atualizados a cada `reportCall`, e é isso que permite revalidar por
 * chamada sem consultar o ledger financeiro inteiro a cada iteração.
 */
export interface AgentBudgetHooks {
  organizationId: string;
  cycleId: string;
  turnId: string;
  requestId: string;
  reservationId: string;
  priceFor(provider: string, model: string): Promise<PriceLookup>;
  beforeCall(ctx: BeforeCallContext): Promise<BeforeCallDecision>;
  reportCall(meta: AgentCallMeta, outcome: AgentCallOutcome, priceId: string): Promise<void>;
  newCallId(): string;
  /**
   * Estado corrente da reserva + estimativa já precificada da próxima chamada.
   * SÍNCRONO de propósito: quem faz I/O de preço é o `beforeCall`, que já é async.
   *
   * RECEBE PROVEDOR E MODELO para que o contrato não minta. `nextCallEstimateCents`
   * é a estimativa pré-chamada que viaja no `BeforeCallContext`, e `planNextCall`
   * a compara contra `reserved − consumed` para decidir ALLOW vs EXTEND. Só com a
   * iteração, o número entregue aqui seria precificado no modelo do TURNO — e a
   * tentativa de fallback do Gemini (Pro, ordem de grandeza mais caro por Mtok que
   * Flash) chegaria ao autorizador com folga de Flash.
   *
   * Defesa em profundidade, não correção de sub-reserva ativa: o adapter recalcula
   * a estimativa a partir de `ctx.provider`/`ctx.model` dentro do `beforeCall`, e
   * é LÁ que mora a garantia de que a cobertura é a do modelo real. O que se
   * conserta aqui é o contrato — para que um adapter futuro que confie no valor
   * recebido não autorize Pro com folga de Flash.
   */
  snapshot(iteration: number, provider: string, model: string): {
    consumedCents: number;
    reservedCents: number;
    nextCallEstimateCents: number;
  };
}

/**
 * O loop deixou de devolver só texto porque "parei porque o orçamento acabou"
 * e "terminei de responder" exigem consequências opostas: handoff com razão
 * própria, copy determinística e alerta administrativo num caso; envio normal
 * no outro. Devolver `""` para o primeiro apagaria a diferença.
 */
export type AgentLoopResult =
  | { kind: "TEXT"; text: string }
  | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta };

export interface AgentLoopOptions {
  provider: AIProvider;
  apiKey: string;
  model?: string;
  systemPrompt: string;
  history: AgentMessage[];
  userMessage: string;
  tools: AgentTool[];
  onToolCall: (name: string, input: any) => Promise<string>;
  /** Cap context window via truncation. Default: DEFAULT_HISTORY_CAP most recent messages. */
  maxHistoryMessages?: number;
  /** Token budget só pro histórico. Default: DEFAULT_HISTORY_TOKEN_CAP. */
  maxHistoryTokens?: number;
  /** Hard timeout per HTTP call in ms. Default: 45_000 (Edge Function limit is 60s). */
  requestTimeoutMs?: number;
  /** Telemetry callback fired once per HTTP turn (the loop may have multiple). */
  onUsage?: (usage: AgentUsage) => void;
  /** Plano D. Ausente = nenhuma autorização financeira (comportamento legado). */
  budget?: AgentBudgetHooks;
  /**
   * Deadline SUAVE (Fase C). Checado no topo de cada rodada: `false` impede
   * COMEÇAR outra, e a rodada em curso termina normalmente.
   *
   * Abortar no meio deixaria reserva criada e cliente sem resposta — o risco
   * que `mutatingToolUsed` já tenta cobrir. AUSENTE = comportamento de hoje,
   * exato: quem não passa a opção não tem rodada recusada por prazo nenhum.
   *
   * O loop NÃO conhece relógio: quem sabe quando o prazo venceu é quem passa a
   * função. Aqui só se pergunta.
   */
  shouldContinue?: () => boolean;
}

export const DEFAULT_MODELS: Record<AIProvider, string> = {
  claude: "claude-haiku-4-5",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
  grok: "grok-3",
  deepseek: "deepseek-chat",
};

// Fallback de modelo dentro do mesmo provider para erros 5xx persistentes
// (modelo principal saturado regionalmente). Cotas TPM são tipicamente
// separadas entre modelos do mesmo provider, então `pro` continua atendendo
// enquanto `flash` está sobrecarregado. Null = não há fallback configurado.
// Conservador: só Gemini hoje, porque é o caso real observado em produção.
export const FALLBACK_MODELS: Record<AIProvider, string | null> = {
  claude: null,
  openai: null,
  gemini: "gemini-2.5-pro",
  grok: null,
  deepseek: null,
};

// Lista de modelos conhecidos (espelha `MODELS_BY_PROVIDER` em src/lib/aiModels.ts).
// Blindagem: settings.ai_config.models[provider] pode ter valor legado de antes do
// Select curado (vimos `gemini-2.0-flash` salvo em produção depois que o Google o
// descontinuou — provoca 404 silencioso → agent_error). Se o modelo override não
// está aqui, `resolveModel` ignora e usa o default. Mantenha sincronizado com:
//   - src/lib/aiModels.ts MODELS_BY_PROVIDER (UI)
//   - DEFAULT_MODELS acima (este arquivo)
//   - DEFAULT_MODEL_BY_PROVIDER em src/lib/aiModels.ts
const KNOWN_MODELS: Record<AIProvider, ReadonlySet<string>> = {
  claude: new Set(["claude-haiku-4-5", "claude-sonnet-4-6"]),
  openai: new Set(["gpt-4o", "gpt-4o-mini"]),
  gemini: new Set(["gemini-2.5-flash", "gemini-2.5-pro"]),
  grok: new Set(["grok-3"]),
  deepseek: new Set(["deepseek-chat"]),
};

/**
 * Resolve o modelo final a ser usado:
 *   - se `override` está em KNOWN_MODELS[provider] → usa ele
 *   - senão (vazio, descontinuado, digitado errado) → usa DEFAULT_MODELS[provider]
 * Retorna o nome do modelo + flag indicando se houve fallback (pra log/telemetria).
 */
export function resolveModel(provider: AIProvider, override?: string): { model: string; fellBack: boolean; rejected?: string } {
  const def = DEFAULT_MODELS[provider];
  const trimmed = (override ?? "").trim();
  if (!trimmed) return { model: def, fellBack: false };
  if (KNOWN_MODELS[provider]?.has(trimmed)) return { model: trimmed, fellBack: false };
  return { model: def, fellBack: true, rejected: trimmed };
}

const OPENAI_BASE_URLS: Partial<Record<AIProvider, string>> = {
  openai: "https://api.openai.com/v1",
  grok: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
};

/**
 * Preços em USD por milhão de tokens — TELEMETRIA APENAS.
 *
 * ESTE CAMINHO NÃO É O DO ORÇAMENTO. `estimateCostUsd` devolve `0` para modelo
 * desconhecido, e no caminho protegido por franquia esse zero significaria
 * consumo ilimitado sem nunca tocar o teto. O caminho de orçamento usa
 * `ai-price-core.ts` contra a tabela versionada `ai_model_prices`, onde a
 * ausência de preço tem tipo próprio (`PRICE_UNKNOWN`) e falha FECHADO.
 *
 * Telemetria pura pode tolerar desconhecido; orçamento, não. As duas coexistem
 * de propósito — não unificar sem mover o log `agent_usage` para a tabela.
 *
 * Segue valores públicos de cada provedor (atualizar quando mudarem).
 */
const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-haiku-4-5":   { input: 1,    output: 5,   cache_read: 0.10, cache_write: 1.25 },
  "claude-sonnet-4-6":  { input: 3,    output: 15,  cache_read: 0.30, cache_write: 3.75 },
  "claude-opus-4-7":    { input: 15,   output: 75,  cache_read: 1.50, cache_write: 18.75 },
  "gpt-4o":             { input: 2.50, output: 10,  cache_read: 1.25, cache_write: 0 },
  "gpt-4o-mini":        { input: 0.15, output: 0.60, cache_read: 0.075, cache_write: 0 },
  "gemini-2.0-flash":   { input: 0.10, output: 0.40, cache_read: 0.025, cache_write: 0 },
  "gemini-2.5-flash":   { input: 0.15, output: 0.60, cache_read: 0.0375, cache_write: 0 },
  "grok-3":             { input: 3,    output: 15,  cache_read: 0,    cache_write: 0 },
  "deepseek-chat":      { input: 0.27, output: 1.10, cache_read: 0.07, cache_write: 0 },
};

export function estimateCostUsd(model: string, usage: AgentUsage): number {
  const p = PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  const cost =
    (usage.input_tokens * p.input) / 1_000_000 +
    (usage.output_tokens * p.output) / 1_000_000 +
    (usage.cache_read_tokens * p.cache_read) / 1_000_000 +
    (usage.cache_creation_tokens * p.cache_write) / 1_000_000;
  return Number(cost.toFixed(6));
}

const MAX_ITERATIONS = 12;
const DEFAULT_HISTORY_CAP = 20;
// Limite estimado de tokens só para o histórico (não inclui system prompt,
// tools, nem userMessage). 1500 tokens ≈ ~6000 caracteres ≈ ~15 mensagens
// médias em PT-BR. Caps por NÚMERO sozinho subestimam custo quando mensagens
// são longas (descrições de reserva, listas de horários repetidos pelo bot).
const DEFAULT_HISTORY_TOKEN_CAP = 1500;
// Timeout por TENTATIVA HTTP. Reduzido pra 12s pra acomodar fallback de modelo
// no Gemini: primary 1 tentativa + fallback 3 tentativas + esperas ≈ 51s,
// cabendo nos 60s da Edge Function. Modelos LLM tipicamente respondem em 2-5s.
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
// Retentar 2x em 5xx/429/network: Gemini retorna 503 transitório com frequência;
// outros providers ocasionalmente também. Backoff 1s/2s + jitter.
const DEFAULT_HTTP_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

// Estimativa grosseira: em PT-BR, 1 token ≈ 4 caracteres (incluindo espaços e
// pontuação). Não é exato pra qualquer tokenizer (Claude/OpenAI/Gemini cada
// um tem o seu), mas o objetivo aqui é cortar histórico cedo, não cobrança.
// Errar pra mais é OK — corta um pouco antes; errar pra menos seria pior.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mantém só as últimas `cap` mensagens E corta por `tokenCap` tokens estimados.
 *
 * Dois passes:
 * 1) Corte por NÚMERO (`cap`): pega últimas N mensagens (proteção contra
 *    históricos com 100+ entradas).
 * 2) Corte por TOKENS (`tokenCap`): se a soma estimada das últimas N ainda
 *    estoura o teto, drop do COMEÇO (mensagens mais antigas) até caber.
 *    O turno atual (userMessage) NÃO conta aqui — é adicionado depois pelo
 *    runner.
 *
 * Em ambos os casos, garante que a primeira mensagem do array final seja
 * `role: 'user'` (Anthropic e OpenAI rejeitam histórico iniciado com assistant).
 */
export function truncateHistory(
  history: AgentMessage[],
  cap = DEFAULT_HISTORY_CAP,
  tokenCap = DEFAULT_HISTORY_TOKEN_CAP,
): AgentMessage[] {
  // Pass 1: corte por número
  let trimmed = history.length > cap ? history.slice(-cap) : [...history];

  // Pass 2: corte por tokens — drop do começo até caber. Soma do fim pro
  // começo, mantendo as mensagens mais recentes (mais relevantes).
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  while (trimmed.length > 0 && totalTokens > tokenCap) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped.content);
  }

  // Garante que começa com role: 'user'
  while (trimmed.length > 0 && trimmed[0].role !== "user") {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout existe em Deno modernos, mas usamos polyfill manual
  // para garantir compat se a edge runtime ainda for antiga.
  if (typeof (AbortSignal as any).timeout === "function") {
    return (AbortSignal as any).timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// ─── Chamada autorizada ───────────────────────────────────────────────────────

/**
 * Torna um erro de provedor seguro para LOG, TELEMETRIA e PERSISTÊNCIA.
 *
 * A chave de IA é per-unit (BYOK) e não pode aparecer em lugar nenhum. Dois
 * vetores reais: (a) a URL do Gemini carrega `?key=<chave>` e a mensagem de erro
 * de rede do runtime ecoa a URL inteira; (b) erro de SDK que reproduz o request
 * pode trazer o header `Authorization: Bearer <chave>`. É por isso que a
 * variante `PROVIDER_FAILED` de `AgentCallOutcome` — que carrega o erro CRU —
 * traz no próprio tipo a obrigação de sanitizar no adapter: o adapter é aqui.
 *
 * O erro ORIGINAL continua sendo relançado ao chamador (controle de fluxo, não
 * log): o webhook segue tratando exceção do provedor exatamente como sempre.
 */
export function sanitizeProviderError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : "erro desconhecido do provedor";
  return raw
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:x-api-key|api[_-]?key|authorization)["'\s:=]+)\S{8,}/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-|sk-ant-|xai-|AIza)[A-Za-z0-9._-]{6,}/g, "[REDACTED]")
    .slice(0, 300);
}

/**
 * Executa UMA chamada ao provedor, autorizada quando há orçamento.
 *
 * Sem `opts.budget`: chama direto e reporta `onUsage` — exatamente o que o
 * código fazia antes desta frente.
 *
 * Com `opts.budget`: delega ao núcleo puro `authorizeAndInvoke`, que fixa a
 * ordem preço → autorização → chamada → apropriação (§17.7.3). O helper NÃO
 * decide nada; ele só liga os fios.
 *
 * `invoke` recebe o modelo REAL e devolve `{ value, rawUsage }`. Um erro
 * lançado lá dentro vira `PROVIDER_FAILED` (consumo zero VERDADEIRO) e é
 * relançado ao chamador depois de reportado — o loop continua tratando exceção
 * do provedor como sempre tratou.
 */
async function callWithBudget<T>(
  opts: AgentLoopOptions,
  spec: {
    provider: AIProvider;
    model: string;
    iteration: number;
    invoke: () => Promise<{ value: T; rawUsage: unknown }>;
  },
): Promise<
  { kind: "OK"; value: T } | { kind: "DENIED"; decision: BeforeCallDecision; meta: AgentCallMeta }
> {
  const b = opts.budget;

  if (!b) {
    const r = await spec.invoke();
    if (opts.onUsage && r.rawUsage) opts.onUsage(r.rawUsage as AgentUsage);
    return { kind: "OK", value: r.value };
  }

  const snap = b.snapshot(spec.iteration, spec.provider, spec.model);
  let thrown: unknown = null;

  const authorized: AuthorizedCall = await authorizeAndInvoke(
    {
      organizationId: b.organizationId,
      cycleId: b.cycleId,
      turnId: b.turnId,
      requestId: b.requestId,
      reservationId: b.reservationId,
      provider: spec.provider,
      model: spec.model,
      iteration: spec.iteration,
      maxIterations: MAX_ITERATIONS,
      consumedCents: snap.consumedCents,
      reservedCents: snap.reservedCents,
      nextCallEstimateCents: snap.nextCallEstimateCents,
    },
    {
      priceFor: (provider, model) => b.priceFor(provider, model),
      beforeCall: (ctx) => b.beforeCall(ctx),
      reportCall: (meta, outcome, priceId) => b.reportCall(meta, outcome, priceId),
      newCallId: () => b.newCallId(),
      invoke: async () => {
        try {
          const r = await spec.invoke();
          return { kind: "OK", value: r.value, rawUsage: r.rawUsage };
        } catch (err) {
          // Guardado CRU para relançar depois da apropriação (controle de fluxo);
          // o que segue para `reportCall` é a versão sanitizada, porque esse
          // desfecho é persistido e telemetrado e o erro pode carregar a chave.
          thrown = err;
          return { kind: "FAILED", error: sanitizeProviderError(err) };
        }
      },
    },
  );

  if (authorized.kind === "DENIED") {
    return { kind: "DENIED", decision: authorized.decision, meta: authorized.meta };
  }

  if (thrown) throw thrown;

  const res = authorized.result;
  if (res.kind === "FAILED") {
    // Inalcançável: só `spec.invoke()` produz FAILED, e esse caminho já guardou
    // `thrown` e saiu acima com o erro ORIGINAL. O ramo existe para estreitar a
    // união — e relança um Error de verdade porque `res.error` aqui é a STRING
    // já sanitizada: relançá-la crua faria o `err instanceof Error` de quem
    // recebe tomar o ramo errado.
    throw new Error(sanitizeProviderError(res.error));
  }

  // Telemetria legada (log `agent_usage`) continua alimentada.
  if (opts.onUsage && authorized.outcome.kind === "USAGE") {
    opts.onUsage(authorized.outcome.usage as AgentUsage);
  }
  return { kind: "OK", value: res.value as T };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const model = opts.model || DEFAULT_MODELS[opts.provider];
  const trimmedHistory = truncateHistory(
    opts.history,
    opts.maxHistoryMessages ?? DEFAULT_HISTORY_CAP,
    opts.maxHistoryTokens ?? DEFAULT_HISTORY_TOKEN_CAP,
  );
  const effectiveOpts: AgentLoopOptions = { ...opts, history: trimmedHistory };

  switch (opts.provider) {
    case "claude":
      return runClaude(effectiveOpts, model);
    case "openai":
    case "grok":
    case "deepseek":
      return runOpenAICompatible(effectiveOpts, model, OPENAI_BASE_URLS[opts.provider]!);
    case "gemini":
      return runGemini(effectiveOpts, model);
    default:
      throw new Error(`Provedor desconhecido: ${opts.provider}`);
  }
}

// ─── Claude (Anthropic SDK) ───────────────────────────────────────────────────

/**
 * Limpa cache_control de todos os blocos em messages — usado antes de marcar
 * um novo breakpoint para garantir que nunca passemos do limite de 4 breakpoints
 * por request (Anthropic) ao longo de várias iterações do loop.
 */
function clearMessagesCache(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b && typeof b === "object" && "cache_control" in b) {
          delete b.cache_control;
        }
      }
    }
  }
}

/**
 * Marca o último bloco da última mensagem com cache_control ephemeral.
 * Se a última mensagem tem `content` como string, converte para array de
 * TextBlockParam para conseguir adicionar o breakpoint.
 */
function markLastBlockForCache(messages: Anthropic.MessageParam[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") {
    last.content = [
      { type: "text", text: last.content, cache_control: { type: "ephemeral" } },
    ] as any;
    return;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as any;
    lastBlock.cache_control = { type: "ephemeral" };
  }
}

async function runClaude(opts: AgentLoopOptions, model: string): Promise<AgentLoopResult> {
  // SDK Anthropic faz retry built-in em 429/5xx/network errors com backoff
  // exponencial. Defaults: 2 retries. Setamos explícito pra deixar claro.
  const anthropic = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: DEFAULT_HTTP_RETRIES,
  });
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Cache breakpoint #2: último item de tools. Faz o array inteiro de tools
  // virar prefixo cacheável (~750 tokens economizados por turno em cache hit).
  const claudeTools: Anthropic.Tool[] = opts.tools.map((t, idx) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool["input_schema"],
    ...(idx === opts.tools.length - 1
      ? { cache_control: { type: "ephemeral" } as any }
      : {}),
  }));

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ];

  // Cache breakpoint #1: system prompt. Reutilizado entre requests (TTL ~5min).
  const systemBlocks: (Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } })[] = [
    {
      type: "text",
      text: opts.systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    // Deadline SUAVE: impede COMEÇAR outra rodada; a em curso terminou inteira.
    // A pergunta é do núcleo, e não uma condição escrita aqui: AUSENTE tem de
    // significar "roda", e a forma curta que um lint de estilo sugere diz o
    // oposto. O porquê inteiro está em `agent-deadline-core.ts`.
    if (!mayStartAnotherRound(opts.shouldContinue)) {
      console.warn(JSON.stringify({
        level: "warn",
        evt: "agent_deadline_reached",
        provider: opts.provider,
        iterations_left: iterations,
      }));
      throw new AgentDeadlineError(opts.provider, iterations);
    }

    // Cache breakpoint #3: último bloco da conversa. Reposiciona a cada turno
    // para que tool_results acumulados também entrem em cache nas iterações
    // seguintes do mesmo loop. Limpamos antes para nunca exceder 4 breakpoints.
    clearMessagesCache(messages);
    markLastBlockForCache(messages);

    const call = await callWithBudget<Anthropic.Message>(opts, {
      provider: "claude",
      model,
      iteration: MAX_ITERATIONS - iterations,
      invoke: async () => {
        const r = await anthropic.messages.create(
          {
            model,
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            system: systemBlocks,
            tools: claudeTools,
            messages,
          },
          { signal: timeoutSignal(timeoutMs) },
        );
        return {
          value: r,
          rawUsage: r.usage
            ? {
                input_tokens: r.usage.input_tokens ?? 0,
                output_tokens: r.usage.output_tokens ?? 0,
                cache_creation_tokens: (r.usage as any).cache_creation_input_tokens ?? 0,
                cache_read_tokens: (r.usage as any).cache_read_input_tokens ?? 0,
                reasoning_tokens: 0,
              }
            : null,
        };
      },
    });

    // Negado: NÃO iniciar nova chamada, NÃO truncar resposta já recebida,
    // encerrar o loop de forma controlada e preservar mensagens e ferramentas
    // já executadas. Quem decide a copy e o handoff é o webhook.
    if (call.kind === "DENIED") return { kind: "DENIED", decision: call.decision, meta: call.meta };
    const response = call.value;

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text");
      return { kind: "TEXT", text: text?.text ?? "" };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await opts.onToolCall(block.name, block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Qualquer stop_reason fora de end_turn/tool_use cai aqui (max_tokens,
    // pause_turn, refusal, etc). Log estruturado pra distinguir do fallback
    // genérico quando o webhook decidir handoff.
    console.warn(JSON.stringify({
      level: "warn",
      evt: "agent_unexpected_stop",
      provider: "claude",
      model,
      stop_reason: response.stop_reason,
      iterations_left: iterations,
    }));
    break;
  }

  return { kind: "TEXT", text: "Desculpe, não consegui processar sua solicitação. Tente novamente." };
}

// ─── OpenAI-compatible (OpenAI, Grok, DeepSeek) ───────────────────────────────

async function runOpenAICompatible(
  opts: AgentLoopOptions,
  model: string,
  baseUrl: string,
): Promise<AgentLoopResult> {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const openaiTools = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ];

  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    // Deadline SUAVE: impede COMEÇAR outra rodada; a em curso terminou inteira.
    // A pergunta é do núcleo, e não uma condição escrita aqui: AUSENTE tem de
    // significar "roda", e a forma curta que um lint de estilo sugere diz o
    // oposto. O porquê inteiro está em `agent-deadline-core.ts`.
    if (!mayStartAnotherRound(opts.shouldContinue)) {
      console.warn(JSON.stringify({
        level: "warn",
        evt: "agent_deadline_reached",
        provider: opts.provider,
        iterations_left: iterations,
      }));
      throw new AgentDeadlineError(opts.provider, iterations);
    }

    const call = await callWithBudget<any>(opts, {
      provider: opts.provider,
      model,
      iteration: MAX_ITERATIONS - iterations,
      invoke: async () => {
        const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            tools: openaiTools,
            tool_choice: "auto",
            max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
          }),
          signal: timeoutSignal(timeoutMs),
        }, {
          retries: DEFAULT_HTTP_RETRIES,
          baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
          onRetry: ({ attempt, status, error, delayMs }) => {
            console.warn(JSON.stringify({
              level: "warn",
              evt: "agent_http_retry",
              provider: opts.provider,
              model,
              attempt,
              status: status ?? null,
              error: error ? sanitizeProviderError(error) : null,
              delay_ms: Math.round(delayMs),
            }));
          },
        });

        if (!resp.ok) {
          const errBody = await resp.text();
          throw new Error(`${opts.provider} API error ${resp.status}: ${errBody}`);
        }

        const d = await resp.json();
        return {
          value: d,
          rawUsage: d.usage
            ? {
                input_tokens: d.usage.prompt_tokens ?? 0,
                output_tokens: d.usage.completion_tokens ?? 0,
                cache_creation_tokens: 0,
                cache_read_tokens: d.usage.prompt_tokens_details?.cached_tokens ?? 0,
                reasoning_tokens: d.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              }
            : null,
        };
      },
    });

    if (call.kind === "DENIED") return { kind: "DENIED", decision: call.decision, meta: call.meta };
    const data = call.value;

    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === "stop" || !msg.tool_calls?.length) {
      // finish_reason="length" (cortado por max_tokens) também chega aqui;
      // a resposta volta truncada. Logamos pra rastreio sem mudar comportamento.
      if (choice.finish_reason && choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_unexpected_stop",
          provider: opts.provider,
          model,
          finish_reason: choice.finish_reason,
          iterations_left: iterations,
        }));
      }
      return { kind: "TEXT", text: msg.content ?? "" };
    }

    for (const toolCall of msg.tool_calls) {
      let input: any = {};
      try { input = JSON.parse(toolCall.function.arguments); } catch { /* malformed */ }
      const result = await opts.onToolCall(toolCall.function.name, input);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

  return { kind: "TEXT", text: "Desculpe, não consegui processar sua solicitação. Tente novamente." };
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

function toGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const result: any = { ...schema };
  if (result.type) result.type = String(result.type).toUpperCase();
  if (result.properties) {
    const props: any = {};
    for (const [k, v] of Object.entries(result.properties)) {
      props[k] = toGeminiSchema(v);
    }
    result.properties = props;
  }
  if (result.items) result.items = toGeminiSchema(result.items);
  delete result.additionalProperties;
  delete result.anyOf;
  delete result.$schema;
  return result;
}

/**
 * UMA chamada Gemini, com retry HTTP dentro do MESMO modelo.
 *
 * Os retries de `fetchWithRetry` NÃO são chamadas financeiras novas: mesma
 * chamada lógica, mesmo modelo, e uma tentativa que falha não produz usage.
 *
 * O FALLBACK DE MODELO SAIU DAQUI de propósito. Ele realiza uma segunda chamada
 * HTTP com outro modelo, e Pro custa múltiplas vezes Flash: cobrar Pro a preço
 * de Flash é subcontabilização direta. A escolha do fallback subiu para
 * `runGemini`, onde cada modelo passa por `callWithBudget` e recebe autorização
 * própria, preço do modelo real e `call_id` próprio (§17.7.6).
 */
async function callGeminiOnce(
  body: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  return fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: timeoutSignal(timeoutMs),
    },
    {
      retries,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      onRetry: ({ attempt, status, error, delayMs }) => {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_http_retry",
          provider: "gemini",
          model,
          attempt,
          status: status ?? null,
          // Sanitizado: a URL do Gemini leva `?key=<chave>` e a mensagem de erro
          // de rede do runtime ecoa a URL inteira.
          error: error ? sanitizeProviderError(error) : null,
          delay_ms: Math.round(delayMs),
        }));
      },
    },
  );
}

/**
 * Erro que justifica tentar o modelo de fallback.
 *
 * Preserva o gatilho de hoje: 5xx persistente (saturação regional) e erro de
 * rede/timeout caem para o Pro; 4xx (chave inválida, request malformado, modelo
 * inexistente) propaga direto, porque o Pro falharia igual e a segunda chamada
 * seria custo sem chance de sucesso.
 */
function shouldTryGeminiFallback(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status >= 500;
  return true;
}

async function runGemini(opts: AgentLoopOptions, model: string): Promise<AgentLoopResult> {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallbackModel = FALLBACK_MODELS.gemini;

  const functionDeclarations = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters),
  }));

  const contents: any[] = [
    ...opts.history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: opts.userMessage }] },
  ];

  let activeModel = model;
  let emptyRetried = false;
  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    // Deadline SUAVE: impede COMEÇAR outra rodada; a em curso terminou inteira.
    // A pergunta é do núcleo, e não uma condição escrita aqui: AUSENTE tem de
    // significar "roda", e a forma curta que um lint de estilo sugere diz o
    // oposto. O porquê inteiro está em `agent-deadline-core.ts`.
    if (!mayStartAnotherRound(opts.shouldContinue)) {
      console.warn(JSON.stringify({
        level: "warn",
        evt: "agent_deadline_reached",
        provider: opts.provider,
        iterations_left: iterations,
      }));
      throw new AgentDeadlineError(opts.provider, iterations);
    }

    const body = JSON.stringify({
      system_instruction: { parts: [{ text: opts.systemPrompt }] },
      contents,
      tools: [{ functionDeclarations }],
      tool_config: { function_calling_config: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
    });

    // Uma tentativa por modelo, cada uma com autorização financeira PRÓPRIA.
    // `attemptModels` é [ativo] ou [ativo, fallback] — a segunda entrada só é
    // tentada quando a primeira falha com 5xx ou erro de rede.
    const attemptModels = fallbackModel && fallbackModel !== activeModel
      ? [activeModel, fallbackModel]
      : [activeModel];

    let data: any = null;
    let denied: { decision: BeforeCallDecision; meta: AgentCallMeta } | null = null;
    let lastError: unknown = null;

    for (let a = 0; a < attemptModels.length; a++) {
      const attemptModel = attemptModels[a];
      const isFallbackAttempt = a > 0;

      if (isFallbackAttempt) {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_model_fallback",
          provider: "gemini",
          from_model: attemptModels[0],
          to_model: attemptModel,
          primary_error: sanitizeProviderError(lastError),
        }));
      }

      try {
        const call = await callWithBudget<any>(opts, {
          provider: "gemini",
          model: attemptModel,
          iteration: MAX_ITERATIONS - iterations,
          invoke: async () => {
            const resp = await callGeminiOnce(
              body,
              opts.apiKey,
              attemptModel,
              timeoutMs,
              // Primary: 1 retry — se Flash falha 2x seguidas a sobrecarga
              // regional persiste e mais espera só atrasa o cliente. Fallback:
              // retries default, porque Pro tem cota TPM separada.
              isFallbackAttempt ? DEFAULT_HTTP_RETRIES : 1,
            );
            if (!resp.ok) {
              const errBody = await resp.text();
              // `status` anexado: é o que decide se vale tentar o fallback, sem
              // reintroduzir a decisão de modelo dentro do helper HTTP.
              const e: any = new Error(`Gemini API error ${resp.status}: ${errBody}`);
              e.status = resp.status;
              throw e;
            }
            const d = await resp.json();
            return {
              value: d,
              rawUsage: d.usageMetadata
                ? {
                    input_tokens: d.usageMetadata.promptTokenCount ?? 0,
                    output_tokens: d.usageMetadata.candidatesTokenCount ?? 0,
                    cache_creation_tokens: 0,
                    cache_read_tokens: d.usageMetadata.cachedContentTokenCount ?? 0,
                    reasoning_tokens: d.usageMetadata.thoughtsTokenCount ?? 0,
                  }
                : null,
            };
          },
        });

        // Negação vale para a tentativa ATUAL e encerra o turno — inclusive a
        // do fallback. Quando a 1ª chamada não devolveu usage, a autorização do
        // fallback volta DENY_USAGE_UNRESOLVED e a 2ª chamada não acontece: é
        // exatamente o buraco de "resposta vazia + fallback = duas chamadas,
        // uma contabilizada" (§17.7.6).
        if (call.kind === "DENIED") {
          denied = { decision: call.decision, meta: call.meta };
          break;
        }

        data = call.value;
        // Sticky: se caímos no Pro, seguimos no Pro (a cota do Flash continua
        // saturada — não adianta voltar).
        activeModel = attemptModel;
        break;
      } catch (err) {
        lastError = err;
        // Última tentativa, ou erro que o fallback não resolveria (4xx):
        // propaga como sempre propagou (→ agent_error → handoff).
        if (a === attemptModels.length - 1 || !shouldTryGeminiFallback(err)) throw err;
      }
    }

    if (denied) return { kind: "DENIED", decision: denied.decision, meta: denied.meta };
    if (!data) throw lastError ?? new Error("Gemini: sem resposta utilizável");

    const candidate = data.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];
    const funcCalls = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    if (funcCalls.length === 0) {
      const text = textParts.map((p: any) => p.text).join("");
      if (text.trim()) {
        // finishReason != "STOP" (ex: MAX_TOKENS) → resposta truncada, mas o
        // Gemini ainda devolve texto parcial. Log pra rastreio.
        if (candidate?.finishReason && candidate.finishReason !== "STOP") {
          console.warn(JSON.stringify({
            level: "warn",
            evt: "agent_unexpected_stop",
            provider: "gemini",
            model: activeModel,
            finish_reason: candidate.finishReason,
            iterations_left: iterations,
          }));
        }
        return { kind: "TEXT", text };
      }
      // Resposta VAZIA (Gemini sob carga / safety devolve candidate sem texto e
      // sem tool call, ou nenhum candidate). É a causa nº1 do "Desculpa, não
      // consegui montar uma resposta agora". Uma re-tentativa no fallback (Pro,
      // cota TPM separada) costuma resolver. NÃO empurra turno "model" vazio.
      if (!emptyRetried && fallbackModel) {
        emptyRetried = true;
        activeModel = fallbackModel; // sticky pro resto do loop de tools
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_empty_retry",
          provider: "gemini",
          to_model: fallbackModel,
          finish_reason: candidate?.finishReason ?? null,
        }));
        continue;
      }
      return { kind: "TEXT", text: "" };
    }

    // Turno com tool calls: registra o turno do modelo e executa as tools.
    contents.push({ role: "model", parts });
    const responseParts: any[] = [];
    for (const part of funcCalls) {
      const result = await opts.onToolCall(part.functionCall.name, part.functionCall.args ?? {});
      responseParts.push({
        functionResponse: { name: part.functionCall.name, response: { result } },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return { kind: "TEXT", text: "Desculpe, não consegui processar sua solicitação. Tente novamente." };
}

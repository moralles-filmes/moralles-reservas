import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.3";
import { fetchWithRetry } from "./retry.ts";

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
}

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
 * Preços em USD por milhão de tokens. Usado só para telemetria — não é
 * faturamento real, e segue valores públicos de cada provedor (atualizar
 * quando mudarem). Modelos sem entrada caem em fallback genérico.
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

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
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

async function runClaude(opts: AgentLoopOptions, model: string): Promise<string> {
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
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: opts.systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    // Cache breakpoint #3: último bloco da conversa. Reposiciona a cada turno
    // para que tool_results acumulados também entrem em cache nas iterações
    // seguintes do mesmo loop. Limpamos antes para nunca exceder 4 breakpoints.
    clearMessagesCache(messages);
    markLastBlockForCache(messages);

    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        system: systemBlocks,
        tools: claudeTools,
        messages,
      },
      { signal: timeoutSignal(timeoutMs) },
    );

    if (opts.onUsage && response.usage) {
      opts.onUsage({
        input_tokens: response.usage.input_tokens ?? 0,
        output_tokens: response.usage.output_tokens ?? 0,
        cache_creation_tokens: (response.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_tokens: (response.usage as any).cache_read_input_tokens ?? 0,
      });
    }

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text");
      return text?.text ?? "";
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

  return "Desculpe, não consegui processar sua solicitação. Tente novamente.";
}

// ─── OpenAI-compatible (OpenAI, Grok, DeepSeek) ───────────────────────────────

async function runOpenAICompatible(
  opts: AgentLoopOptions,
  model: string,
  baseUrl: string,
): Promise<string> {
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
          error: error ? String(error) : null,
          delay_ms: Math.round(delayMs),
        }));
      },
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`${opts.provider} API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();

    if (opts.onUsage && data.usage) {
      opts.onUsage({
        input_tokens: data.usage.prompt_tokens ?? 0,
        output_tokens: data.usage.completion_tokens ?? 0,
        cache_creation_tokens: 0,
        cache_read_tokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
      });
    }

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
      return msg.content ?? "";
    }

    for (const toolCall of msg.tool_calls) {
      let input: any = {};
      try { input = JSON.parse(toolCall.function.arguments); } catch { /* malformed */ }
      const result = await opts.onToolCall(toolCall.function.name, input);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

  return "Desculpe, não consegui processar sua solicitação. Tente novamente.";
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

// Faz uma chamada Gemini com retry e fallback de modelo:
// 1) Tenta `primaryModel` com fetchWithRetry (3 tentativas, 5xx/429/network).
// 2) Se ainda assim retornar 5xx (Flash saturado regionalmente), tenta UMA vez
//    o `fallbackModel` (Pro, com cota TPM separada).
// Retorna a Response da chamada que funcionou. Se ambos falham, lança a última.
async function callGeminiWithFallback(
  body: string,
  apiKey: string,
  primaryModel: string,
  fallbackModel: string | null,
  timeoutMs: number,
): Promise<{ resp: Response; modelUsed: string }> {
  const buildUrl = (m: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

  const callOnce = (m: string, retries: number) =>
    fetchWithRetry(buildUrl(m), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: timeoutSignal(timeoutMs),
    }, {
      retries,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      onRetry: ({ attempt, status, error, delayMs }) => {
        console.warn(JSON.stringify({
          level: "warn",
          evt: "agent_http_retry",
          provider: "gemini",
          model: m,
          attempt,
          status: status ?? null,
          error: error ? String(error) : null,
          delay_ms: Math.round(delayMs),
        }));
      },
    });

  // Primary: 1 retry (2 tentativas total) — se Flash falha 2x seguidas, a
  // sobrecarga regional persiste; mais espera só atrasa a resposta ao cliente.
  // Cai pro fallback logo. Pro tem cota TPM separada e geralmente está livre.
  let primary: Response;
  try {
    primary = await callOnce(primaryModel, 1);
  } catch (err) {
    // Timeout / erro de rede esgotou os retries no primary. Antes de propagar
    // (→ agent_error → handoff), tenta o fallback (Pro): cota TPM separada,
    // geralmente livre quando o Flash está saturado regionalmente.
    if (!fallbackModel) throw err;
    console.warn(JSON.stringify({
      level: "warn",
      evt: "agent_model_fallback",
      provider: "gemini",
      from_model: primaryModel,
      to_model: fallbackModel,
      primary_error: String(err),
    }));
    const fb = await callOnce(fallbackModel, DEFAULT_HTTP_RETRIES);
    return { resp: fb, modelUsed: fallbackModel };
  }
  if (primary.ok || primary.status < 500 || !fallbackModel) {
    return { resp: primary, modelUsed: primaryModel };
  }

  // Primary esgotou retries em 5xx — log e tenta fallback.
  const primaryErr = await primary.text().catch(() => "<unreadable>");
  console.warn(JSON.stringify({
    level: "warn",
    evt: "agent_model_fallback",
    provider: "gemini",
    from_model: primaryModel,
    to_model: fallbackModel,
    primary_status: primary.status,
    primary_body_snippet: primaryErr.slice(0, 200),
  }));

  // Fallback: usa retries default (Pro tem cota maior, retry vale mais).
  const fallback = await callOnce(fallbackModel, DEFAULT_HTTP_RETRIES);
  return { resp: fallback, modelUsed: fallbackModel };
}

async function runGemini(opts: AgentLoopOptions, model: string): Promise<string> {
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
    const body = JSON.stringify({
      system_instruction: { parts: [{ text: opts.systemPrompt }] },
      contents,
      tools: [{ functionDeclarations }],
      tool_config: { function_calling_config: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
    });

    const { resp, modelUsed } = await callGeminiWithFallback(
      body,
      opts.apiKey,
      activeModel,
      fallbackModel,
      timeoutMs,
    );
    // Sticky fallback: se caímos no Pro nessa iteração do loop de tools,
    // mantemos Pro nas próximas (cota Flash continua saturada, não adianta voltar).
    activeModel = modelUsed;

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();

    if (opts.onUsage && data.usageMetadata) {
      opts.onUsage({
        input_tokens: data.usageMetadata.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata.candidatesTokenCount ?? 0,
        cache_creation_tokens: 0,
        cache_read_tokens: data.usageMetadata.cachedContentTokenCount ?? 0,
      });
    }

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
        return text;
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
      return "";
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

  return "Desculpe, não consegui processar sua solicitação. Tente novamente.";
}

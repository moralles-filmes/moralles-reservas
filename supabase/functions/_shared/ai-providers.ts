import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.3";

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
  /** Cap context window via truncation. Default: 20 most recent messages. */
  maxHistoryMessages?: number;
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
const DEFAULT_HISTORY_CAP = 10;
const DEFAULT_TIMEOUT_MS = 45_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mantém apenas as últimas `cap` mensagens, garantindo que o primeiro item
 * seja sempre `role: 'user'` (alguns provedores rejeitam histórico que
 * começa com 'assistant').
 */
export function truncateHistory(history: AgentMessage[], cap = DEFAULT_HISTORY_CAP): AgentMessage[] {
  if (history.length <= cap) {
    if (history.length > 0 && history[0].role !== "user") {
      return history.slice(1);
    }
    return history;
  }
  let trimmed = history.slice(-cap);
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
  const anthropic = new Anthropic({ apiKey: opts.apiKey });
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
        max_tokens: 400,
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
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, tools: openaiTools, tool_choice: "auto" }),
      signal: timeoutSignal(timeoutMs),
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

async function runGemini(opts: AgentLoopOptions, model: string): Promise<string> {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`;

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

  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: opts.systemPrompt }] },
        contents,
        tools: [{ functionDeclarations }],
        tool_config: { function_calling_config: { mode: "AUTO" } },
      }),
      signal: timeoutSignal(timeoutMs),
    });

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
    if (!candidate) break;

    const parts: any[] = candidate.content?.parts ?? [];
    const funcCalls = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    contents.push({ role: "model", parts });

    if (funcCalls.length === 0) {
      return textParts.map((p: any) => p.text).join("") || "";
    }

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

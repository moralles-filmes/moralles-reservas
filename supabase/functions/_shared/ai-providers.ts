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

export interface AgentLoopOptions {
  provider: AIProvider;
  apiKey: string;
  model?: string;
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  tools: AgentTool[];
  onToolCall: (name: string, input: any) => Promise<string>;
}

export const DEFAULT_MODELS: Record<AIProvider, string> = {
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  grok: "grok-3",
  deepseek: "deepseek-chat",
};

const OPENAI_BASE_URLS: Partial<Record<AIProvider, string>> = {
  openai: "https://api.openai.com/v1",
  grok: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
};

const MAX_ITERATIONS = 12;

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  const model = opts.model || DEFAULT_MODELS[opts.provider];

  switch (opts.provider) {
    case "claude":
      return runClaude(opts, model);
    case "openai":
    case "grok":
    case "deepseek":
      return runOpenAICompatible(opts, model, OPENAI_BASE_URLS[opts.provider]!);
    case "gemini":
      return runGemini(opts, model);
    default:
      throw new Error(`Provedor desconhecido: ${opts.provider}`);
  }
}

// ─── Claude (Anthropic SDK) ───────────────────────────────────────────────────

async function runClaude(opts: AgentLoopOptions, model: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: opts.apiKey });

  const claudeTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool["input_schema"],
  }));

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ];

  let iterations = MAX_ITERATIONS;
  while (iterations-- > 0) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: opts.systemPrompt,
      tools: claudeTools,
      messages,
    });

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
  baseUrl: string
): Promise<string> {
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
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`${opts.provider} API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === "stop" || !msg.tool_calls?.length) {
      return msg.content ?? "";
    }

    // Execute all tool calls in this step
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
  // Gemini doesn't support 'additionalProperties' or 'anyOf'
  delete result.additionalProperties;
  delete result.anyOf;
  delete result.$schema;
  return result;
}

async function runGemini(opts: AgentLoopOptions, model: string): Promise<string> {
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
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const candidate = data.candidates?.[0];
    if (!candidate) break;

    const parts: any[] = candidate.content?.parts ?? [];
    const funcCalls = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text);

    // Add model response to contents
    contents.push({ role: "model", parts });

    if (funcCalls.length === 0) {
      return textParts.map((p: any) => p.text).join("") || "";
    }

    // Execute function calls and collect responses
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

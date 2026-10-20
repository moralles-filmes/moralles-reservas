import { describe, expect, it } from "vitest";
import {
  AgentTruncatedError,
  isAgentTruncatedError,
  isTruncatedStop,
} from "../../supabase/functions/_shared/agent-output-core";
import { GEMINI_THINKING_BUDGET } from "../../supabase/functions/_shared/ai-request-profile-core";

// O limite de saída por família, o orçamento de raciocínio do Gemini e o gêmeo
// com `AI_ESTIMATE_OUTPUT_TOKENS` moraram aqui até o catálogo de modelos; agora
// estão em `ai-request-profile-core.test.ts`. Fica o intervalo do orçamento do
// 2.5, que é fato do provider, não do perfil.
describe("GEMINI_THINKING_BUDGET", () => {
  it("é um orçamento único válido em Flash (0–24576) e Pro (>=128)", () => {
    expect(GEMINI_THINKING_BUDGET).toBe(1024);
    expect(GEMINI_THINKING_BUDGET).toBeGreaterThanOrEqual(128);
    expect(GEMINI_THINKING_BUDGET).toBeLessThanOrEqual(24576);
  });
});

describe("isTruncatedStop", () => {
  it("reconhece o motivo de corte de cada provider", () => {
    expect(isTruncatedStop("gemini", "MAX_TOKENS")).toBe(true);
    expect(isTruncatedStop("claude", "max_tokens")).toBe(true);
    for (const p of ["openai", "grok", "deepseek"] as const) {
      expect(isTruncatedStop(p, "length")).toBe(true);
    }
  });

  it("não trata os demais motivos como corte", () => {
    expect(isTruncatedStop("gemini", "STOP")).toBe(false);
    expect(isTruncatedStop("gemini", "SAFETY")).toBe(false);
    expect(isTruncatedStop("gemini", "length")).toBe(false);
    expect(isTruncatedStop("claude", "end_turn")).toBe(false);
    expect(isTruncatedStop("claude", "refusal")).toBe(false);
    expect(isTruncatedStop("claude", "pause_turn")).toBe(false);
    expect(isTruncatedStop("openai", "stop")).toBe(false);
    expect(isTruncatedStop("openai", "tool_calls")).toBe(false);
    expect(isTruncatedStop("openai", "MAX_TOKENS")).toBe(false);
  });

  it("famílias novas do catálogo (plano §8.1): mesmos motivos de corte, e os novos motivos não são corte", () => {
    // Claude 5.5: `max_tokens` segue sendo o corte; `refusal` (classificadores)
    // e `model_context_window_exceeded` não são resposta cortada pelo limite.
    expect(isTruncatedStop("claude", "max_tokens")).toBe(true);
    expect(isTruncatedStop("claude", "model_context_window_exceeded")).toBe(false);
    // xAI documenta `end_turn` como fim normal no Chat Completions.
    expect(isTruncatedStop("grok", "end_turn")).toBe(false);
    // OpenAI GPT-6/5.6 e DeepSeek V4: `length`; filtro de conteúdo não é corte.
    expect(isTruncatedStop("openai", "content_filter")).toBe(false);
    expect(isTruncatedStop("deepseek", "length")).toBe(true);
    // Gemini 3.x: mesmo enum de finishReason do 2.5.
    expect(isTruncatedStop("gemini", "MALFORMED_FUNCTION_CALL")).toBe(false);
    expect(isTruncatedStop("gemini", "MISSING_THOUGHT_SIGNATURE")).toBe(false);
  });

  it("undefined/null/não-string nunca é corte", () => {
    expect(isTruncatedStop("gemini", undefined)).toBe(false);
    expect(isTruncatedStop("claude", null)).toBe(false);
    expect(isTruncatedStop("openai", 42)).toBe(false);
  });
});

describe("AgentTruncatedError", () => {
  it("carrega provider, model e reason", () => {
    const err = new AgentTruncatedError("gemini", "gemini-2.5-flash", "MAX_TOKENS");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentTruncatedError");
    expect(err.message).toBe("agent_truncated");
    expect(err.provider).toBe("gemini");
    expect(err.model).toBe("gemini-2.5-flash");
    expect(err.reason).toBe("MAX_TOKENS");
  });

  it("isAgentTruncatedError reconhece a instância e a marca de dado", () => {
    expect(isAgentTruncatedError(new AgentTruncatedError("claude", "m", "max_tokens"))).toBe(true);
    expect(isAgentTruncatedError({ isAgentTruncated: true })).toBe(true);
  });

  it("isAgentTruncatedError rejeita o que não é", () => {
    expect(isAgentTruncatedError(new Error("agent_truncated"))).toBe(false);
    expect(isAgentTruncatedError(null)).toBe(false);
    expect(isAgentTruncatedError(undefined)).toBe(false);
    expect(isAgentTruncatedError("agent_truncated")).toBe(false);
    expect(isAgentTruncatedError({ isAgentTruncated: "true" })).toBe(false);
  });
});

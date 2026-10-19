import { describe, expect, it } from "vitest";
import {
  AgentTruncatedError,
  GEMINI_THINKING_BUDGET,
  MAX_OUTPUT_TOKENS_BY_PROVIDER,
  geminiThinkingConfig,
  isAgentTruncatedError,
  isTruncatedStop,
} from "../../supabase/functions/_shared/agent-output-core";
import { AI_ESTIMATE_OUTPUT_TOKENS } from "../../supabase/functions/_shared/ai-budget-core";

describe("MAX_OUTPUT_TOKENS_BY_PROVIDER", () => {
  it("dá ao Gemini espaço para raciocínio + resposta", () => {
    expect(MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini).toBe(3072);
    expect(MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini).toBeGreaterThan(GEMINI_THINKING_BUDGET + 1500);
  });

  it("mantém 1024 nos demais providers", () => {
    for (const p of ["claude", "openai", "grok", "deepseek"] as const) {
      expect(MAX_OUTPUT_TOKENS_BY_PROVIDER[p]).toBe(1024);
    }
  });

  it("estimativa do orçamento cobre o maior limite de saída (gêmeo de ai-budget-core)", () => {
    expect(AI_ESTIMATE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(
      Math.max(...Object.values(MAX_OUTPUT_TOKENS_BY_PROVIDER)),
    );
  });
});

describe("geminiThinkingConfig", () => {
  it("usa um orçamento único válido em Flash (0–24576) e Pro (>=128)", () => {
    for (const m of ["gemini-2.5-flash", "gemini-2.5-pro"]) {
      const cfg = geminiThinkingConfig(m);
      expect(cfg).toEqual({ thinkingBudget: 1024 });
      expect(cfg.thinkingBudget).toBeGreaterThanOrEqual(128);
      expect(cfg.thinkingBudget).toBeLessThanOrEqual(24576);
    }
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

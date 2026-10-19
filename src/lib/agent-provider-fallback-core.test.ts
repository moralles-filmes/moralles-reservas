import { describe, it, expect } from "vitest";
import {
  parseFallbackConfig,
  shouldUseFallbackProvider,
} from "../../supabase/functions/_shared/agent-provider-fallback-core";
import { AgentTruncatedError } from "../../supabase/functions/_shared/agent-output-core";
import { AgentDeadlineError } from "../../supabase/functions/_shared/agent-deadline-core";

/** Erro com `status` anexado, como os runners fazem em `!resp.ok`. */
function httpError(status: number): Error {
  return Object.assign(new Error(`API error ${status}: corpo`), { status });
}

describe("parseFallbackConfig", () => {
  it("aceita reserva válido", () => {
    expect(
      parseFallbackConfig({ fallback: { provider: "openai", model: "gpt-x" } }, "gemini"),
    ).toEqual({ provider: "openai", model: "gpt-x" });
  });

  it("model vazio vira reserva com modelo padrão", () => {
    expect(
      parseFallbackConfig({ fallback: { provider: "claude", model: "" } }, "gemini"),
    ).toEqual({ provider: "claude", model: "" });
  });

  it("model ausente (UI grava model?: string) equivale a padrão", () => {
    expect(
      parseFallbackConfig({ fallback: { provider: "grok" } }, "gemini"),
    ).toEqual({ provider: "grok", model: "" });
  });

  it("ignora outras chaves do ai_config", () => {
    expect(
      parseFallbackConfig(
        { provider: "gemini", model: "m", fallback: { provider: "deepseek", model: "d" } },
        "gemini",
      ),
    ).toEqual({ provider: "deepseek", model: "d" });
  });

  it("reserva igual ao principal -> null", () => {
    expect(
      parseFallbackConfig({ fallback: { provider: "gemini", model: "x" } }, "gemini"),
    ).toBeNull();
  });

  it("provider desconhecido -> null", () => {
    expect(
      parseFallbackConfig({ fallback: { provider: "mistral", model: "x" } }, "gemini"),
    ).toBeNull();
  });

  it("provider que não é string -> null", () => {
    expect(parseFallbackConfig({ fallback: { provider: 1 } }, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: { provider: null } }, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: {} }, "gemini")).toBeNull();
  });

  it("model numérico/objeto/null -> null", () => {
    expect(parseFallbackConfig({ fallback: { provider: "openai", model: 5 } }, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: { provider: "openai", model: {} } }, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: { provider: "openai", model: null } }, "gemini")).toBeNull();
  });

  it("aiConfig que não é objeto simples -> null, sem lançar", () => {
    expect(parseFallbackConfig(null, "gemini")).toBeNull();
    expect(parseFallbackConfig(undefined, "gemini")).toBeNull();
    expect(parseFallbackConfig([], "gemini")).toBeNull();
    expect(parseFallbackConfig("openai", "gemini")).toBeNull();
    expect(parseFallbackConfig(42, "gemini")).toBeNull();
  });

  it("fallback null, ausente, array ou string -> null", () => {
    expect(parseFallbackConfig({ fallback: null }, "gemini")).toBeNull();
    expect(parseFallbackConfig({}, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: [] }, "gemini")).toBeNull();
    expect(parseFallbackConfig({ fallback: "openai" }, "gemini")).toBeNull();
  });
});

describe("shouldUseFallbackProvider", () => {
  it("AgentTruncatedError -> false", () => {
    expect(shouldUseFallbackProvider(new AgentTruncatedError("gemini", "m", "MAX_TOKENS"))).toBe(false);
  });

  it("AgentDeadlineError -> false", () => {
    expect(shouldUseFallbackProvider(new AgentDeadlineError("gemini", 2))).toBe(false);
  });

  it("api_key_not_configured:* -> false", () => {
    expect(shouldUseFallbackProvider(new Error("api_key_not_configured:openai"))).toBe(false);
  });

  it("status 5xx e 429 -> true (inclui 529 do SDK Anthropic)", () => {
    expect(shouldUseFallbackProvider({ status: 529 })).toBe(true);
    expect(shouldUseFallbackProvider(httpError(503))).toBe(true);
    expect(shouldUseFallbackProvider(httpError(500))).toBe(true);
    expect(shouldUseFallbackProvider(httpError(429))).toBe(true);
  });

  it("status 400/401/404 -> false", () => {
    expect(shouldUseFallbackProvider(httpError(400))).toBe(false);
    expect(shouldUseFallbackProvider(httpError(401))).toBe(false);
    expect(shouldUseFallbackProvider(httpError(404))).toBe(false);
  });

  it("sem status (rede) -> true", () => {
    expect(shouldUseFallbackProvider(new Error("fetch failed"))).toBe(true);
  });

  it("AbortError/TimeoutError -> true", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(shouldUseFallbackProvider(abort)).toBe(true);
    expect(shouldUseFallbackProvider(timeout)).toBe(true);
  });

  it("status que não é número é ignorado (sem status -> true)", () => {
    expect(shouldUseFallbackProvider({ status: "400" })).toBe(true);
  });

  it("entradas não-Error não lançam; sem status -> true (null incluído)", () => {
    expect(shouldUseFallbackProvider(null)).toBe(true);
    expect(shouldUseFallbackProvider(undefined)).toBe(true);
    expect(shouldUseFallbackProvider("boom")).toBe(true);
    expect(shouldUseFallbackProvider({})).toBe(true);
  });
});

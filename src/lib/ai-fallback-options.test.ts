import { describe, expect, it } from "vitest";
import { fallbackProviderOptions } from "./ai-fallback-options";

describe("fallbackProviderOptions", () => {
  it("devolve os provedores com chave na ordem canônica, não na ordem de entrada", () => {
    expect(fallbackProviderOptions(["deepseek", "openai", "gemini"], "claude")).toEqual([
      "openai",
      "gemini",
      "deepseek",
    ]);
  });

  it("exclui o provedor principal", () => {
    expect(fallbackProviderOptions(["claude", "gemini"], "gemini")).toEqual(["claude"]);
  });

  it("exclui provedores sem chave salva", () => {
    expect(fallbackProviderOptions(["openai"], "claude")).toEqual(["openai"]);
    expect(fallbackProviderOptions(["claude"], "claude")).toEqual([]);
  });

  it("ignora strings desconhecidas e duplicadas", () => {
    expect(
      fallbackProviderOptions(["openai", "openai", "mistral", "", "GEMINI"], "claude"),
    ).toEqual(["openai"]);
  });

  it("lista vazia não tem opções", () => {
    expect(fallbackProviderOptions([], "claude")).toEqual([]);
  });
});

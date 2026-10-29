import { describe, expect, it } from "vitest";
import { defaultModelFor, resolveModel } from "../../supabase/functions/_shared/ai-model-catalog";
import { describeSavedModel } from "./aiModels";

describe("describeSavedModel — o que a tela diz sobre o modelo salvo", () => {
  it("vazio (undefined, null, em branco): usa o padrão do provedor", () => {
    const padrao = defaultModelFor("gemini").id;
    const esperado = { kind: "empty", used: padrao, usedLabel: "Gemini 2.5 Flash", verified: true };
    expect(describeSavedModel("gemini", undefined)).toEqual(esperado);
    expect(describeSavedModel("gemini", null)).toEqual(esperado);
    expect(describeSavedModel("gemini", "")).toEqual(esperado);
    expect(describeSavedModel("gemini", "   ")).toEqual(esperado);
  });

  it("vazio com padrão que nunca rodou em produção: verified false (o selo vale também para o padrão)", () => {
    expect(describeSavedModel("claude", undefined)).toEqual({
      kind: "empty",
      used: "claude-haiku-5-5",
      usedLabel: "Claude Haiku 5.5",
      verified: false,
    });
  });

  it("ativo e já rodou em produção: verified true", () => {
    expect(describeSavedModel("gemini", "gemini-2.5-flash")).toEqual({
      kind: "active",
      id: "gemini-2.5-flash",
      verified: true,
    });
  });

  it("ativo que nunca rodou em produção: verified false", () => {
    expect(describeSavedModel("gemini", "gemini-3.8-flash")).toEqual({
      kind: "active",
      id: "gemini-3.8-flash",
      verified: false,
    });
  });

  it("aposentado: informa o sucessor em uso e o rótulo dele", () => {
    expect(describeSavedModel("claude", "claude-haiku-4-5")).toEqual({
      kind: "retired",
      saved: "claude-haiku-4-5",
      used: "claude-haiku-5-5",
      usedLabel: "Claude Haiku 5.5",
    });
  });

  it("desconhecido: informa o padrão em uso e o rótulo dele", () => {
    expect(describeSavedModel("gemini", "gemini-2.0-flash")).toEqual({
      kind: "unknown",
      saved: "gemini-2.0-flash",
      used: "gemini-2.5-flash",
      usedLabel: "Gemini 2.5 Flash",
    });
  });

  it("modelo de OUTRO provedor salvo neste provedor conta como desconhecido", () => {
    expect(describeSavedModel("gemini", "claude-haiku-5-5").kind).toBe("unknown");
  });

  it("espelha o backend: o modelo em uso é sempre o `model` de resolveModel", () => {
    for (const saved of ["", "claude-haiku-4-5", "claude-sonnet-4-6", "inexistente", "claude-sonnet-5-5"]) {
      const d = describeSavedModel("claude", saved);
      const usado = d.kind === "active" ? d.id : d.used;
      expect(usado).toBe(resolveModel("claude", saved).model);
    }
  });
});

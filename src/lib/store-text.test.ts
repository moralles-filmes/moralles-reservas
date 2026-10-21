import { describe, expect, it } from "vitest";
import {
  SETTINGS_NOT_WRITTEN_CODE,
  isValidStoreText,
  settingsWriteErrorMessage,
  storeTextError,
  type StoreTextKey,
} from "./store-text";
import { STORE_TEXT_LIMITS } from "../../supabase/functions/_shared/agent/global-prompt-core";

const KEYS = Object.keys(STORE_TEXT_LIMITS) as StoreTextKey[];

describe("storeTextError / isValidStoreText (gêmea do guard de valor do banco)", () => {
  it.each(KEYS)("%s: aceita o limite exato e recusa limite + 1", (key) => {
    const limit = STORE_TEXT_LIMITS[key];
    expect(isValidStoreText(key, "a".repeat(limit))).toBe(true);
    expect(storeTextError(key, "a".repeat(limit))).toBeNull();
    expect(isValidStoreText(key, "a".repeat(limit + 1))).toBe(false);
    expect(storeTextError(key, "a".repeat(limit + 1))).toBe(`Passou de ${limit} caracteres.`);
  });

  it.each(KEYS)("%s: conta emoji como 1 caractere (code point, não UTF-16)", (key) => {
    const limit = STORE_TEXT_LIMITS[key];
    expect(isValidStoreText(key, "😀".repeat(limit))).toBe(true);
    expect(isValidStoreText(key, "😀".repeat(limit + 1))).toBe(false);
  });

  it("aceita vazio e \n/\t", () => {
    expect(isValidStoreText("restaurant_menu", "")).toBe(true);
    expect(isValidStoreText("restaurant_menu", "linha 1\n\tlinha 2")).toBe(true);
  });

  it.each([
    ["\r", "a\rb"],
    ["\r\n", "a\r\nb"],
    ["\x01", "a\x01b"],
    ["\x08", "a\x08b"],
    ["\x0b", "a\x0bb"],
    ["\x1f", "a\x1fb"],
    ["\x7f", "a\x7fb"],
    ["NUL", "a\x00b"],
  ])("recusa caractere de controle %s", (_name, value) => {
    expect(isValidStoreText("delivery_response", value)).toBe(false);
    expect(storeTextError("delivery_response", value)).toBe("Use só texto, sem caracteres de controle.");
  });

  it.each([null, undefined, 42, true, { a: 1 }, ["x"]])("recusa valor que não é string (%j)", (value) => {
    expect(isValidStoreText("restaurant_extra_info", value)).toBe(false);
    expect(storeTextError("restaurant_extra_info", value)).toBe("Texto inválido.");
  });
});

describe("settingsWriteErrorMessage (decide por error.code, nunca por error.message)", () => {
  it("42501 vira falta de permissão", () => {
    expect(settingsWriteErrorMessage({ code: "42501", message: "x" })).toBe("Sem permissão para editar estes textos.");
  });

  it("22023 vira texto acima do limite ou inválido", () => {
    expect(settingsWriteErrorMessage({ code: "22023", message: "setting_value_invalid" })).toBe(
      "Texto acima do limite ou com caracteres inválidos.",
    );
  });

  it("zero linhas gravadas (código próprio da tela) vira a cópia própria", () => {
    expect(settingsWriteErrorMessage({ code: SETTINGS_NOT_WRITTEN_CODE })).toBe("Nenhuma alteração foi gravada.");
  });

  it("outro código, erro sem código e valor estranho viram a cópia genérica", () => {
    const generic = "Não foi possível salvar. Tente novamente.";
    expect(settingsWriteErrorMessage({ code: "PGRST301", message: "x" })).toBe(generic);
    expect(settingsWriteErrorMessage(new Error("boom"))).toBe(generic);
    expect(settingsWriteErrorMessage(null)).toBe(generic);
    expect(settingsWriteErrorMessage("texto")).toBe(generic);
  });

  it("a mensagem crua (com dado sensível) nunca aparece na cópia", () => {
    const secret = 'Failing row contains (unit-a, restaurant_menu, "cardápio privado do cliente")';
    for (const code of ["42501", "22023", "XX000", undefined]) {
      expect(settingsWriteErrorMessage({ code, message: secret })).not.toContain("cardápio privado");
    }
  });

  it("o texto da mensagem não decide: 22023 com mensagem de permissão continua sendo o de limite", () => {
    expect(settingsWriteErrorMessage({ code: "22023", message: "permission denied" })).toBe(
      "Texto acima do limite ou com caracteres inválidos.",
    );
    expect(settingsWriteErrorMessage({ code: "XX000", message: "42501 permission denied" })).toBe(
      "Não foi possível salvar. Tente novamente.",
    );
  });
});

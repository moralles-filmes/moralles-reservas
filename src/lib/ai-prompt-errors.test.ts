import { describe, expect, it } from "vitest";
import { GLOBAL_PROMPT_MAX_CHARS, GLOBAL_PROMPT_PLACEHOLDERS } from "../../supabase/functions/_shared/agent/global-prompt-core";
import { promptErrorMessage } from "./ai-prompt-errors";

const pg = (code: string, message: string) => ({ code, message, details: null, hint: null });

const GENERIC = "Não foi possível concluir. Tente novamente.";
const BODY_COPY =
  "Texto inválido: até 4000 caracteres, só {{agent_name}} e {{restaurant_name}}, sem <<< ou >>> e sem caracteres de controle.";

describe("promptErrorMessage", () => {
  it("42501 vira sem permissão", () => {
    expect(promptErrorMessage(pg("42501", "prompt_forbidden"))).toBe("Sem permissão.");
  });

  it("40001 vira conflito de versão", () => {
    expect(promptErrorMessage(pg("40001", "prompt_version_conflict"))).toBe(
      "Outra pessoa publicou uma versão. Recarregue antes de publicar.",
    );
  });

  it("22023 decide a cópia pelo token exato da mensagem", () => {
    expect(promptErrorMessage(pg("22023", "prompt_note_invalid"))).toBe(
      "Motivo inválido: escreva de 1 a 280 caracteres.",
    );
    expect(promptErrorMessage(pg("22023", "prompt_version_invalid"))).toBe("Versão inválida ou já ativa.");
    expect(promptErrorMessage(pg("22023", "prompt_body_invalid"))).toBe(BODY_COPY);
  });

  it("22023 com outro token (slot ou desconhecido) cai na cópia do texto", () => {
    expect(promptErrorMessage(pg("22023", "prompt_slot_invalid"))).toBe(BODY_COPY);
    expect(promptErrorMessage(pg("22023", "qualquer coisa"))).toBe(BODY_COPY);
  });

  it("a cópia do texto usa as constantes do núcleo", () => {
    const copy = promptErrorMessage(pg("22023", "prompt_body_invalid"));
    expect(copy).toContain(String(GLOBAL_PROMPT_MAX_CHARS));
    for (const p of GLOBAL_PROMPT_PLACEHOLDERS) expect(copy).toContain(`{{${p}}}`);
  });

  it("qualquer outro erro vira a mensagem genérica", () => {
    expect(promptErrorMessage(new Error("boom"))).toBe(GENERIC);
    expect(promptErrorMessage({ message: "x", status: 500 })).toBe(GENERIC);
    expect(promptErrorMessage(pg("XX000", "internal"))).toBe(GENERIC);
    expect(promptErrorMessage(null)).toBe(GENERIC);
    expect(promptErrorMessage(undefined)).toBe(GENERIC);
    expect(promptErrorMessage("texto")).toBe(GENERIC);
  });

  it("decide por code, não por status: 40001 que chega como HTTP 500 é conflito", () => {
    expect(promptErrorMessage({ ...pg("40001", "prompt_version_conflict"), status: 500 })).toMatch(/Outra pessoa/);
  });

  it("um token de 22023 em erro de outro code não muda a cópia", () => {
    expect(promptErrorMessage(pg("XX000", "prompt_note_invalid"))).toBe(GENERIC);
  });

  it("nunca devolve error.message cru", () => {
    const secret = "SEGREDO sk-ant-123 postgres://u:p@host";
    for (const code of ["42501", "40001", "22023", "XX000"]) {
      expect(promptErrorMessage(pg(code, secret))).not.toContain("SEGREDO");
    }
    expect(promptErrorMessage(new Error(secret))).not.toContain("SEGREDO");
    expect(promptErrorMessage({ message: secret })).not.toContain("SEGREDO");
  });
});

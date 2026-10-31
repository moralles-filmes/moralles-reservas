import { describe, expect, it } from "vitest";
import { outcomeLabel } from "./outcome-labels";

describe("outcomeLabel", () => {
  it("traduz desfechos conhecidos", () => {
    expect(outcomeLabel("success")).toBe("Respondida");
    expect(outcomeLabel("discarded_no_grant")).toBe("Descartado: módulo não liberado");
  });
  it("devolve a chave crua quando desconhecida", () => {
    expect(outcomeLabel("algo_novo")).toBe("algo_novo");
  });
  it("não confunde chaves herdadas de Object", () => {
    expect(outcomeLabel("constructor")).toBe("constructor");
  });
});

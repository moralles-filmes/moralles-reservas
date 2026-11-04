import { describe, expect, it } from "vitest";
import type { TableBox } from "./hall-plan-core";
import { combinationKey, defaultCombinationRange, suggestRowCombinations, validateCombinations } from "./table-combination-core";

function box(tableId: string, x: number, y = 100, overrides: Partial<TableBox> = {}): TableBox {
  return { tableId, number: Number(tableId.replace(/\D/g, "")) || 1, capacity: 4, bookable: true, x, y, w: 80, h: 80, rotation: 0, shape: "square", positioned: true, ...overrides };
}

describe("combinationKey e defaultCombinationRange", () => {
  it("gera chave estável independente da ordem e deduplica ids", () => {
    expect(combinationKey(["b", "a", "b"])).toBe("a,b");
    expect(combinationKey(["a", "b"])).toBe("a,b");
  });

  it("usa maior capacidade mais um como mínimo, limitado pela soma", () => {
    const boxes = [box("1", 0, 0, { capacity: 2 }), box("2", 0, 0, { capacity: 4 })];
    expect(defaultCombinationRange(boxes, ["1", "2"])).toEqual({ min: 5, max: 6 });
    expect(defaultCombinationRange(boxes, ["1"])).toEqual({ min: 2, max: 2 });
    expect(defaultCombinationRange(boxes, [])).toEqual({ min: 1, max: 1 });
  });
});

describe("suggestRowCombinations", () => {
  it("usa distância entre bordas com gap padrão e personalizado", () => {
    const pair = [box("1", 0), box("2", 130)];
    expect(suggestRowCombinations(pair, ["1", "2"])).toHaveLength(1);
    expect(suggestRowCombinations([box("1", 0), box("2", 141)], ["1", "2"])).toHaveLength(0);
    expect(suggestRowCombinations([box("1", 0), box("2", 141)], ["1", "2"], 61)).toHaveLength(1);
  });

  it("considera rotação de 90 graus na caixa envolvente", () => {
    const rotated = box("1", 0, 0, { w: 140, h: 40, rotation: 90 });
    expect(suggestRowCombinations([rotated, box("2", 0, 110, { w: 80, h: 80 })], ["1", "2"], 0)).toHaveLength(1);
    expect(suggestRowCombinations([rotated, box("2", 0, 111, { w: 80, h: 80 })], ["1", "2"], 0)).toHaveLength(0);
  });

  it("gera todas as janelas contíguas de uma fileira de quatro sem saltos", () => {
    const boxes = [box("1", 0), box("2", 130), box("3", 260), box("4", 390)];
    const result = suggestRowCombinations(boxes, ["1", "2", "3", "4"]);
    expect(result).toHaveLength(6);
    expect(result.map((item) => item.tableIds)).toEqual([["1", "2"], ["2", "3"], ["3", "4"], ["1", "2", "3"], ["2", "3", "4"], ["1", "2", "3", "4"]]);
    expect(result.some((item) => item.tableIds.join(",") === "1,3")).toBe(false);
  });

  it("não mistura fileiras separadas e mesas não reserváveis ou não posicionadas quebram a sequência", () => {
    const rows = [box("1", 0), box("2", 130), box("3", 0, 500), box("4", 130, 500)];
    expect(suggestRowCombinations(rows, rows.map((item) => item.tableId))).toHaveLength(2);
    const interrupted = [box("1", 0), box("2", 130, 100, { bookable: false }), box("3", 260)];
    expect(suggestRowCombinations(interrupted, ["1", "2", "3"])).toHaveLength(0);
    expect(suggestRowCombinations([interrupted[0], { ...interrupted[1], bookable: true, positioned: false }, interrupted[2]], ["1", "2", "3"])).toHaveLength(0);
  });
});

describe("validateCombinations", () => {
  const boxes = [box("1", 0), box("2", 150), box("3", 300, 0, { bookable: false })];
  const draft = (tableIds: string[], min = 1, max = 4, key = tableIds.join("+")) => ({ key, tableIds, min, max });

  it("valida erros na prioridade especificada e permite vazio", () => {
    expect(validateCombinations([], boxes)).toEqual([]);
    expect(validateCombinations([
      draft(["1"]),
      draft(["1", "2"], 0),
      draft(["1", "2"]),
      draft(["1", "3"]),
      draft(["2", "1"]),
      draft(Array.from({ length: 13 }, (_, i) => `x${i}`)),
    ], boxes)).toEqual([
      { key: "1", error: "too_few" },
      { key: "1+2", error: "range" },
      { key: "1+2", error: "duplicate" },
      { key: "1+3", error: "not_bookable" },
      { key: "2+1", error: "duplicate" },
      { key: "x0+x1+x2+x3+x4+x5+x6+x7+x8+x9+x10+x11+x12", error: "not_bookable" },
    ]);
  });
});

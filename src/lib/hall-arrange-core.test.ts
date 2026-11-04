import { describe, it, expect } from "vitest";
import { HALL_GAP_CM, HALL_LABEL_CM, arrangeHalls } from "./hall-arrange-core";

describe("arrangeHalls", () => {
  it("lista vazia tem tamanho zero", () => {
    const r = arrangeHalls([]);
    expect(r.placements.size).toBe(0);
    expect([r.widthCm, r.depthCm]).toEqual([0, 0]);
  });

  it("um salão: x 0 e planta logo abaixo da etiqueta", () => {
    const r = arrangeHalls([{ id: "a", widthCm: 1000, depthCm: 800 }]);
    expect(r.placements.get("a")).toEqual({ xCm: 0, yCm: HALL_LABEL_CM });
    expect(r.widthCm).toBe(1000);
    expect(r.depthCm).toBe(HALL_LABEL_CM + 800);
  });

  it("dois salões ficam lado a lado, com vão", () => {
    const r = arrangeHalls([
      { id: "a", widthCm: 1000, depthCm: 800 },
      { id: "b", widthCm: 600, depthCm: 900 },
    ]);
    expect(r.placements.get("a")).toEqual({ xCm: 0, yCm: HALL_LABEL_CM });
    expect(r.placements.get("b")).toEqual({ xCm: 1000 + HALL_GAP_CM, yCm: HALL_LABEL_CM });
    expect(r.widthCm).toBe(1000 + HALL_GAP_CM + 600);
    expect(r.depthCm).toBe(HALL_LABEL_CM + 900);
  });

  it("quebra de linha quando passa da largura máxima", () => {
    const r = arrangeHalls(
      [
        { id: "a", widthCm: 1000, depthCm: 800 },
        { id: "b", widthCm: 1000, depthCm: 500 },
      ],
      1500,
    );
    expect(r.placements.get("b")).toEqual({ xCm: 0, yCm: HALL_LABEL_CM + 800 + HALL_GAP_CM + HALL_LABEL_CM });
    expect(r.widthCm).toBe(1000);
    expect(r.depthCm).toBe(HALL_LABEL_CM + 800 + HALL_GAP_CM + HALL_LABEL_CM + 500);
  });

  it("nenhum par de salões se sobrepõe", () => {
    const items = [
      { id: "a", widthCm: 1200, depthCm: 900 },
      { id: "b", widthCm: 700, depthCm: 1100 },
      { id: "c", widthCm: 900, depthCm: 600 },
      { id: "d", widthCm: 1500, depthCm: 400 },
    ];
    const r = arrangeHalls(items);
    const rect = (i: (typeof items)[number]) => {
      const p = r.placements.get(i.id)!;
      return { x1: p.xCm, y1: p.yCm - HALL_LABEL_CM, x2: p.xCm + i.widthCm, y2: p.yCm + i.depthCm };
    };
    for (const a of items) {
      for (const b of items) {
        if (a.id >= b.id) continue;
        const A = rect(a);
        const B = rect(b);
        const overlap = A.x1 < B.x2 && B.x1 < A.x2 && A.y1 < B.y2 && B.y1 < A.y2;
        expect(overlap, `${a.id} x ${b.id}`).toBe(false);
      }
      const A = rect(a);
      expect(A.x2).toBeLessThanOrEqual(r.widthCm);
      expect(A.y2).toBeLessThanOrEqual(r.depthCm);
    }
  });
});

import { describe, expect, it } from "vitest";
import { entranceAt, resizedSize } from "./hall-plan-core";
import type { HallPlan, TableBox } from "./hall-plan-core";

const plan: HallPlan = { widthCm: 1200, depthCm: 900, entrance: null, windowWalls: [] };

const box = (over: Partial<TableBox> = {}): TableBox =>
  ({ tableId: "t", number: 1, capacity: 4, x: 300, y: 300, w: 80, h: 80, rotation: 0, shape: "square", positioned: true, ...over }) as TableBox;

describe("resizedSize", () => {
  it("mesa retangular cresce o dobro do arrasto em cada eixo (centro parado)", () => {
    expect(resizedSize(box({ shape: "rect", w: 120, h: 80 }), 10, 5, 1)).toEqual({ w: 140, h: 90 });
  });

  it("converte pixels em cm pela escala", () => {
    expect(resizedSize(box({ shape: "rect", w: 120, h: 80 }), 10, 0, 0.5)).toEqual({ w: 160, h: 80 });
  });

  it("mesa quadrada ou redonda mantém w = h", () => {
    const r = resizedSize(box({ shape: "round", w: 80, h: 80 }), 20, 0, 1);
    expect(r.w).toBe(r.h);
    expect(r.w).toBe(100);
  });

  it("respeita a rotação: em 90° o arrasto para baixo aumenta a largura", () => {
    expect(resizedSize(box({ shape: "rect", w: 120, h: 80, rotation: 90 }), 0, 10, 1)).toEqual({ w: 140, h: 80 });
  });

  it("prende na faixa 30–600 e arredonda de 5 em 5", () => {
    expect(resizedSize(box({ shape: "rect", w: 120, h: 80 }), -1000, 1000, 1)).toEqual({ w: 30, h: 600 });
    expect(resizedSize(box({ shape: "rect", w: 120, h: 80 }), 1.2, 0, 1)).toEqual({ w: 120, h: 80 });
  });
});

describe("entranceAt", () => {
  it("escolhe a parede mais próxima e centra a entrada no ponto", () => {
    expect(entranceAt(500, 20, plan)).toEqual({ wall: "top", offsetCm: 455 });
    expect(entranceAt(1190, 400, plan)).toEqual({ wall: "right", offsetCm: 355 });
    expect(entranceAt(600, 880, plan)).toEqual({ wall: "bottom", offsetCm: 555 });
    expect(entranceAt(10, 300, plan)).toEqual({ wall: "left", offsetCm: 255 });
  });

  it("mantém a entrada inteira dentro da parede", () => {
    expect(entranceAt(5, 5, plan).offsetCm).toBe(0);
    expect(entranceAt(1190, 3, plan)).toEqual({ wall: "top", offsetCm: 1110 });
  });
});

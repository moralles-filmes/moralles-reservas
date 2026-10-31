import { describe, it, expect } from "vitest";
import type { Hall, Mesa } from "@/types/reserva";
import {
  DEFAULT_HALL_PLAN,
  GRID_CM,
  clampBox,
  defaultSizeFor,
  hallPlanFrom,
  resolveTableBoxes,
  snap,
  toSavePayload,
  type HallPlan,
  type TableBox,
} from "./hall-plan-core";

function hall(overrides: Partial<Hall> = {}): Hall {
  return {
    id: "h1",
    unit_id: "u1",
    name: "Salão",
    description: null,
    active: true,
    allow_empty_seat: false,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mesa(overrides: Partial<Mesa> & { number: number }): Mesa {
  return {
    id: `m${overrides.number}`,
    unit_id: "u1",
    hall_id: "h1",
    capacity: 4,
    min_capacity: 1,
    max_capacity: 4,
    location: "internal",
    active: true,
    plan_x: null,
    plan_y: null,
    plan_w: null,
    plan_h: null,
    plan_rotation: null,
    plan_shape: null,
    ...overrides,
  };
}

function box(overrides: Partial<TableBox> = {}): TableBox {
  return {
    tableId: "t",
    number: 1,
    capacity: 4,
    x: 0,
    y: 0,
    w: 80,
    h: 80,
    rotation: 0,
    shape: "square",
    positioned: true,
    ...overrides,
  };
}

/** Separação entre duas caixas axis-aligned: >= 2*GRID_CM significa folga de 2 grades. */
function separation(a: TableBox, b: TableBox): number {
  const dx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
  const dy = Math.abs(a.y - b.y) - (a.h + b.h) / 2;
  return Math.max(dx, dy);
}

function insidePlan(b: TableBox, plan: HallPlan): boolean {
  const eps = 1e-9;
  return (
    b.x - b.w / 2 >= -eps &&
    b.y - b.h / 2 >= -eps &&
    b.x + b.w / 2 <= plan.widthCm + eps &&
    b.y + b.h / 2 <= plan.depthCm + eps
  );
}

describe("hallPlanFrom", () => {
  it("usa o padrão quando plan_width_cm é nulo", () => {
    const plan = hallPlanFrom(hall({ plan_width_cm: null, plan_depth_cm: null }));
    expect(plan).toEqual(DEFAULT_HALL_PLAN);
    expect(DEFAULT_HALL_PLAN).toEqual({ widthCm: 1200, depthCm: 900, entrance: null, windowWalls: [] });
  });

  it("copia as colunas quando preenchidas", () => {
    const plan = hallPlanFrom(
      hall({
        plan_width_cm: 1000,
        plan_depth_cm: 700,
        plan_entrance_wall: "bottom",
        plan_entrance_offset_cm: 150,
        plan_window_walls: ["left", "top"],
      }),
    );
    expect(plan).toEqual({
      widthCm: 1000,
      depthCm: 700,
      entrance: { wall: "bottom", offsetCm: 150 },
      windowWalls: ["left", "top"],
    });
  });

  it("entrance é null quando plan_entrance_wall é nulo", () => {
    const plan = hallPlanFrom(hall({ plan_entrance_wall: null, plan_entrance_offset_cm: 100 }));
    expect(plan.entrance).toBeNull();
  });

  it("windowWalls é [] quando plan_window_walls está ausente", () => {
    const plan = hallPlanFrom(hall({ plan_window_walls: undefined }));
    expect(plan.windowWalls).toEqual([]);
  });
});

describe("defaultSizeFor", () => {
  it("capacidade 2 é redonda 70x70", () => {
    expect(defaultSizeFor(2)).toEqual({ w: 70, h: 70, shape: "round" });
  });

  it("capacidade 4 é quadrada 80x80", () => {
    expect(defaultSizeFor(4)).toEqual({ w: 80, h: 80, shape: "square" });
  });

  it("capacidade 6 é retangular 140x80", () => {
    expect(defaultSizeFor(6)).toEqual({ w: 140, h: 80, shape: "rect" });
  });

  it("capacidade 10 é retangular 260x80", () => {
    expect(defaultSizeFor(10)).toEqual({ w: 260, h: 80, shape: "rect" });
  });

  it("limita a largura em 600 para capacidade grande", () => {
    expect(defaultSizeFor(100)).toEqual({ w: 600, h: 80, shape: "rect" });
  });
});

describe("grade automática", () => {
  function twelveTables(): Mesa[] {
    // Embaralhadas de propósito: a ordenação precisa vir de number, não da entrada.
    const order = [7, 3, 11, 1, 9, 5, 12, 2, 8, 4, 10, 6];
    return order.map((n) => mesa({ number: n, max_capacity: 4 }));
  }

  it("12 mesas sem posição ficam com positioned=false", () => {
    const boxes = resolveTableBoxes(DEFAULT_HALL_PLAN, twelveTables());
    expect(boxes).toHaveLength(12);
    expect(boxes.every((b) => b.positioned === false)).toBe(true);
  });

  it("nenhum par de caixas se sobrepõe e todas ficam dentro do salão", () => {
    const boxes = resolveTableBoxes(DEFAULT_HALL_PLAN, twelveTables());
    for (const b of boxes) {
      expect(insidePlan(b, DEFAULT_HALL_PLAN)).toBe(true);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(separation(boxes[i], boxes[j])).toBeGreaterThan(0);
      }
    }
  });

  it("mantém espaço >= 2*GRID_CM entre caixas vizinhas", () => {
    const boxes = resolveTableBoxes(DEFAULT_HALL_PLAN, twelveTables());
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(separation(boxes[i], boxes[j])).toBeGreaterThanOrEqual(2 * GRID_CM);
      }
    }
  });

  it("ordena por number em linhas da esquerda para a direita e de cima para baixo", () => {
    const boxes = resolveTableBoxes(DEFAULT_HALL_PLAN, twelveTables());
    const byNumber = [...boxes].sort((a, b) => a.number - b.number);
    for (let i = 1; i < byNumber.length; i++) {
      const prev = byNumber[i - 1];
      const cur = byNumber[i];
      const readingOrderOk = cur.y > prev.y || (cur.y === prev.y && cur.x > prev.x);
      expect(readingOrderOk).toBe(true);
    }
  });

  it("caso misto: mesas posicionadas mantêm valores e as automáticas não colidem com elas", () => {
    const tables: Mesa[] = [
      mesa({
        number: 1,
        plan_x: 300,
        plan_y: 300,
        plan_w: 120,
        plan_h: 60,
        plan_rotation: 30,
        plan_shape: "rect",
      }),
      mesa({ number: 2, max_capacity: 4 }),
      mesa({ number: 3, max_capacity: 4 }),
      mesa({ number: 4, max_capacity: 6 }),
      mesa({ number: 5, max_capacity: 2 }),
    ];
    const boxes = resolveTableBoxes(DEFAULT_HALL_PLAN, tables);
    const fixed = boxes.find((b) => b.number === 1);
    expect(fixed).toMatchObject({
      tableId: "m1",
      positioned: true,
      x: 300,
      y: 300,
      w: 120,
      h: 60,
      rotation: 30,
      shape: "rect",
    });

    const auto = boxes.filter((b) => b.number !== 1);
    expect(auto).toHaveLength(4);
    for (const b of auto) {
      expect(b.positioned).toBe(false);
      expect(insidePlan(b, DEFAULT_HALL_PLAN)).toBe(true);
      expect(separation(b, fixed)).toBeGreaterThanOrEqual(2 * GRID_CM);
    }
  });
});

describe("snap", () => {
  it("arredonda para a grade de 25 cm", () => {
    expect(snap(137)).toBe(125);
    expect(snap(138)).toBe(150);
  });
});

describe("clampBox", () => {
  const plan = DEFAULT_HALL_PLAN;

  it("traz para dentro uma caixa com x negativo", () => {
    const c = clampBox(box({ x: -40, y: 100, w: 80, h: 80 }), plan);
    expect(c.x).toBe(40);
    expect(c.y).toBe(100);
  });

  it("traz para dentro uma caixa com x maior que a largura do salão", () => {
    const c = clampBox(box({ x: plan.widthCm + 300, y: 100, w: 80, h: 80 }), plan);
    expect(c.x).toBe(plan.widthCm - 40);
  });

  it("usa o retângulo envolvente da rotação de 45 graus", () => {
    const w = 80;
    const h = 80;
    const half = (w * Math.abs(Math.cos(Math.PI / 4)) + h * Math.abs(Math.sin(Math.PI / 4))) / 2;
    const c = clampBox(box({ x: -40, y: 100, w, h, rotation: 45 }), plan);
    expect(c.x).toBeCloseTo(half, 6);
    expect(c.y).toBe(100);
  });

  it("centraliza a caixa quando ela é maior que o salão", () => {
    const small: HallPlan = { widthCm: 100, depthCm: 100, entrance: null, windowWalls: [] };
    const c = clampBox(box({ x: 10, y: 10, w: 300, h: 300 }), small);
    expect(c.x).toBe(50);
    expect(c.y).toBe(50);
  });
});

describe("toSavePayload", () => {
  it("caixa sem posição sai com x,y,w,h,rotation,shape null", () => {
    const payload = toSavePayload(DEFAULT_HALL_PLAN, [
      box({ tableId: "t9", positioned: false, x: 10, y: 20, w: 70, h: 70, rotation: 0, shape: "round" }),
    ]);
    expect(payload.p_tables).toEqual([
      { id: "t9", x: null, y: null, w: null, h: null, rotation: null, shape: null },
    ]);
  });

  it("normaliza a rotação para 0..359", () => {
    const payload = toSavePayload(DEFAULT_HALL_PLAN, [
      box({ tableId: "a", rotation: -15 }),
      box({ tableId: "b", rotation: 370 }),
    ]);
    expect(payload.p_tables[0].rotation).toBe(345);
    expect(payload.p_tables[1].rotation).toBe(10);
  });

  it("arredonda x/y/w/h para inteiro", () => {
    const payload = toSavePayload(DEFAULT_HALL_PLAN, [
      box({ tableId: "a", x: 100.4, y: 200.6, w: 79.5, h: 80.49 }),
    ]);
    expect(payload.p_tables[0]).toMatchObject({ id: "a", x: 100, y: 201, w: 80, h: 80 });
  });

  it("monta p_hall com a geometria do salão", () => {
    const plan: HallPlan = {
      widthCm: 1000,
      depthCm: 700,
      entrance: { wall: "bottom", offsetCm: 150 },
      windowWalls: ["left"],
    };
    const payload = toSavePayload(plan, []);
    expect(payload.p_hall).toEqual({
      width_cm: 1000,
      depth_cm: 700,
      entrance_wall: "bottom",
      entrance_offset_cm: 150,
      window_walls: ["left"],
    });
  });

  it("entrance null gera entrance_wall e entrance_offset_cm null", () => {
    const payload = toSavePayload(DEFAULT_HALL_PLAN, []);
    expect(payload.p_hall.entrance_wall).toBeNull();
    expect(payload.p_hall.entrance_offset_cm).toBeNull();
  });
});

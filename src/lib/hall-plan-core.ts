import type { Hall, Mesa, PlanWall } from "@/types/reserva";
import type { DraftCombination } from "./table-combination-core";

export type { PlanWall } from "@/types/reserva";

export type PlanShape = "round" | "square" | "rect";

export interface HallPlan {
  widthCm: number;
  depthCm: number;
  entrance: { wall: PlanWall; offsetCm: number } | null;
  windowWalls: PlanWall[];
}

export interface TableBox {
  tableId: string;
  number: number;
  capacity: number;
  bookable: boolean;
  /** Centro da mesa, em cm. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  shape: PlanShape;
  positioned: boolean;
}

export const DEFAULT_HALL_PLAN: HallPlan = {
  widthCm: 1200,
  depthCm: 900,
  entrance: null,
  windowWalls: [],
};

/** Grade de encaixe e folga mínima entre caixas vizinhas (cada lado = 1 grade). */
export const GRID_CM = 25;

export function hallPlanFrom(hall: Hall): HallPlan {
  const entranceWall = hall.plan_entrance_wall ?? null;
  return {
    widthCm: hall.plan_width_cm ?? DEFAULT_HALL_PLAN.widthCm,
    depthCm: hall.plan_depth_cm ?? DEFAULT_HALL_PLAN.depthCm,
    entrance:
      entranceWall == null
        ? null
        : { wall: entranceWall, offsetCm: hall.plan_entrance_offset_cm ?? 0 },
    windowWalls: hall.plan_window_walls ?? [],
  };
}

export function defaultSizeFor(maxCapacity: number): { w: number; h: number; shape: PlanShape } {
  if (maxCapacity <= 2) return { w: 70, h: 70, shape: "round" };
  if (maxCapacity <= 4) return { w: 80, h: 80, shape: "square" };
  const w = Math.min(600, 80 + 60 * Math.ceil((maxCapacity - 4) / 2));
  return { w, h: 80, shape: "rect" };
}

function isPositioned(t: Mesa): boolean {
  return (
    t.plan_x != null &&
    t.plan_y != null &&
    t.plan_w != null &&
    t.plan_h != null &&
    t.plan_rotation != null &&
    t.plan_shape != null
  );
}

/** Meia-largura e meia-altura do retângulo envolvente da caixa girada. */
function halfExtents(b: Pick<TableBox, "w" | "h" | "rotation">): { hx: number; hy: number } {
  const rad = (b.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return {
    hx: (b.w * c + b.h * s) / 2,
    hy: (b.w * s + b.h * c) / 2,
  };
}

function collides(a: TableBox, b: TableBox, gap: number): boolean {
  const ea = halfExtents(a);
  const eb = halfExtents(b);
  return (
    Math.abs(a.x - b.x) < ea.hx + eb.hx + gap &&
    Math.abs(a.y - b.y) < ea.hy + eb.hy + gap
  );
}

export function resolveTableBoxes(plan: HallPlan, tables: Mesa[]): TableBox[] {
  const result = new Map<string, TableBox>();
  const placed: TableBox[] = [];

  for (const t of tables) {
    if (!isPositioned(t)) continue;
    const box: TableBox = {
      tableId: t.id,
      number: t.number,
      capacity: t.max_capacity ?? t.capacity,
      bookable: t.bookable ?? true,
      x: t.plan_x,
      y: t.plan_y,
      w: t.plan_w,
      h: t.plan_h,
      rotation: t.plan_rotation,
      shape: t.plan_shape,
      positioned: true,
    };
    result.set(t.id, box);
    placed.push(box);
  }

  const pending = tables
    .filter((t) => !isPositioned(t))
    .sort((a, b) => a.number - b.number);

  for (const t of pending) {
    const capacity = t.max_capacity ?? t.capacity;
    const size = defaultSizeFor(capacity);
    const candidate: TableBox = {
      tableId: t.id,
      number: t.number,
      capacity,
      bookable: t.bookable ?? true,
      x: 0,
      y: 0,
      w: size.w,
      h: size.h,
      rotation: 0,
      shape: size.shape,
      positioned: false,
    };
    const { hx, hy } = halfExtents(candidate);
    const xMin = GRID_CM + hx;
    const yMin = GRID_CM + hy;
    const xMax = plan.widthCm - GRID_CM - hx;
    const yMax = plan.depthCm - GRID_CM - hy;

    let spot: { x: number; y: number } | null = null;
    if (xMax >= xMin && yMax >= yMin) {
      outer: for (let y = yMin; y <= yMax + 1e-9; y += GRID_CM) {
        for (let x = xMin; x <= xMax + 1e-9; x += GRID_CM) {
          candidate.x = x;
          candidate.y = y;
          if (!placed.some((p) => collides(candidate, p, 2 * GRID_CM))) {
            spot = { x, y };
            break outer;
          }
        }
      }
    }

    if (spot) {
      candidate.x = spot.x;
      candidate.y = spot.y;
    } else {
      // Sem espaço: empilha no canto, clampado ao salão. Não lança erro.
      candidate.x = xMin;
      candidate.y = yMin;
      Object.assign(candidate, clampBox(candidate, plan));
    }
    result.set(t.id, candidate);
    placed.push(candidate);
  }

  return tables.map((t) => result.get(t.id));
}

export function snap(valueCm: number, grid: number = GRID_CM): number {
  return Math.round(valueCm / grid) * grid;
}

/** Prende o centro da caixa para que o retângulo envolvente da rotação fique dentro do salão. */
export function clampBox(box: TableBox, plan: HallPlan): TableBox {
  const { hx, hy } = halfExtents(box);
  return {
    ...box,
    x: clampCenter(box.x, hx, plan.widthCm),
    y: clampCenter(box.y, hy, plan.depthCm),
  };
}

function clampCenter(center: number, half: number, dim: number): number {
  if (half * 2 > dim) return dim / 2;
  return Math.min(Math.max(center, half), dim - half);
}

export function toSavePayload(
  plan: HallPlan,
  boxes: TableBox[],
  combinations?: DraftCombination[] | null,
): {
  p_hall: {
    width_cm: number;
    depth_cm: number;
    entrance_wall: PlanWall | null;
    entrance_offset_cm: number | null;
    window_walls: PlanWall[];
  };
  p_tables: Array<{
    id: string;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
    rotation: number | null;
    shape: PlanShape | null;
    bookable: boolean;
  }>;
  p_combinations: Array<{ min: number; max: number; table_ids: string[] }> | null;
} {
  return {
    p_hall: {
      width_cm: plan.widthCm,
      depth_cm: plan.depthCm,
      entrance_wall: plan.entrance ? plan.entrance.wall : null,
      entrance_offset_cm: plan.entrance ? plan.entrance.offsetCm : null,
      window_walls: plan.windowWalls,
    },
    p_tables: boxes.map((b) => {
      if (!b.positioned) {
        return { id: b.tableId, x: null, y: null, w: null, h: null, rotation: null, shape: null, bookable: b.bookable };
      }
      return {
        id: b.tableId,
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.w),
        h: Math.round(b.h),
        rotation: Math.round(((b.rotation % 360) + 360) % 360) % 360,
        shape: b.shape,
        bookable: b.bookable,
      };
    }),
    p_combinations: combinations == null
      ? null
      : combinations.map((c) => ({ min: c.min, max: c.max, table_ids: [...c.tableIds].sort() })),
  };
}

/**
 * Aplica forma ou medidas a uma mesa. Só `rect` pode ter largura ≠ profundidade
 * (CHECK `tables_plan_values`): nas outras formas a medida editada vale para as duas,
 * e ao trocar para redonda ou quadrada vale a largura.
 */
export function applyTablePatch(
  box: TableBox,
  patch: Partial<Pick<TableBox, "shape" | "w" | "h" | "rotation">>,
): TableBox {
  const next = { ...box, ...patch };
  if (next.shape !== "rect") {
    const side = patch.h != null && patch.w == null ? next.h : next.w;
    next.w = side;
    next.h = side;
  }
  return next;
}

/** Largura da entrada desenhada na parede, em cm. */
export const ENTRANCE_CM = 90;
const SIZE_STEP_CM = 5;
const MIN_SIZE_CM = 30;
const MAX_SIZE_CM = 600;

/** Tamanho depois de arrastar a alça do canto: o centro fica parado, então cada lado cresce o dobro. */
export function resizedSize(box: TableBox, dxPx: number, dyPx: number, scale: number): { w: number; h: number } {
  const rad = (box.rotation * Math.PI) / 180;
  // Deslocamento no referencial da mesa girada.
  const lx = (dxPx * Math.cos(rad) + dyPx * Math.sin(rad)) / scale;
  const ly = (-dxPx * Math.sin(rad) + dyPx * Math.cos(rad)) / scale;
  const fit = (v: number) => Math.min(MAX_SIZE_CM, Math.max(MIN_SIZE_CM, snap(v, SIZE_STEP_CM)));
  if (box.shape !== "rect") {
    const side = fit(box.w + lx + ly);
    return { w: side, h: side };
  }
  return { w: fit(box.w + 2 * lx), h: fit(box.h + 2 * ly) };
}

/** Entrada na parede mais próxima do ponto (em cm), centrada nele e inteira dentro da parede. */
export function entranceAt(xCm: number, yCm: number, plan: HallPlan): NonNullable<HallPlan["entrance"]> {
  const dists: Array<[PlanWall, number]> = [
    ["top", yCm],
    ["bottom", plan.depthCm - yCm],
    ["left", xCm],
    ["right", plan.widthCm - xCm],
  ];
  const wall = dists.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  const horizontal = wall === "top" || wall === "bottom";
  const along = horizontal ? xCm : yCm;
  const len = horizontal ? plan.widthCm : plan.depthCm;
  const offsetCm = Math.min(Math.max(0, len - ENTRANCE_CM), Math.max(0, snap(along - ENTRANCE_CM / 2, SIZE_STEP_CM)));
  return { wall, offsetCm };
}

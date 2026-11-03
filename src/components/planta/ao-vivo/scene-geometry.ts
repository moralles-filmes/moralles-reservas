import { ENTRANCE_CM } from "@/lib/hall-plan-core";
import type { HallPlan, PlanWall, TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { SITUATION_LABEL, situationText } from "../situation-labels";

export const WINDOW_STRIPES =
  "repeating-linear-gradient(90deg, hsl(var(--primary)) 0 8px, transparent 8px 14px)";

export function wallRect(wall: PlanWall, thickness: number): React.CSSProperties {
  switch (wall) {
    case "top":
      return { top: 0, left: 0, right: 0, height: thickness };
    case "bottom":
      return { bottom: 0, left: 0, right: 0, height: thickness };
    case "left":
      return { left: 0, top: 0, bottom: 0, width: thickness };
    default:
      return { right: 0, top: 0, bottom: 0, width: thickness };
  }
}

export function entranceRect(plan: HallPlan, scale: number, thickness: number): React.CSSProperties | null {
  const e = plan.entrance;
  if (!e) return null;
  const horizontal = e.wall === "top" || e.wall === "bottom";
  return horizontal
    ? { [e.wall]: 0, left: e.offsetCm * scale, width: ENTRANCE_CM * scale, height: thickness }
    : { [e.wall]: 0, top: e.offsetCm * scale, height: ENTRANCE_CM * scale, width: thickness };
}

export function mesaAriaLabel(box: TableBox, state: TableState, now: Date): string {
  const head = `Mesa ${box.number}, ${box.capacity} lugares`;
  if (state.situation === "occupied" && state.occupant) {
    const min = Math.max(0, Math.floor((now.getTime() - new Date(state.occupant.since).getTime()) / 60_000));
    return `${head}, ${SITUATION_LABEL.occupied} há ${min} min${state.overtime ? ", passou do tempo" : ""}`;
  }
  return `${head}, ${situationText(state)}`;
}

export const SCENE_ROT_Z = 36;
export const SCENE_ROT_X = 56;
export const SCENE_PERSPECTIVE = 1500;

/** Caixa projetada do plano em cm (rotateZ(-36) e depois rotateX(56), aproximação ortogonal). */
export function projectedSpanCm(widthCm: number, depthCm: number): { w: number; h: number } {
  const z = (SCENE_ROT_Z * Math.PI) / 180;
  const x = (SCENE_ROT_X * Math.PI) / 180;
  return {
    w: widthCm * Math.cos(z) + depthCm * Math.sin(z),
    h: (widthCm * Math.sin(z) + depthCm * Math.cos(z)) * Math.cos(x),
  };
}

/**
 * Escala cm→px para o plano girado caber em largura E altura. Descontamos a ampliação da
 * perspectiva no canto mais próximo da câmera e uma pequena margem.
 */
export function fitSceneScale(widthCm: number, depthCm: number, availW: number, availH: number): number {
  const span = projectedSpanCm(widthCm, depthCm);
  const base = Math.min(availW / span.w, availH / span.h) * 0.94;
  const z = (SCENE_ROT_Z * Math.PI) / 180;
  const x = (SCENE_ROT_X * Math.PI) / 180;
  const nearCm = ((widthCm * Math.sin(z) + depthCm * Math.cos(z)) / 2) * Math.sin(x);
  const mag = SCENE_PERSPECTIVE / Math.max(SCENE_PERSPECTIVE - nearCm * base, SCENE_PERSPECTIVE / 2);
  return base / mag;
}

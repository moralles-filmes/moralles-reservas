/** Enquadramento (pan + zoom) de uma planta. Tela = (x, y) + conteúdo * zoom, com transform-origin 0 0. */
export type Viewport = { zoom: number; x: number; y: number };

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, x: 0, y: 0 };

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Multiplica o zoom por `factor` mantendo fixo o ponto de tela (px, py). */
export function zoomAt(v: Viewport, factor: number, px: number, py: number): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const ratio = zoom / v.zoom;
  return { zoom, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

function clampAxis(offset: number, contentSize: number, viewSize: number, margin: number): number {
  const lo = margin - contentSize;
  const hi = viewSize - margin;
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, offset));
}

/** Garante ao menos `margin` px do conteúdo escalado visíveis em cada eixo. Janela sem tamanho não limita. */
export function clampPan(
  v: Viewport,
  contentW: number,
  contentH: number,
  viewW: number,
  viewH: number,
  margin = 48,
): Viewport {
  if (viewW <= 0 || viewH <= 0) return v;
  return {
    ...v,
    x: clampAxis(v.x, contentW * v.zoom, viewW, margin),
    y: clampAxis(v.y, contentH * v.zoom, viewH, margin),
  };
}

/** Põe o ponto de conteúdo (cx, cy) no centro da janela, no zoom atual. */
export function centerOn(v: Viewport, cx: number, cy: number, viewW: number, viewH: number): Viewport {
  return { ...v, x: viewW / 2 - cx * v.zoom, y: viewH / 2 - cy * v.zoom };
}

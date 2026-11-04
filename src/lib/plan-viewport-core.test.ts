import { describe, expect, it } from "vitest";
import {
  IDENTITY_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  centerOn,
  clampPan,
  clampZoom,
  panBy,
  zoomAt,
} from "./plan-viewport-core";

describe("plan-viewport-core", () => {
  it("zoomAt preserva o ponto de conteúdo sob o cursor", () => {
    const v = { zoom: 1.5, x: 30, y: -20 };
    const px = 200;
    const py = 120;
    const cx = (px - v.x) / v.zoom;
    const cy = (py - v.y) / v.zoom;
    const r = zoomAt(v, 1.6, px, py);
    expect(r.zoom).toBeCloseTo(2.4);
    expect(r.x + cx * r.zoom).toBeCloseTo(px);
    expect(r.y + cy * r.zoom).toBeCloseTo(py);
  });

  it("zoomAt respeita os limites", () => {
    expect(zoomAt(IDENTITY_VIEWPORT, 100, 10, 10).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(IDENTITY_VIEWPORT, 0.001, 10, 10).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
  });

  it("panBy soma o deslocamento", () => {
    expect(panBy({ zoom: 2, x: 1, y: 2 }, 3, -4)).toEqual({ zoom: 2, x: 4, y: -2 });
  });

  it("clampPan limita os quatro lados", () => {
    const base = { zoom: 1, x: 0, y: 0 };
    // conteúdo 400x300 em janela 400x300, margem 48
    expect(clampPan({ ...base, x: 1000 }, 400, 300, 400, 300).x).toBe(352);
    expect(clampPan({ ...base, x: -1000 }, 400, 300, 400, 300).x).toBe(48 - 400);
    expect(clampPan({ ...base, y: 1000 }, 400, 300, 400, 300).y).toBe(252);
    expect(clampPan({ ...base, y: -1000 }, 400, 300, 400, 300).y).toBe(48 - 300);
    expect(clampPan({ zoom: 2, x: -1000, y: 0 }, 400, 300, 400, 300).x).toBe(48 - 800);
    expect(clampPan({ ...base, x: 10, y: 10 }, 400, 300, 400, 300)).toEqual({ zoom: 1, x: 10, y: 10 });
  });

  it("clampPan ignora janela sem tamanho", () => {
    const v = { zoom: 1, x: 999, y: 999 };
    expect(clampPan(v, 0, 0, 0, 0)).toBe(v);
  });

  it("centerOn põe o ponto de conteúdo no centro", () => {
    const r = centerOn({ zoom: 2, x: 0, y: 0 }, 100, 50, 400, 300);
    expect(r.x + 100 * 2).toBe(200);
    expect(r.y + 50 * 2).toBe(150);
    expect(r.zoom).toBe(2);
  });
});

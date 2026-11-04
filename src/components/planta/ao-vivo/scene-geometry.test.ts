import { describe, it, expect } from "vitest";
import { fitSceneScale, projectedSpanCm, SCENE_PERSPECTIVE } from "./scene-geometry";

describe("fitSceneScale", () => {
  it("a caixa projetada cabe em largura e altura, inclusive com perspectiva", () => {
    for (const [w, d, availW, availH] of [
      [1200, 900, 900, 520],
      [1200, 900, 400, 640],
      [3000, 600, 700, 400],
      [500, 2000, 1000, 500],
    ]) {
      const s = fitSceneScale(w, d, availW, availH);
      const span = projectedSpanCm(w, d);
      const nearPx = (((w * Math.sin(0.6283) + d * Math.cos(0.6283)) / 2) * Math.sin(0.9774)) * s;
      const mag = SCENE_PERSPECTIVE / (SCENE_PERSPECTIVE - nearPx);
      expect(span.w * s * mag).toBeLessThanOrEqual(availW);
      expect(span.h * s * mag).toBeLessThanOrEqual(availH);
    }
  });

  it("o limite é a altura quando o espaço é largo e baixo, e a largura no caso inverso", () => {
    const wide = fitSceneScale(1200, 900, 5000, 300);
    const tall = fitSceneScale(1200, 900, 300, 5000);
    expect(wide).toBeLessThan(fitSceneScale(1200, 900, 5000, 3000));
    expect(tall).toBeLessThan(fitSceneScale(1200, 900, 3000, 5000));
  });
});

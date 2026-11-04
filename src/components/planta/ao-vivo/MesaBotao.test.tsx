// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";

const box = { tableId: "t1", number: 1, x: 100, y: 100, w: 80, h: 80, rotation: 0, shape: "square", capacity: 4 } as unknown as TableBox;
const state = { situation: "free" } as unknown as TableState;
const renderBtn = (variant: "3d" | "2d") =>
  render(
    <MesaBotao box={box} state={state} scale={1} selected={false} onSelect={vi.fn()} now={new Date()} variant={variant} />,
  );

describe("MesaBotao alvo de toque", () => {
  it("3D compensa o rotateX(56°) com alvo mais alto no plano", () => {
    renderBtn("3d");
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("coarse:after:h-20");
    expect(cls).toContain("coarse:after:w-11");
    expect(cls).not.toContain("coarse:after:h-11");
  });

  it("2D mantém 44 px", () => {
    renderBtn("2d");
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("coarse:after:h-11");
    expect(cls).not.toContain("coarse:after:h-20");
  });
});

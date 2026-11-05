// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TableBox } from "@/lib/hall-plan-core";
import type { TableState } from "@/lib/table-situation-core";
import { MesaBotao } from "./MesaBotao";

const box = { tableId: "t1", number: 1, x: 100, y: 100, w: 80, h: 80, rotation: 0, shape: "square", capacity: 4 } as unknown as TableBox;
const state = { situation: "free" } as unknown as TableState;
const now = new Date("2026-05-01T18:00:00.000Z");

const occupiedState = (overtime = false, since = "2026-05-01T17:52:00.000Z") =>
  ({ situation: "occupied", occupant: { since }, overtime }) as unknown as TableState;

const renderBtn = (
  variant: "3d" | "2d",
  st: TableState = state,
  extra: { timeLabel?: string } = {},
) =>
  render(
    <MesaBotao box={box} state={st} scale={1} selected={false} onSelect={vi.fn()} now={now} variant={variant} {...extra} />,
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

describe("MesaBotao contador de tempo", () => {
  it("ocupada mostra o contador no 2D e não mostra o HH:MM de reserva", () => {
    renderBtn("2d", occupiedState(), { timeLabel: "18:00" });
    expect(screen.getByText("8 min")).toBeTruthy();
    expect(screen.queryByText("18:00")).toBeNull();
  });

  it("ocupada mostra o contador no 3D e não mostra o HH:MM de reserva", () => {
    renderBtn("3d", occupiedState(), { timeLabel: "18:00" });
    expect(screen.getByText("8 min")).toBeTruthy();
    expect(screen.queryByText("18:00")).toBeNull();
  });

  it("overtime aplica o tom late e marca 'passou do tempo' no aria-label", () => {
    renderBtn("2d", occupiedState(true));
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label")).toContain("passou do tempo");
    const contador = screen.getByText("8 min");
    expect(contador.className).toContain("status-late");
  });

  it("livre não mostra contador e mantém o HH:MM de reserva", () => {
    renderBtn("2d", state, { timeLabel: "18:30" });
    expect(screen.queryByText(/min|h|agora/)).toBeNull();
    expect(screen.getByText("18:30")).toBeTruthy();
  });

  it("reservada não mostra contador", () => {
    renderBtn("3d", { situation: "reserved" } as unknown as TableState);
    expect(screen.queryByText(/\d+ min/)).toBeNull();
  });
});

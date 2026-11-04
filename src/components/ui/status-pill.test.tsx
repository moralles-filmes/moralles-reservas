// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusPill, type StatusTone } from "./status-pill";

const TONES: StatusTone[] = [
  "free", "reserved", "arriving", "seated", "late", "pending", "destructive", "muted", "success",
];

describe("StatusPill", () => {
  it("late aplica as classes de token", () => {
    render(<StatusPill tone="late">Atrasada 12 min</StatusPill>);
    const el = screen.getByText("Atrasada 12 min");
    expect(el.className).toContain("bg-status-late/15");
    expect(el.className).toContain("text-status-late");
    expect(el.className).toContain("rounded-full");
  });

  it("nenhum tom usa cor fixa", () => {
    for (const tone of TONES) {
      const { unmount } = render(<StatusPill tone={tone}>x</StatusPill>);
      const cls = screen.getByText("x").className;
      expect(cls).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|bg-white|bg-black|zinc-|backdrop|glass/i);
      unmount();
    }
  });

  it("aceita className extra", () => {
    render(<StatusPill tone="muted" className="ml-2">y</StatusPill>);
    expect(screen.getByText("y").className).toContain("ml-2");
  });
});

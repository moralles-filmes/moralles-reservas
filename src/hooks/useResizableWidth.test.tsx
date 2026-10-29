import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { clampWidth, useResizableWidth } from "./useResizableWidth";

// jsdom não tem PointerEvent: sem isto o evento chega sem clientX/button.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}

const KEY = "test-list-width";

function Harness() {
  const { width, handleProps } = useResizableWidth({ storageKey: KEY, defaultWidth: 320, min: 240, max: 560 });
  return <div {...handleProps} aria-label="alça" data-width={width} />;
}

const handle = () => screen.getByRole("separator", { name: "alça" });
const width = () => Number(handle().getAttribute("data-width"));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("clampWidth", () => {
  it("prende nos limites e arredonda", () => {
    expect(clampWidth(100, 240, 560)).toBe(240);
    expect(clampWidth(900, 240, 560)).toBe(560);
    expect(clampWidth(300.6, 240, 560)).toBe(301);
    expect(clampWidth(Number.NaN, 240, 560)).toBe(240);
  });
});

describe("useResizableWidth", () => {
  it("começa no padrão e expõe os valores para leitor de tela", () => {
    render(<Harness />);
    expect(width()).toBe(320);
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("lê a largura salva, presa nos limites", () => {
    localStorage.setItem(KEY, "9999");
    render(<Harness />);
    expect(width()).toBe(560);
  });

  it("ignora valor salvo inválido", () => {
    localStorage.setItem(KEY, "abc");
    render(<Harness />);
    expect(width()).toBe(320);
  });

  it("teclado: setas andam 16px, Home/End vão aos limites, e grava", () => {
    render(<Harness />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(width()).toBe(336);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(width()).toBe(304);
    fireEvent.keyDown(handle(), { key: "End" });
    expect(width()).toBe(560);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(width()).toBe(240);
    expect(localStorage.getItem(KEY)).toBe("240");
  });

  it("arrastar muda a largura e só grava ao soltar", () => {
    render(<Harness />);
    act(() => {
      fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientX: 180, pointerId: 1 });
    });
    expect(width()).toBe(400);
    expect(localStorage.getItem(KEY)).toBeNull();
    act(() => {
      fireEvent.pointerUp(handle(), { clientX: 180, pointerId: 1 });
    });
    expect(localStorage.getItem(KEY)).toBe("400");
  });

  it("duplo clique volta ao padrão", () => {
    localStorage.setItem(KEY, "500");
    render(<Harness />);
    fireEvent.doubleClick(handle());
    expect(width()).toBe(320);
  });

  it("funciona sem storage disponível", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    render(<Harness />);
    expect(width()).toBe(320);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(width()).toBe(336);
  });
});

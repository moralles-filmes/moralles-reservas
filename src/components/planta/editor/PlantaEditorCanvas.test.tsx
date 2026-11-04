import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { HallPlan, TableBox } from "@/lib/hall-plan-core";
import { PlantaEditorCanvas } from "./PlantaEditorCanvas";

// O jsdom não tem PointerEvent: sem isto, clientX/pointerId chegam undefined ao componente.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const plan: HallPlan = {
  widthCm: 1200,
  depthCm: 900,
  entrance: null,
  windowWalls: [],
};
const box: TableBox = {
  tableId: "t1",
  number: 1,
  capacity: 4,
  bookable: true,
  x: 300,
  y: 300,
  w: 100,
  h: 100,
  rotation: 0,
  shape: "square",
  positioned: true,
};

function setup() {
  const onSelect = vi.fn();
  const onMove = vi.fn();
  render(
    <PlantaEditorCanvas
      plan={plan}
      boxes={[box]}
      selectedId={null}
      onSelect={onSelect}
      onMove={onMove}
      onResize={vi.fn()}
      onEntranceChange={vi.fn()}
    />,
  );
  return {
    onSelect,
    onMove,
    content: screen.getByTestId("planta-canvas-conteudo"),
  };
}

describe("PlantaEditorCanvas com zoom e pan", () => {
  it("mantém os marcadores do container para os atalhos de teclado", () => {
    setup();
    const canvas = screen.getByTestId("planta-canvas");
    expect(canvas.hasAttribute("data-planta-canvas")).toBe(true);
    expect(canvas.getAttribute("aria-label")).toBe("Planta do salão");
  });

  it("arrastar a mesa com zoom 1,5625 move N / (escala * zoom) cm", () => {
    const { onMove } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Aproximar" }));
    fireEvent.click(screen.getByRole("button", { name: "Aproximar" }));
    const mesa = screen.getByRole("button", { name: /^Mesa 1/ });
    // jsdom: clientWidth 0, escala base 1; 156,25 px / 1,5625 = 100 cm.
    fireEvent.pointerDown(mesa, {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      button: 0,
    });
    fireEvent.pointerMove(mesa, { pointerId: 1, clientX: 156.25, clientY: 0 });
    fireEvent.pointerUp(mesa, { pointerId: 1, clientX: 156.25, clientY: 0 });
    expect(onMove).toHaveBeenCalledWith("t1", 400, 300);
  });

  it("clique parado no fundo desmarca", () => {
    const { onSelect, content } = setup();
    fireEvent.pointerDown(content, {
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    fireEvent.pointerUp(content, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(content);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("arrastar o fundo não desmarca nem move mesa", () => {
    const { onSelect, onMove, content } = setup();
    fireEvent.pointerDown(content, {
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    fireEvent.pointerMove(content, { pointerId: 1, clientX: 40, clientY: 10 });
    fireEvent.pointerUp(content, { pointerId: 1, clientX: 40, clientY: 10 });
    fireEvent.click(content);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });
});

it("Shift+clique marca múltiplas mesas sem selecionar nem arrastar", () => {
  const onSelect = vi.fn(); const onToggleMulti = vi.fn(); const onMove = vi.fn();
  render(<PlantaEditorCanvas plan={plan} boxes={[box]} selectedId={null} onSelect={onSelect} onMove={onMove} onResize={vi.fn()} onEntranceChange={vi.fn()} onToggleMulti={onToggleMulti} />);
  const mesa = screen.getByRole("button", { name: /^Mesa 1/ });
  fireEvent.pointerDown(mesa, { shiftKey: true, pointerId: 1 });
  fireEvent.click(mesa, { shiftKey: true });
  expect(onToggleMulti).toHaveBeenCalledWith("t1");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();
});

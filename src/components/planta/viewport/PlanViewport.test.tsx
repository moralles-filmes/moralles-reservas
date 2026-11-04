import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanViewport } from "./PlanViewport";

function setup(onClick = vi.fn()) {
  render(
    <PlanViewport data-testid="vp">
      <button type="button" onClick={onClick}>
        Mesa 1
      </button>
    </PlanViewport>,
  );
  return { content: screen.getByTestId("vp-conteudo"), onClick };
}

describe("PlanViewport", () => {
  it("mostra os controles com rótulo", () => {
    setup();
    expect(screen.getByRole("button", { name: "Aproximar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Afastar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Centralizar" })).toBeTruthy();
  });

  it("Aproximar muda o transform e Centralizar volta ao inicial", () => {
    const { content } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Aproximar" }));
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Centralizar" }));
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("teclado: + aproxima, - afasta, 0 centraliza", () => {
    const { content } = setup();
    const region = screen.getByRole("region");
    fireEvent.keyDown(region, { key: "+" });
    expect(content.style.transform).toContain("scale(1.25)");
    fireEvent.keyDown(region, { key: "0" });
    expect(content.style.transform).toContain("scale(1)");
    fireEvent.keyDown(region, { key: "-" });
    expect(content.style.transform).toContain("scale(0.8)");
  });

  it("pointerdown em botão filho não inicia pan e o clique funciona", () => {
    const { content, onClick } = setup();
    const btn = screen.getByRole("button", { name: "Mesa 1" });
    fireEvent.pointerDown(btn, { pointerId: 1, clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(content.style.transform).not.toContain("80px");
  });

  it("roda do mouse dá zoom, com e sem Ctrl", () => {
    setup();
    const region = screen.getByRole("region");
    const plain = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    region.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    const ctrl = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true });
    region.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
  });
});

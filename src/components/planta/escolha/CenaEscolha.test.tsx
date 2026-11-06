// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SeatMap } from "@/types/reserva";
import { CenaEscolha } from "./CenaEscolha";
import { seatLabel } from "./seat-label";

const map: SeatMap = {
  hall: { id: "h", name: "Salão", plan: { widthCm: 1000, depthCm: 800, entranceWall: "top", entranceOffsetCm: 100, windowWalls: [] } },
  tables: [3, 4, 5].map(number => ({ id: String(number), number, bookable: number !== 5, available: number !== 5,
    plan: { x: number * 100, y: 200, w: 80, h: 80, rotation: 0, shape: "square" } })),
  options: [
    { choice: { kind: "table", id: "3" }, tableIds: ["3"], available: true, minCapacity: 1, maxCapacity: 4 },
    { choice: { kind: "combination", id: "c" }, tableIds: ["4", "3"], available: true, minCapacity: 2, maxCapacity: 8 },
    { choice: { kind: "table", id: "5" }, tableIds: ["5"], available: false, minCapacity: 1, maxCapacity: 4 },
  ],
};
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(cleanup);
const setup = (value = map) => {
  const onChoose = vi.fn();
  render(<CenaEscolha map={value} partySize={3} selected={null} onChoose={onChoose} />);
  return onChoose;
};
it("ordena o rótulo sem alterar o array", () => {
  const nums = [5, 3, 4];
  expect(seatLabel([12])).toBe("Mesa 12");
  expect(seatLabel(nums)).toBe("Mesas 3+4+5");
  expect(nums).toEqual([5, 3, 4]);
});
it("mantém 3D no celular e alterna as vistas", () => {
  setup();
  expect(screen.getByTestId("planta-3d")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ver de cima" }));
  expect(screen.getByTestId("planta-2d")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ver inclinado" }));
  expect(screen.getByTestId("planta-3d")).toBeTruthy();
});
it("força 2D com movimento reduzido", () => {
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: query === "(prefers-reduced-motion: reduce)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  setup();
  expect(screen.getByTestId("planta-2d")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ver inclinado" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Ver de cima" })).toBeNull();
});
it("desabilita as demais mesas e não expõe situação de terceiros", () => {
  const choose = setup();
  expect(screen.getByRole("button", { name: /^Mesa 5,/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: /^Mesa 3,/ }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("button", { name: /Ocupada|Reservada|Atrasada|Chega/i })).toBeNull();
  expect(screen.getByRole("button", { name: /^Mesa 5,/ }).getAttribute("aria-label")).toBe("Mesa 5, 4 lugares, Bloqueada");
  expect(screen.getByRole("button", { name: /^Mesa 4,/ }).getAttribute("aria-label")).toBe("Mesa 4, Livre");
  fireEvent.click(screen.getByRole("button", { name: /^Mesa 4,/ }));
  expect(choose).toHaveBeenCalledWith({ kind: "combination", id: "c" }, "Mesas 3+4");
});
it("abre opções acessíveis quando a mesa participa de várias escolhas", () => {
  const choose = setup();
  fireEvent.click(screen.getByRole("button", { name: /^Mesa 3,/ }));
  expect(screen.getByRole("group", { name: "Escolha as mesas" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Mesa 3 sozinha · até 4" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mesas 3+4 · até 8" }));
  expect(choose).toHaveBeenCalledWith({ kind: "combination", id: "c" }, "Mesas 3+4");
});
it("não renderiza cena sem planta", () => {
  setup({ ...map, hall: { ...map.hall, plan: null } });
  expect(screen.queryByTestId("planta-3d")).toBeNull();
});

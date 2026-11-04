import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CombinacoesPainel } from "./CombinacoesPainel";
import type { TableBox } from "@/lib/hall-plan-core";
const boxes: TableBox[] = [1, 2].map(n => ({ tableId: `t${n}`, number: n, capacity: 4, bookable: true, positioned: true, x: n * 100, y: 100, w: 80, h: 80, rotation: 0, shape: "square" }));
const draft = { key: "t1,t2", tableIds: ["t1", "t2"], min: 5, max: 8 };
function setup(overrides = {}) {
  const props = { boxes, combinations: [], joinMode: false, onJoinModeChange: vi.fn(), multiSelectedIds: ["t1", "t2"], onClearMulti: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), highlightedKey: null, onHighlight: vi.fn(), ...overrides };
  render(<CombinacoesPainel {...props} />);
  return props;
}
describe("CombinacoesPainel", () => {
  it("abre a faixa padrão e adiciona as mesas marcadas", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Juntar 2 mesas" }));
    expect((screen.getByLabelText("Mínimo de pessoas") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Máximo de pessoas") as HTMLInputElement).value).toBe("8");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    expect(p.onAdd).toHaveBeenCalledWith([draft]);
  });
  it("sugere fileiras e adiciona as sugestões marcadas", () => {
    const p = setup({ multiSelectedIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Sugerir combinações" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Mesas 1 + 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar selecionadas" }));
    expect(p.onAdd).toHaveBeenCalledWith([draft]);
  });
  it("destaca e desfaz combinação", () => {
    const p = setup({ combinations: [draft] });
    fireEvent.click(screen.getByRole("button", { name: /Mesas 1 \+ 2/ }));
    expect(p.onHighlight).toHaveBeenCalledWith(draft.key);
    fireEvent.click(screen.getByRole("button", { name: "Desfazer combinação" }));
    expect(p.onRemove).toHaveBeenCalledWith(draft.key);
  });
  it("recusa duplicatas", () => {
    const p = setup({ combinations: [draft] });
    fireEvent.click(screen.getByRole("button", { name: "Juntar 2 mesas" }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    expect(screen.getByRole("alert").textContent).toBe("Essa combinação já existe");
    expect(p.onAdd).not.toHaveBeenCalled();
  });
  it("oculta o painel em leitura", () => {
    setup({ readOnly: true });
    expect(screen.queryByText("Juntar mesas")).toBeNull();
  });
});

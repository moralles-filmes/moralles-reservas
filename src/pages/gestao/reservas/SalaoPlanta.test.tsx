import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { hallPlanFrom, resolveTableBoxes, toSavePayload } from "@/lib/hall-plan-core";
import type { Hall, Mesa } from "@/types/reserva";

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

const mutate = vi.fn();
const refetch = vi.fn();
const state: { isGerente: boolean; isError: boolean; error: Error | null; tables: ReturnType<typeof mesa>[] } = {
  isGerente: true,
  isError: false,
  error: null,
  tables: [],
};

const hall = {
  id: "h1",
  name: "Salão Principal",
  updated_at: "2026-10-31T12:00:00.123456+00:00",
  plan_width_cm: 1200,
  plan_depth_cm: 900,
  plan_entrance_wall: null,
  plan_entrance_offset_cm: null,
  plan_window_walls: [],
};

function mesa(id: string, number: number, x: number | null) {
  const placed = x != null;
  return {
    id,
    number,
    capacity: 2,
    max_capacity: 4,
    plan_x: placed ? x : null,
    plan_y: placed ? 400 : null,
    plan_w: placed ? 80 : null,
    plan_h: placed ? 80 : null,
    plan_rotation: placed ? 0 : null,
    plan_shape: placed ? "square" : null,
  };
}

vi.mock("@/hooks/useHallPlan", () => ({
  useHallPlanData: () => ({
    data: state.isError ? undefined : { hall, tables: state.tables },
    isLoading: false,
    isError: state.isError,
    error: state.error,
    refetch,
  }),
  useSaveHallPlan: () => ({ mutate, isPending: false }),
  hallPlanErrorMessage: () => "erro",
}));

vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({
    unit_id: "u1",
    unit_slug: "moralles",
    unit_name: "Moralles",
    isGerente: state.isGerente,
  }),
}));

import SalaoPlanta from "./SalaoPlanta";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/g/moralles/reservas/saloes/h1/planta"]}>
      <Routes>
        <Route path="/g/:unitSlug/reservas/saloes/:hallId/planta" element={<SalaoPlanta />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mutate.mockReset();
  refetch.mockReset();
  state.isGerente = true;
  state.isError = false;
  state.error = null;
  state.tables = [mesa("t1", 1, 200), mesa("t3", 3, 600)];
});

describe("SalaoPlanta", () => {
  it("salão de outra unidade: mostra 'não encontrado', sem tentar de novo nem editor", () => {
    state.isError = true;
    state.error = new Error("Salão não encontrado nesta unidade.");
    renderPage();
    expect(screen.getByText("Salão não encontrado nesta unidade.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    expect(screen.getByRole("link", { name: "Voltar para os salões" }).getAttribute("href")).toBe(
      "/g/moralles/reservas/saloes",
    );
  });

  it("erro comum de leitura segue com Tentar de novo", () => {
    state.isError = true;
    state.error = new Error("network");
    renderPage();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("renderiza as mesas como botões com rótulo acessível", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Mesa 3, 4 lugares" })).toBeTruthy();
  });

  it("seta move a mesa 25 cm e habilita Salvar", () => {
    renderPage();
    const salvar = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
    const mesa3 = screen.getByRole("button", { name: "Mesa 3, 4 lugares" });
    fireEvent.click(mesa3);
    fireEvent.keyDown(mesa3, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Mesa 3, 4 lugares" }).getAttribute("data-x")).toBe("625");
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("campo numérico aceita digitar de vazio e aplica ao sair; fora da faixa vai ao limite do banco", () => {
    renderPage();
    const largura = screen.getByLabelText("Largura (cm)") as HTMLInputElement;
    fireEvent.change(largura, { target: { value: "" } });
    fireEvent.change(largura, { target: { value: "8" } });
    expect(largura.value).toBe("8");
    fireEvent.change(largura, { target: { value: "800" } });
    fireEvent.blur(largura);
    expect(largura.value).toBe("800");
    fireEvent.change(largura, { target: { value: "9000" } });
    fireEvent.keyDown(largura, { key: "Enter" });
    expect(largura.value).toBe("5000");
  });

  it("depois de salvar, a tela fica limpa e o próximo salvamento usa a revisão nova", () => {
    mutate.mockImplementation((_vars, opts) => opts?.onSuccess?.("2026-10-31T12:05:00.999999+00:00"));
    renderPage();
    const mesa3 = () => screen.getByRole("button", { name: "Mesa 3, 4 lugares" });
    fireEvent.click(mesa3());
    fireEvent.keyDown(mesa3(), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(mesa3(), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutate.mock.calls[1][0].expectedUpdatedAt).toBe("2026-10-31T12:05:00.999999+00:00");
  });

  it("trocar retangular para quadrada iguala as medidas (CHECK do banco)", () => {
    state.tables = [{ ...mesa("t3", 3, 600), plan_w: 140, plan_shape: "rect" }];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Mesa 3, 4 lugares" }));
    fireEvent.click(screen.getByRole("radio", { name: "Quadrada" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    const [t] = mutate.mock.calls[0][0].payload.p_tables;
    expect(t).toMatchObject({ shape: "square", w: 140, h: 140 });
  });

  it("tocar numa mesa sem posição só seleciona: não posiciona nem suja a planta", () => {
    state.tables = [mesa("t1", 1, 200), mesa("t5", 5, null)];
    renderPage();
    const m5 = screen.getByRole("button", { name: "Mesa 5, 4 lugares, sem posição" });
    fireEvent.pointerDown(m5, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(m5, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(m5, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.click(m5);
    expect(m5.getAttribute("data-positioned")).toBe("false");
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("R gira 15° e Delete manda a mesa para a bandeja", () => {
    renderPage();
    const mesa3 = () => screen.getByRole("button", { name: /^Mesa 3, 4 lugares/ });
    fireEvent.click(mesa3());
    fireEvent.keyDown(mesa3(), { key: "r" });
    expect((screen.getByLabelText("Rotação (graus)") as HTMLInputElement).value).toBe("15");
    fireEvent.keyDown(mesa3(), { key: "Delete" });
    expect(mesa3().getAttribute("data-positioned")).toBe("false");
    expect(screen.getByRole("button", { name: "Mesa 3 · 4 lugares" })).toBeTruthy();
  });

  it("teclas fora da lona e com Ctrl não mexem na mesa", () => {
    renderPage();
    const mesa3 = () => screen.getByRole("button", { name: "Mesa 3, 4 lugares" });
    fireEvent.click(mesa3());
    fireEvent.keyDown(screen.getByRole("radio", { name: "Quadrada" }), { key: "ArrowRight" });
    fireEvent.keyDown(mesa3(), { key: "r", ctrlKey: true });
    fireEvent.keyDown(mesa3(), { key: "Backspace" });
    expect(mesa3().getAttribute("data-x")).toBe("600");
    expect(mesa3().getAttribute("data-positioned")).toBe("true");
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Salvar chama mutate com a revisão intacta e o payload", () => {
    renderPage();
    const mesa3 = screen.getByRole("button", { name: "Mesa 3, 4 lugares" });
    fireEvent.click(mesa3);
    fireEvent.keyDown(mesa3, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const arg = mutate.mock.calls[0][0];
    expect(arg.expectedUpdatedAt).toBe(hall.updated_at);
    const plan = hallPlanFrom(hall as unknown as Hall);
    const boxes = resolveTableBoxes(plan, state.tables as unknown as Mesa[]).map((b) =>
      b.tableId === "t3" ? { ...b, x: 625 } : b,
    );
    expect(arg.payload).toEqual(toSavePayload(plan, boxes));
  });

  it("não-gerente: sem Salvar e a mesa não se move", () => {
    state.isGerente = false;
    renderPage();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    const mesa3 = screen.getByRole("button", { name: "Mesa 3, 4 lugares" });
    fireEvent.click(mesa3);
    fireEvent.keyDown(mesa3, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Mesa 3, 4 lugares" }).getAttribute("data-x")).toBe("600");
  });

  it("erro mostra Tentar de novo e chama refetch", () => {
    state.isError = true;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("salão sem mesas mostra aviso e link de volta", () => {
    state.tables = [];
    renderPage();
    expect(screen.getByText("Cadastre mesas neste salão para montar a planta")).toBeTruthy();
    const link = screen.getByRole("link", { name: /voltar ao salão/i });
    expect(link.getAttribute("href")).toBe("/g/moralles/reservas/saloes/h1");
  });
});

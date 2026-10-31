import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { hallPlanFrom, resolveTableBoxes, toSavePayload } from "@/lib/hall-plan-core";
import type { Hall, Mesa } from "@/types/reserva";

const mutate = vi.fn();
const refetch = vi.fn();
const state: { isGerente: boolean; isError: boolean; tables: ReturnType<typeof mesa>[] } = {
  isGerente: true,
  isError: false,
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
  state.tables = [mesa("t1", 1, 200), mesa("t3", 3, 600)];
});

describe("SalaoPlanta", () => {
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

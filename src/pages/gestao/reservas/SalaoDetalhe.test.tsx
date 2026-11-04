// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { state, calls, mutation } = vi.hoisted(() => ({
  state: { hall: null as unknown, isError: false },
  calls: { useHall: [] as unknown[][] },
  mutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
}));

vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: "unit-a", unit_slug: "loja-a" }),
}));
vi.mock("@/hooks/useHalls", () => ({
  useHall: (...args: unknown[]) => {
    calls.useHall.push(args);
    return { data: state.hall, isLoading: false, isError: state.isError, refetch: vi.fn() };
  },
  useUpdateHall: mutation,
  useDeleteHall: mutation,
}));
vi.mock("@/hooks/useHallSchedules", () => ({
  useHallSchedules: () => ({ data: [], isLoading: false }),
  useCreateHallSchedules: mutation,
  useUpdateHallSchedule: mutation,
  useDeleteHallSchedule: mutation,
}));
vi.mock("@/hooks/useHallTables", () => ({
  useHallTables: () => ({ data: [] }),
  useCreateTablesBulk: mutation,
  useDeleteTable: mutation,
}));

import SalaoDetalhe from "./SalaoDetalhe";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/g/loja-a/reservas/saloes/h-b"]}>
      <Routes>
        <Route path="/g/:unitSlug/reservas/saloes/:hallId" element={<SalaoDetalhe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.hall = null;
  state.isError = false;
  calls.useHall.length = 0;
});

describe("SalaoDetalhe", () => {
  it("salão de outra unidade: mostra 'não encontrado' e nenhuma ação", () => {
    renderAt();
    expect(screen.getByText("Salão não encontrado nesta unidade.")).toBeTruthy();
    expect(screen.queryByText(/Excluir salão/)).toBeNull();
    expect(screen.queryByText(/Editar salão/)).toBeNull();
    expect(screen.queryByText(/Editar planta/)).toBeNull();
    expect(calls.useHall[0]).toEqual(["unit-a", "h-b"]);
  });

  it("controle: salão da unidade mostra as ações", () => {
    state.hall = { id: "h-a", unit_id: "unit-a", name: "Salão A", active: true, allow_empty_seat: false, description: null };
    renderAt();
    expect(screen.queryByText("Salão não encontrado nesta unidade.")).toBeNull();
    expect(screen.getByText(/Excluir salão/)).toBeTruthy();
    expect(screen.getByText(/Editar salão/)).toBeTruthy();
    expect(screen.getByText(/Editar planta/)).toBeTruthy();
  });

  it("erro de leitura mostra a tela de erro com nova tentativa", () => {
    state.isError = true;
    renderAt();
    expect(screen.getByText("Erro ao carregar o salão.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });
});

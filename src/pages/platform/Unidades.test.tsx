// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformUnidades from "./Unidades";

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  query: {
    isLoading: false,
    isError: false,
    error: null as Error | null,
    data: [
      { id: "u1", slug: "ren-centro", name: "Ren Centro", organization_id: "org-ren", organization_name: "Ren Sushi", organization_slug: "ren-sushi" },
      { id: "u2", slug: "ren-praia", name: "Ren Praia", organization_id: "org-ren", organization_name: "Ren Sushi", organization_slug: "ren-sushi" },
      { id: "u3", slug: "moralles", name: "Moralles", organization_id: "org-moralles", organization_name: "Moralles", organization_slug: "moralles" },
    ] as unknown[] | undefined,
  },
}));

vi.mock("@/hooks/useAllUnits", () => ({
  useAllUnits: () => ({ ...mocks.query, refetch: mocks.refetch }),
}));

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PlatformUnidades />
    </MemoryRouter>,
  );

const rows = () => screen.getAllByRole("row").slice(1);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.query.isError = false;
  mocks.query.error = null;
});

describe("Unidades", () => {
  it("sem filtro lista todas e cada Configurar abre a loja certa", () => {
    renderAt("/platform/unidades");
    expect(rows()).toHaveLength(3);
    const praia = rows().find((row) => row.textContent?.includes("Ren Praia"));
    expect(within(praia!).getByRole("link", { name: /Configurar/ }).getAttribute("href")).toBe(
      "/platform/unidades/ren-praia",
    );
    expect(screen.queryByRole("link", { name: "Ver todas" })).toBeNull();
  });

  it("com ?empresa= mostra só as unidades dela e oferece voltar para todas", () => {
    renderAt("/platform/unidades?empresa=org-ren");
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText("Moralles", { selector: "td" })).toBeNull();
    expect(screen.getByText(/Unidades de/).textContent).toContain("Ren Sushi");
    expect(screen.getByRole("link", { name: "Ver todas" }).getAttribute("href")).toBe("/platform/unidades");
  });

  it("empresa sem unidade diz isso, em vez de lista vazia muda", () => {
    renderAt("/platform/unidades?empresa=org-inexistente");
    expect(screen.getByText("Nenhuma unidade para esta empresa.")).toBeTruthy();
    expect(screen.getByText("Unidades desta empresa")).toBeTruthy();
  });

  it("falha ao carregar não vira 'nenhuma unidade'", () => {
    mocks.query.isError = true;
    mocks.query.error = new Error("boom");
    renderAt("/platform/unidades");
    expect(screen.queryByText(/Nenhuma unidade/)).toBeNull();
    screen.getByRole("button", { name: "Tentar novamente" }).click();
    expect(mocks.refetch).toHaveBeenCalled();
  });
});

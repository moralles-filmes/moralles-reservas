// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GestaoLayout } from "./GestaoLayout";

const mocks = vi.hoisted(() => ({
  unit: { current: null as null | { unit_id: string; unit_slug: string; isGerente: boolean } },
  grant: { current: {} as { data?: { instagram: { active: boolean } }; isError?: boolean; isLoading?: boolean } },
  moduleArg: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ signOut: vi.fn(), isPlatformAdmin: false }) }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit.current }));
vi.mock("@/hooks/useAwaitingHumanCount", () => ({ useAwaitingHumanCount: () => 0 }));
vi.mock("@/hooks/useInstagram", () => ({
  useInstagramModule: (id: string | undefined) => { mocks.moduleArg(id); return mocks.grant.current; },
}));
vi.mock("@/components/layouts/SidebarUnitProfile", () => ({ SidebarUnitProfile: () => null }));
vi.mock("@/components/layouts/AdminShell", () => ({
  AdminShell: ({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) => (
    <div><nav>{sidebar}</nav><main>{children}</main></div>
  ),
}));

afterEach(() => { cleanup(); mocks.moduleArg.mockReset(); });

function renderLayout(isGerente = true) {
  mocks.unit.current = { unit_id: "u", unit_slug: "loja", isGerente };
  return render(
    <MemoryRouter initialEntries={["/g/loja"]}>
      <Routes><Route path="/g/:unitSlug" element={<GestaoLayout><p>x</p></GestaoLayout>} /></Routes>
    </MemoryRouter>,
  );
}

describe("GestaoLayout: item Instagram", () => {
  it("aparece com grant ativo e gerente", () => {
    mocks.grant.current = { data: { instagram: { active: true } } };
    renderLayout();
    expect(screen.getByRole("link", { name: "Instagram" }).getAttribute("href")).toBe("/g/loja/instagram");
  });
  it("não aparece sem grant ativo", () => {
    mocks.grant.current = { data: { instagram: { active: false } } };
    renderLayout();
    expect(screen.queryByRole("link", { name: "Instagram" })).toBeNull();
  });
  it("não aparece com erro de leitura nem carregando", () => {
    mocks.grant.current = { isError: true };
    renderLayout();
    expect(screen.queryByRole("link", { name: "Instagram" })).toBeNull();
    cleanup();
    mocks.grant.current = { isLoading: true };
    renderLayout();
    expect(screen.queryByRole("link", { name: "Instagram" })).toBeNull();
  });
  it("não aparece para operador, mesmo com grant, e nem consulta o grant", () => {
    mocks.grant.current = { data: { instagram: { active: true } } };
    renderLayout(false);
    expect(screen.queryByRole("link", { name: "Instagram" })).toBeNull();
    expect(mocks.moduleArg).toHaveBeenCalledWith(undefined);
  });
});

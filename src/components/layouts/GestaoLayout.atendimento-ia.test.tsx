// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GestaoLayout } from "./GestaoLayout";

const mocks = vi.hoisted(() => ({
  unit: { current: null as null | { unit_id: string; unit_slug: string; isGerente: boolean } },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ signOut: vi.fn(), isPlatformAdmin: false }) }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit.current }));
vi.mock("@/hooks/useAwaitingHumanCount", () => ({ useAwaitingHumanCount: () => 0 }));
vi.mock("@/components/layouts/SidebarUnitProfile", () => ({ SidebarUnitProfile: () => null }));
vi.mock("@/components/layouts/AdminShell", () => ({
  AdminShell: ({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <nav>{sidebar}</nav>
      <main>{children}</main>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  mocks.unit.current = null;
});

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/g/loja"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/g/:unitSlug" element={<GestaoLayout><p>conteúdo</p></GestaoLayout>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("GestaoLayout: item Atendimento por IA", () => {
  it("aparece para owner/gerente, depois de Conversas, apontando para a rota da tela", () => {
    mocks.unit.current = { unit_id: "u", unit_slug: "loja", isGerente: true };
    renderLayout();
    const link = screen.getByRole("link", { name: "Atendimento por IA" });
    expect(link.getAttribute("href")).toBe("/g/loja/atendimento-ia");
    const labels = screen.getAllByRole("link").map((a) => a.textContent?.trim());
    expect(labels.indexOf("Atendimento por IA")).toBe(labels.indexOf("Conversas") + 1);
  });

  it("não aparece para quem não é owner/gerente", () => {
    mocks.unit.current = { unit_id: "u", unit_slug: "loja", isGerente: false };
    renderLayout();
    expect(screen.queryByRole("link", { name: "Atendimento por IA" })).toBeNull();
    // O resto do menu continua lá.
    expect(screen.getByRole("link", { name: "Conversas" })).toBeTruthy();
  });

  it("não aparece enquanto a unidade não foi resolvida", () => {
    mocks.unit.current = null;
    renderLayout();
    expect(screen.queryByRole("link", { name: "Atendimento por IA" })).toBeNull();
  });
});

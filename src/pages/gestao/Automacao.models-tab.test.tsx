// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Automacao from "./Automacao";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  unit: { id: "unit-a", name: "Unidade A", organization_id: "org-a", organization_name: "Org", default_whatsapp_provider: "datafy" },
}));

vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useAllUnits", () => ({ useUnitBySlug: () => ({ isLoading: false, data: mocks.unit }) }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/components/whatsapp/DatafyAdminCard", () => ({ DatafyAdminCard: () => null }));
vi.mock("@/components/whatsapp/TemplateCatalogAdminCard", () => ({ TemplateCatalogAdminCard: ({ unitId }: { unitId: string }) => <div data-testid="catalog" data-unit-id={unitId}>Catálogo</div> }));
vi.mock("@/components/whatsapp/TemplateDispatchAdminCard", () => ({ TemplateDispatchAdminCard: ({ unitId }: { unitId: string }) => <div data-testid="dispatch" data-unit-id={unitId}>Despacho</div> }));
vi.mock("@/components/whatsapp/TemplateDispatchVersionAdminCard", () => ({ TemplateDispatchVersionAdminCard: ({ unitId }: { unitId: string }) => <div data-testid="version" data-unit-id={unitId}>Versão</div> }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  mocks.unit.id = "unit-a";
  mocks.unit.name = "Unidade A";
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ error: null, data:
    body.action === "list" ? { channels: [] } :
    body.action === "list_provider_metadata" ? { providers: [] } : { success: true },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(client: QueryClient) {
  return <MemoryRouter>
    <QueryClientProvider client={client}><Automacao /></QueryClientProvider>
  </MemoryRouter>;
}

describe("Modelos e envios na página da unidade", () => {
  it("mantém os cartões fora de Canais e os exibe na ordem prevista ao abrir a nova aba", async () => {
    const user = userEvent.setup();
    render(view(new QueryClient({ defaultOptions: { queries: { retry: false } } })));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Canais WhatsApp", "Modelos e envios", "Provedor de IA", "Instruções do agente", "Diagnóstico", "Pagamentos",
    ]);
    expect(screen.getByRole("tablist", { name: "Configurações da unidade" }).className).toContain("overflow-x-auto");
    expect(screen.queryByTestId("catalog")).toBeNull();
    expect(screen.queryByTestId("dispatch")).toBeNull();
    expect(screen.queryByTestId("version")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Modelos e envios" }));
    await screen.findByTestId("catalog");
    expect(["catalog", "dispatch", "version"].map((id) => screen.getByTestId(id).textContent)).toEqual(["Catálogo", "Despacho", "Versão"]);
    expect(["catalog", "dispatch", "version"].map((id) => screen.getByTestId(id).getAttribute("data-unit-id"))).toEqual(["unit-a", "unit-a", "unit-a"]);
    expect(screen.getByText(/aguarde a aprovação da Meta/)).toBeTruthy();
    expect(screen.getByText(/não envia mensagens por si/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Canais WhatsApp" }));
    expect(screen.queryByTestId("catalog")).toBeNull();
    expect(screen.queryByTestId("dispatch")).toBeNull();
    expect(screen.queryByTestId("version")).toBeNull();
  });

  it("permite navegar pelo teclado e reinicia a aba ao trocar de unidade", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = render(view(client));
    const channelsTab = screen.getByRole("tab", { name: "Canais WhatsApp" });
    await user.click(channelsTab);
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Modelos e envios" }).getAttribute("aria-selected")).toBe("true"));

    mocks.unit.id = "unit-b";
    mocks.unit.name = "Unidade B";
    result.rerender(view(client));
    expect(screen.getByRole("tab", { name: "Canais WhatsApp" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("catalog")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Modelos e envios" }));
    expect((await screen.findByTestId("catalog")).getAttribute("data-unit-id")).toBe("unit-b");
  });
});

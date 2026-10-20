// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Automacao from "./Automacao";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useAllUnits", () => ({ useUnitBySlug: () => ({ isLoading: false, data: { id: "unit-a", name: "Unit", organization_name: "Org", default_whatsapp_provider: "datafy" } }) }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
const capabilities = { manualCredentials: true, automaticProvisioning: false, automaticWebhook: false };
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ error: null, data:
    body.action === "list" ? { channels: [{ id: "local", provider: "datafy", status: "connected", capabilities, manual_echo_verified_at: null }] } :
    body.action === "list_provider_metadata" ? { providers: [{ name: "datafy", label: "Datafy", capabilities }] } :
    body.action === "official_connection_state" ? { items: [], granted: false, step: "not_granted", templatesPending: true } : { success: true },
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Automacao /></QueryClientProvider></MemoryRouter>);
}
describe("Datafy channel dialogs", () => {
  it("starts the add dialog with the organization's default provider", async () => {
    mount();
    await screen.findByRole("button", { name: "Editar" });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar canal" }));
    expect(screen.getByLabelText("Token da Datafy")).toBeTruthy();
    expect(screen.getByRole("combobox").textContent).toBe("Datafy");
  });
  it("edits the Datafy channel token without requesting account credentials", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    const input = screen.getByLabelText("Token da Datafy");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "synthetic-channel-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("manage-channels", { body: { action: "update", unit_id: "unit-a", channel_id: "local", credentials: { access_token: "synthetic-channel-token" } } }));
    expect(screen.queryByText("Token da conta Datafy")).toBeNull();
  });
  it("Ativar / trocar sem migração não mostra avisos de corte", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Ativar / trocar" }));
    expect(await screen.findByText("Validar e ativar Datafy (API Oficial)?")).toBeTruthy();
    expect(screen.queryByText("Libere o despacho de templates logo após a troca.")).toBeNull();
    expect(screen.queryByText(/substitui o canal/)).toBeNull();
  });
  it("lista de canais com erro bloqueia a liberação no cartão Datafy e oferece recarga", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve(body.action === "list"
      ? { error: new Error("offline"), data: null }
      : { error: null, data: body.action === "official_connection_state" ? { items: [], granted: false, step: "not_granted", templatesPending: true } : { success: true } }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Recarregar canais" }));
    expect(screen.getByRole("button", { name: "Liberar conexão oficial" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([, { body }]) => body.action === "list").length).toBeGreaterThanOrEqual(2));
  });
});

describe("Datafy cutover dialog during migration", () => {
  const uazapiCapabilities = { manualCredentials: false, automaticProvisioning: true, automaticWebhook: true };
  function mockMigration(templatesPending: boolean) {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ error: null, data:
      body.action === "list" ? { channels: [
        { id: "uaz12345-0000-0000-0000-000000000000", provider: "uazapi", status: "connected", is_active: true, capabilities: uazapiCapabilities,
          manual_echo_verified_at: "2025-01-02T00:00:00Z", created_at: "2025-01-01T00:00:00Z" },
        { id: "local", provider: "datafy", status: "connected", is_active: false, capabilities, provider_subscribed_at: "2026-01-01T00:00:00Z",
          manual_echo_verified_at: "2026-01-01T01:00:00Z", created_at: "2026-01-01T00:00:00Z" },
      ] } :
      body.action === "list_provider_metadata" ? { providers: [{ name: "datafy", label: "Datafy", capabilities }] } :
      body.action === "official_connection_state" ? { items: [], granted: false, step: "awaiting_cutover", templatesPending, migration: { fromProvider: "uazapi" } } : { success: true },
    }));
  }
  it.each([
    [true, "Templates de automação ainda não liberados para esta unidade."],
    [false, "Despacho de templates já adotado nesta unidade."],
  ])("mostra o canal substituído, os templates (pendentes=%s) e o despacho", async (templatesPending, templatesCopy) => {
    mockMigration(templatesPending);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Ativar / trocar" }));
    expect(await screen.findByText("Migração: substitui o canal UazAPI uaz12345.")).toBeTruthy();
    expect(screen.getByText(templatesCopy)).toBeTruthy();
    expect(screen.getByText("Libere o despacho de templates logo após a troca.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Validar e ativar" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("manage-channels", { body: expect.objectContaining({ action: "begin_switch", unit_id: "unit-a", channel_id: "local" }) }));
  });
});

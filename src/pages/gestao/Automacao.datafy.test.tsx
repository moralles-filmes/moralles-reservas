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
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ error: null, data:
    body.action === "list" ? { channels: [{ id: "local", provider: "datafy", status: "connected", capabilities, manual_echo_verified_at: null }] } :
    body.action === "list_provider_metadata" ? { providers: [{ name: "datafy", label: "Datafy", capabilities }] } :
    body.action === "official_connection_state" ? { items: [], granted: false, step: "not_granted", templatesPending: true } : { success: true },
  }));
});
afterEach(cleanup);
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
});

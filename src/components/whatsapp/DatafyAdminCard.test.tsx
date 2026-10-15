// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatafyAdminCard } from "./DatafyAdminCard";
import type { WhatsAppChannel } from "@/types/reserva";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), granted: false, success: vi.fn(), error: vi.fn() }));
vi.mock("@/hooks/useWhatsAppChannels", () => ({ invokeManageChannels: mocks.invoke }));
vi.mock("@/hooks/useOfficialConnection", () => ({ useOfficialConnection: () => ({ data: { granted: mocks.granted, onboardingState: null, templatesPending: true }, isLoading: false, isError: false }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
const channel = { id: "channel-one", provider: "datafy", status: "connected", is_active: false, manual_echo_verified_at: null,
  provider_subscribed_at: "2026-01-01T00:00:00Z", activation_requested_at: null, ingestion_mode_effective: "unknown" } as WhatsAppChannel;
function mount(unitId = "u1", channels = [channel]) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...render(<DatafyAdminCard unitId={unitId} channels={channels} />, { wrapper }), client };
}
beforeEach(() => { vi.clearAllMocks(); mocks.granted = false; mocks.invoke.mockResolvedValue(null); });
afterEach(cleanup);
describe("Datafy platform controls", () => {
  it.each([[false, "Liberar conexão oficial", "grant_official_connection"], [true, "Revogar liberação", "revoke_official_connection"]] as const)("confirms grant/revoke %s and prevents duplicate submission", async (granted, label, action) => {
    mocks.granted = granted;
    let finish: (value: null) => void;
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(mocks.invoke).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenCalledWith({ action, unit_id: "u1" });
    await act(async () => finish(null));
  });
  it.each([["Cancelar assinatura", "datafy_cancel"], ["Pausar canal", "datafy_pause"]])("writes the effect before %s", async (label, action) => {
    mount(); fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByText("Ao confirmar, o número para de enviar e receber.")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith({ action, unit_id: "u1", channel_id: channel.id }));
  });
  it("requires the exact preview name and pins the selected local channel", async () => {
    mocks.invoke.mockResolvedValueOnce({ candidates: [{ name: "Restaurante Azul", expectedDatafyChannelId: "remote-candidate", idPrefix: "remote-c", subscribed: true, paused: false, webhookHosts: ["hooks.example.test"] }] });
    mount(); fireEvent.click(screen.getByRole("button", { name: "Buscar canal existente" }));
    await screen.findByText("Restaurante Azul · remote-c");
    expect(screen.getByText("Hosts dos webhooks: hooks.example.test")).toBeTruthy();
    expect(screen.getByText("Assinatura: Confirmada · Não pausado")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirmar vínculo" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Selecionar Restaurante Azul" }));
    fireEvent.change(screen.getByLabelText("Digite o nome do canal: Restaurante Azul"), { target: { value: "Restaurante" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Digite o nome do canal: Restaurante Azul"), { target: { value: "Restaurante Azul" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith({ action: "datafy_link_existing", phase: "link", unit_id: "u1", channel_id: channel.id, expected_datafy_channel_id: "remote-candidate" }));
  });
  it("isolates delayed previews on unit change and invalidates only the initiating unit", async () => {
    let finish: (value: unknown) => void;
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount(); const invalidated = vi.spyOn(view.client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Buscar canal existente" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    view.rerender(<DatafyAdminCard unitId="u2" channels={[]} />);
    await act(async () => finish({ candidates: [{ name: "Old", expectedDatafyChannelId: "old", idPrefix: "old", webhookHosts: [] }] }));
    expect(screen.queryByText("Vincular canal existente")).toBeNull();
    expect(invalidated.mock.calls.every(([arg]) => arg.queryKey?.[1] === "u1")).toBe(true);
  });
  it("shows app-only exit guidance after 24h and computes each channel checklist separately", () => {
    mount("u1", [channel, { ...channel, id: "second", provider_subscribed_at: null }]);
    expect(screen.getByText(/se for um número só de API, ele nunca vai ativar: cancele a assinatura/)).toBeTruthy();
    expect(screen.getByText("Concluído: Assinatura confirmada")).toBeTruthy();
    expect(screen.getByText("Pendente: Assinatura confirmada")).toBeTruthy();
    expect(screen.getAllByText("Ingestão efetiva: Desconhecida (processamento bloqueado)")).toHaveLength(2);
  });
  it("never recommends canceling for missing echo when a historical channel already has proof", () => {
    mount("u1", [{ ...channel, manual_echo_verified_at: "2026-01-01T01:00:00Z", provider_paused_at: "2026-01-02T00:00:00Z" }]);
    expect(screen.queryByText(/ele nunca vai ativar: cancele a assinatura/)).toBeNull();
    expect(screen.getByText(/Pausado em/)).toBeTruthy();
  });
  it("renders invalid timestamps as unavailable", () => {
    mount("u1", [{ ...channel, provider_subscribed_at: "invalid", activation_requested_at: "invalid" }]);
    expect(document.body.textContent).not.toMatch(/NaN|Invalid Date/);
  });
  it("does not report a successful subscription when the provider returns an actionable failure", async () => {
    mocks.invoke.mockResolvedValue({ step: "subscription_pending", code: "DATAFY_PAYMENT_DECLINED" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Assinar canal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatafyAdminCard } from "./DatafyAdminCard";
import type { WhatsAppChannel } from "@/types/reserva";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), granted: false, migration: null as { fromProvider: string } | null, success: vi.fn(), error: vi.fn() }));
vi.mock("@/hooks/useWhatsAppChannels", () => ({ invokeManageChannels: mocks.invoke }));
vi.mock("@/hooks/useOfficialConnection", () => ({ useOfficialConnection: () => ({ data: { granted: mocks.granted, onboardingState: null, templatesPending: true, migration: mocks.migration }, isLoading: false, isError: false }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
const channel = { id: "channel-one", provider: "datafy", status: "connected", is_active: false, manual_echo_verified_at: null,
  provider_subscribed_at: "2026-01-01T00:00:00Z", activation_requested_at: null, ingestion_mode_effective: "unknown" } as WhatsAppChannel;
function mount(unitId = "u1", channels = [channel], load: { channelsReady?: boolean; channelsError?: boolean; onRetryChannels?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...render(<DatafyAdminCard unitId={unitId} channels={channels} channelsReady={load.channelsReady ?? true} channelsError={load.channelsError} onRetryChannels={load.onRetryChannels} />, { wrapper }), client };
}
const uazapi = { id: "uaz12345-0000-0000-0000-000000000000", provider: "uazapi", status: "connected", is_active: true, manual_echo_verified_at: null,
  activation_requested_at: null, created_at: "2025-01-01T00:00:00Z" } as WhatsAppChannel;
beforeEach(() => { vi.clearAllMocks(); mocks.granted = false; mocks.migration = null; mocks.invoke.mockResolvedValue(null); });
afterEach(cleanup);
describe("Datafy platform controls", () => {
  it("binding de outro provider vira liberação de migração com diálogo explicativo", async () => {
    mount("u1", [uazapi]);
    expect(screen.queryByRole("button", { name: "Liberar conexão oficial" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Liberar migração para oficial" }));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByText("Liberar migração para oficial?")).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).toContain("cai por alguns minutos");
    expect(body).toContain("QR Code");
    expect(body).toContain("Ativar / trocar");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith({ action: "grant_official_connection", unit_id: "u1" }));
  });
  it.each([
    ["sem canal", []],
    ["binding datafy", [{ ...channel, is_active: true }]],
    ["binding datafy com legado de outro provider", [{ ...channel, is_active: true }, { ...uazapi, is_active: null, status: "disconnected" }]],
    ["canal outro provider inativo", [{ ...uazapi, is_active: false }]],
  ] as const)("liberação comum quando nenhum canal seria substituído (%s)", (_label, channels) => {
    mount("u1", [...channels] as WhatsAppChannel[]);
    expect(screen.getByRole("button", { name: "Liberar conexão oficial" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Liberar migração para oficial" })).toBeNull();
  });
  it.each([
    ["legado NULL conectado", "connected"],
    ["legado NULL desconectado, sem binding", "disconnected"],
  ])("%s de outro provider também vira liberação de migração", (_label, status) => {
    mount("u1", [{ ...uazapi, is_active: null, status } as WhatsAppChannel]);
    expect(screen.getByRole("button", { name: "Liberar migração para oficial" })).toBeTruthy();
  });
  it("revogação mantém o rótulo e a migração mostra o canal substituído", () => {
    mocks.granted = true;
    mocks.migration = { fromProvider: "uazapi" };
    mount("u1", [uazapi, channel]);
    expect(screen.getByRole("button", { name: "Revogar liberação" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Liberar migração para oficial" })).toBeNull();
    expect(screen.getByText("Migração: substitui o canal UazAPI uaz12345")).toBeTruthy();
  });
  it("canais carregando: liberação fica bloqueada até saber o binding", () => {
    mount("u1", [], { channelsReady: false });
    expect(screen.getByRole("status").textContent).toBe("Carregando canais…");
    expect(screen.getByRole("button", { name: "Liberar conexão oficial" }).hasAttribute("disabled")).toBe(true);
  });
  it("erro nos canais: liberação bloqueada e recarga disponível", () => {
    const retry = vi.fn();
    mount("u1", [], { channelsReady: false, channelsError: true, onRetryChannels: retry });
    expect(screen.getByRole("alert").textContent).toBe("Não foi possível carregar os canais da unidade.");
    expect(screen.getByRole("button", { name: "Liberar conexão oficial" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recarregar canais" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("revogação também espera os canais", () => {
    mocks.granted = true;
    mount("u1", [], { channelsReady: false });
    expect(screen.getByRole("button", { name: "Revogar liberação" }).hasAttribute("disabled")).toBe(true);
  });
  it("migração em andamento (liberação consumida) não oferece segunda liberação", () => {
    mocks.migration = { fromProvider: "uazapi" };
    mount("u1", [uazapi, { ...channel, manual_echo_verified_at: "2026-01-01T01:00:00Z" }]);
    expect(screen.queryByRole("button", { name: "Liberar migração para oficial" })).toBeNull();
    const grant = screen.getByRole("button", { name: "Liberar conexão oficial" });
    expect(grant.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Migração em andamento: nova liberação indisponível até a troca.")).toBeTruthy();
    fireEvent.click(grant);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });
  it("sem migração não mostra a linha de substituição", () => {
    mount("u1", [uazapi, channel]);
    expect(screen.queryByText(/Migração: substitui o canal/)).toBeNull();
  });
  it("migração retida mostra awaiting_cutover no checklist do canal", () => {
    mocks.migration = { fromProvider: "uazapi" };
    const ready = { ...channel, manual_echo_verified_at: "2026-01-01T01:00:00Z" };
    mount("u1", [uazapi, ready]);
    expect(screen.getByText(/Pronto para a troca/)).toBeTruthy();
    expect(screen.queryByText(/Aguardando mensagem do app/)).toBeNull();
    cleanup();
    mocks.migration = null;
    mount("u1", [uazapi, ready]);
    expect(screen.queryByText(/Pronto para a troca/)).toBeNull();
  });
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
    view.rerender(<DatafyAdminCard unitId="u2" channels={[]} channelsReady />);
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

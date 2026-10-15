// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Whatsapp from "./Whatsapp";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unit: { unit_id: "u1", unit_slug: "restaurante", organization_id: "org1", isGerente: true } }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("react-router-dom", () => ({ Navigate: ({ to }: { to: string }) => <span>{to}</span> }));
const base = { step: "ready_to_connect", granted: true, items: [], templatesPending: true, onboardingState: null };
let client: QueryClient;
const show = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Whatsapp /></QueryClientProvider>);
};
beforeEach(() => { vi.clearAllMocks(); mocks.unit.isGerente = true; });
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });
describe("portal WhatsApp oficial", () => {
  it("liberação substitui legado e não exibe QR nem consulta lifecycle legado", async () => {
    mocks.invoke.mockResolvedValue({ data: base });
    show();
    expect(await screen.findByRole("button", { name: "Conectar WhatsApp oficial" })).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
    expect(screen.queryByText("Nenhum número conectado")).toBeNull();
    expect(mocks.invoke.mock.calls.every(([, { body }]) => body.action === "official_connection_state")).toBe(true);
  });
  it("sem liberação preserva conexão legada e botão QR", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, granted: false, step: "not_granted" } : { channel_id: "c1", status: "disconnected", qr_available: true } }));
    show();
    expect(await screen.findByText("Nenhum número conectado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar WhatsApp oficial" })).toBeNull();
  });
  it("liberação consumida mantém checklist oficial aguardando eco", async () => {
    mocks.invoke.mockResolvedValue({ data: { ...base, granted: false, step: "awaiting_echo" } });
    show();
    expect(await screen.findByText("Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato")).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
  });
  it("erro do state oferece retry e não libera QR por fallback", async () => {
    mocks.invoke.mockResolvedValue({ error: new Error("indisponível") });
    show();
    expect(await screen.findByRole("button", { name: "Tentar novamente" })).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
  });
  it("operador não consulta nem exibe conexão", async () => {
    mocks.unit.isGerente = false;
    show();
    await waitFor(() => expect(screen.getByText("/g/restaurante/reservas")).toBeTruthy());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("state vazio tem mensagem própria e não libera QR", async () => {
    mocks.invoke.mockResolvedValue({ data: null });
    show();
    expect(await screen.findByText("Nenhuma conexão oficial disponível.")).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
  });
  it("carregamento não exibe legado antes de saber a liberação", () => {
    mocks.invoke.mockImplementation(() => new Promise(() => undefined));
    show();
    expect(screen.getByLabelText("Carregando conexão oficial")).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
  });
  it("clique navega popup sem guardar link no DOM ou caches", async () => {
    const url = "https://app.datafyapi.com.br/connect?token=ct_fixture_only";
    const popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connect_start" ? { url } : base }));
    show();
    const button = await screen.findByRole("button", { name: "Conectar WhatsApp oficial" });
    await act(async () => fireEvent.click(button));
    expect(popup.location.href).toBe(url);
    expect(document.body.innerHTML).not.toContain(url);
    expect(document.body.innerHTML).not.toContain("ct_fixture_only");
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(url);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
});

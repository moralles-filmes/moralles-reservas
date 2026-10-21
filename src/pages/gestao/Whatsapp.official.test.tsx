// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Whatsapp from "./Whatsapp";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unit: { unit_id: "u1", unit_slug: "restaurante", organization_id: "org1", isGerente: true } }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/components/whatsapp/ServiceNoticePreferencesCard", () => ({
  ServiceNoticePreferencesCard: ({ canManage }: { canManage: boolean }) => canManage ? null : <div>Modelos e avisos: somente leitura</div>,
}));
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
  it('permite ao operador consultar avisos sem mostrar ações de conexão', () => {
    mocks.unit.isGerente = false;
    show();
    expect(screen.getByText('Modelos e avisos: somente leitura')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Conectar WhatsApp|Reiniciar conexão|Desconectar/ })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('mostra os nove estados pelo onboarding Datafy conectado antes do corte', async () => {
    mocks.unit.unit_id = '10000000-0000-4000-8000-000000000001';
    try {
      mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === 'official_connection_state'
        ? { ...base, step: 'awaiting_echo', items: [{ id: 'number_connected', done: true }] }
        : body.action === 'onboarding_catalog_snapshot_v2'
          ? { channelId: null, templatePreparation: null, templates: [], generatedAt: '2026-10-17T19:00:00Z' }
          : { channel_id: null, status: 'not_configured' }, error: null }));
      show();
      expect(await screen.findByText('Análise dos modelos oficiais')).toBeInTheDocument();
      await waitFor(() => expect(mocks.invoke.mock.calls.some(([, { body }]) => body.action === 'onboarding_catalog_snapshot_v2')).toBe(true));
      expect(screen.queryByRole('button', { name: 'Solicitar sincronização' })).not.toBeInTheDocument();
    } finally { mocks.unit.unit_id = 'u1'; }
  });
  it.each(["disconnected", "provider_error"])("expõe saúde %s e recuperação do canal ativado", async (status) => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, step: "active" } : { channel_id: "c1", status } }));
    show();
    expect(await screen.findByText(status === "disconnected" ? "WhatsApp desconectado." : "Não foi possível verificar a conexão com o provedor.")).toBeTruthy();
    expect(screen.getByText("Ativação concluída.")).toBeTruthy();
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, step: "active" } : { channel_id: "c1", status: "connected" } }));
    await act(async () => { await client.invalidateQueries({ queryKey: ["whatsapp-connection", "u1"] }); });
    expect(await screen.findByText("WhatsApp conectado.")).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
    mocks.invoke.mockResolvedValue({ error: new Error("offline") });
    await act(async () => { await client.invalidateQueries({ queryKey: ["whatsapp-connection", "u1"] }); });
    expect(await screen.findByText("Saúde atual do WhatsApp indisponível.")).toBeTruthy();
    expect(screen.queryByText("WhatsApp conectado.")).toBeNull();
  });
  it.each(["missing", "error", "loading"])("saúde %s não aparece como conexão saudável", async (mode) => {
    mocks.invoke.mockImplementation((_name, { body }) => body.action === "official_connection_state"
      ? Promise.resolve({ data: { ...base, step: "active" } })
      : mode === "loading" ? new Promise(() => undefined)
      : Promise.resolve(mode === "error" ? { error: new Error("offline") } : { data: null }));
    show();
    expect(await screen.findByText(mode === "loading" ? "Consultando saúde atual do WhatsApp…" : "Saúde atual do WhatsApp indisponível.")).toBeTruthy();
    expect(screen.queryByText("WhatsApp conectado.")).toBeNull();
    expect(screen.queryByText("Conexão oficial ativada.")).toBeNull();
  });
  it("troca de unidade não conserva saúde anterior", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, step: "active" } : { channel_id: "c1", status: "connected" } }));
    const view = show();
    expect(await screen.findByText("WhatsApp conectado.")).toBeTruthy();
    mocks.unit.unit_id = "u2";
    try {
      mocks.invoke.mockImplementation((_name, { body }) => body.action === "official_connection_state" ? Promise.resolve({ data: { ...base, step: "active" } }) : new Promise(() => undefined));
      view.rerender(<QueryClientProvider client={client}><Whatsapp /></QueryClientProvider>);
      expect(await screen.findByText("Consultando saúde atual do WhatsApp…")).toBeTruthy();
      expect(screen.queryByText("WhatsApp conectado.")).toBeNull();
    } finally { mocks.unit.unit_id = "u1"; }
  });
  it("liberação substitui legado e não exibe QR nem consulta lifecycle legado", async () => {
    mocks.invoke.mockResolvedValue({ data: base });
    show();
    expect(await screen.findByRole("button", { name: "Conectar WhatsApp oficial" })).toBeTruthy();
    expect(screen.queryByText(/QR Code/)).toBeNull();
    expect(screen.queryByText("Nenhum número conectado")).toBeNull();
    expect(mocks.invoke.mock.calls.every(([, { body }]) => body.action === "official_connection_state")).toBe(true);
  });
  it("migração mostra a conexão atual com lifecycle e o cartão oficial com aviso", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state"
      ? { ...base, migration: { fromProvider: "uazapi" } }
      : { connection: { channel_id: "uaz-1", status: "connected", display_phone: "11999990000", lifecycle_available: true, restart_available: true, disconnect_available: true } } }));
    show();
    expect(await screen.findByText("Conexão atual")).toBeTruthy();
    expect(await screen.findByText("WhatsApp conectado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reiniciar conexão" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Conectar WhatsApp oficial" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("gere um novo QR Code em Conexão atual");
    expect(mocks.invoke.mock.calls.some(([, { body }]) => body.action === "list_client" && body.unit_id === "u1")).toBe(true);
  });
  it("migração com conexão atual caída oferece novo QR ao lado do cartão oficial", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state"
      ? { ...base, step: "awaiting_echo", granted: false, migration: { fromProvider: "uazapi" } }
      : { connection: { channel_id: "uaz-1", status: "disconnected", qr_available: true } } }));
    show();
    expect(await screen.findByRole("button", { name: "Conectar WhatsApp" })).toBeTruthy();
    expect(screen.getByText("Conexão atual")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Já concluí a conexão" })).toBeTruthy();
  });
  it("migração pronta para corte deixa a troca com o suporte", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state"
      ? { ...base, step: "awaiting_cutover", granted: false, migration: { fromProvider: "uazapi" } }
      : { connection: { channel_id: "uaz-1", status: "connected" } } }));
    show();
    expect(await screen.findByText("Canal oficial pronto. A troca será feita pelo suporte.")).toBeTruthy();
    expect(await screen.findByText("WhatsApp conectado")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar WhatsApp oficial" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Já concluí a conexão" })).toBeNull();
  });
  it("cartão oficial mantém a sessão quando a migração some", async () => {
    const popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    let migration: unknown = { fromProvider: "uazapi" };
    mocks.invoke.mockImplementation((_name, { body }) => body.action === "official_connect_start"
      ? new Promise(() => undefined)
      : Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, migration } : { connection: { channel_id: "uaz-1", status: "connected" } } }));
    show();
    expect(await screen.findByText("Conexão atual")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Conectar WhatsApp oficial" });
    await act(async () => fireEvent.click(button));
    expect(button.hasAttribute("disabled")).toBe(true);
    migration = null;
    await act(async () => { await client.invalidateQueries({ queryKey: ["official-connection", "u1"] }); });
    await waitFor(() => expect(screen.queryByText("Conexão atual")).toBeNull());
    // Mesmo nó e ainda pendente: a sessão não remontou (remontar fecharia a janela e zeraria o pending).
    expect(screen.getByRole("button", { name: "Conectar WhatsApp oficial" })).toBe(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(popup.close).not.toHaveBeenCalled();
  });
  it("sem migração o título da conexão legada não muda", async () => {
    mocks.invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connection_state" ? { ...base, granted: false, step: "not_granted" } : { channel_id: "c1", status: "connected" } }));
    show();
    expect(await screen.findByText("Conexão do número")).toBeTruthy();
    expect(screen.queryByText("Conexão atual")).toBeNull();
    expect(screen.queryByText("WhatsApp oficial")).toBeNull();
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

// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstagramAdminCard } from "./InstagramAdminCard";

const mocks = vi.hoisted(() => ({
  readUnitModules: vi.fn(),
  setUnitModule: vi.fn(),
  readInstagramAccount: vi.fn(),
  readInstagramDiagnostics: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/features/instagram/api", () => ({
  readUnitModules: mocks.readUnitModules,
  setUnitModule: mocks.setUnitModule,
  readInstagramAccount: mocks.readInstagramAccount,
  readInstagramDiagnostics: mocks.readInstagramDiagnostics,
  readInstagramSettings: vi.fn(),
  updateInstagramDm: vi.fn(),
  connectStart: vi.fn(),
  connectCallback: vi.fn(),
  disconnectInstagram: vi.fn(),
  resubscribeInstagram: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const unitId = "10000000-0000-4000-8000-000000000001";
const inactive = { instagram: { active: false, granted_at: null } };
const active = { instagram: { active: true, granted_at: "2026-10-20T12:00:00Z" } };
const diagnostics = {
  last_event_at: "2026-10-30T15:30:00Z",
  queue: { received: 3, processing: 1, done_24h: 42, dead: 2 },
  oldest_pending_received_at: "2026-10-30T14:00:00Z",
  outcomes_24h: { success: 40, algo_novo: 2 },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InstagramAdminCard unitId={unitId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readUnitModules.mockResolvedValue(inactive);
  mocks.setUnitModule.mockResolvedValue({ module: "instagram", active: true, granted_at: "x", revoked_at: null });
  mocks.readInstagramAccount.mockResolvedValue(null);
  mocks.readInstagramDiagnostics.mockResolvedValue(diagnostics);
});

describe("InstagramAdminCard", () => {
  it("libera o módulo chamando setUnitModule(unitId, true)", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Liberar Instagram" }));
    await waitFor(() => expect(mocks.setUnitModule).toHaveBeenCalledWith(unitId, true));
  });

  it("revoga o módulo chamando setUnitModule(unitId, false)", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revogar liberação" }));
    await waitFor(() => expect(mocks.setUnitModule).toHaveBeenCalledWith(unitId, false));
  });

  it("não mostra texto técnico bruto no toast de erro da liberação", async () => {
    mocks.setUnitModule.mockRejectedValue(new Error("module_grant_forbidden"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Liberar Instagram" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    const message = mocks.toast.error.mock.calls[0][0] as string;
    expect(message).toMatch(/^Não foi possível/);
    expect(message).not.toContain("module_grant_forbidden");
  });

  it("com o módulo desligado, não consulta conta nem diagnóstico", async () => {
    mount();
    await screen.findByRole("button", { name: "Liberar Instagram" });
    expect(mocks.readInstagramAccount).not.toHaveBeenCalled();
    expect(mocks.readInstagramDiagnostics).not.toHaveBeenCalled();
  });

  it("mostra @, validade do token e conta conectada", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mocks.readInstagramAccount.mockResolvedValue({
      username: "moralles", status: "connected", token_expires_at: "2026-12-31T12:00:00Z",
      connected_at: "2026-10-20T12:00:00Z", subscribed: true, last_error_code: null,
    });
    mount();
    expect(await screen.findByText(/@moralles/)).toBeInTheDocument();
    expect(screen.getByText(/Acesso válido até 31\/12\/2026/)).toBeInTheDocument();
    expect(screen.queryByText("Reconectar necessário")).not.toBeInTheDocument();
  });

  it("mostra 'Reconectar necessário' em reauth_required", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mocks.readInstagramAccount.mockResolvedValue({
      username: "moralles", status: "reauth_required", token_expires_at: null,
      connected_at: null, subscribed: false, last_error_code: "190",
    });
    mount();
    expect(await screen.findByText("Reconectar necessário")).toBeInTheDocument();
  });

  it("mostra estado vazio quando não há conta conectada", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mount();
    expect(await screen.findByText("Nenhuma conta do Instagram conectada.")).toBeInTheDocument();
  });

  it("diagnóstico mostra contagens e último evento, sem texto de mensagem", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mocks.readInstagramDiagnostics.mockResolvedValue({
      ...diagnostics,
      // Campo que nunca deve ir ao DOM mesmo que o backend o mandasse.
      message_text: "segredo do cliente",
    });
    mount();
    expect(await screen.findByText("Recebidas: 3")).toBeInTheDocument();
    expect(screen.getByText("Em processamento: 1")).toBeInTheDocument();
    expect(screen.getByText("Concluídas em 24 h: 42")).toBeInTheDocument();
    expect(screen.getByText("Com falha definitiva: 2")).toBeInTheDocument();
    expect(screen.getByText(/Último evento: 30\/10\/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/segredo do cliente/)).not.toBeInTheDocument();
    // Desfecho conhecido vai em PT-BR; desconhecido cai na chave crua.
    expect(screen.getByText("Respondida (24 h): 40")).toBeInTheDocument();
    expect(screen.getByText("algo_novo (24 h): 2")).toBeInTheDocument();
  });

  it("erro de leitura do módulo tem 'Tentar de novo' que refaz a leitura", async () => {
    mocks.readUnitModules.mockRejectedValueOnce(new Error("boom"));
    mount();
    expect(await screen.findByText(/Não foi possível carregar a liberação/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByRole("button", { name: "Liberar Instagram" })).toBeInTheDocument();
    expect(mocks.readUnitModules).toHaveBeenCalledTimes(2);
  });

  it("erro de leitura da conta e do diagnóstico têm 'Tentar de novo'", async () => {
    mocks.readUnitModules.mockResolvedValue(active);
    mocks.readInstagramAccount.mockRejectedValueOnce(new Error("x"));
    mocks.readInstagramDiagnostics.mockRejectedValueOnce(new Error("y"));
    mount();
    expect(await screen.findByText(/Não foi possível carregar a conta/)).toBeInTheDocument();
    expect(await screen.findByText(/Não foi possível carregar o diagnóstico/)).toBeInTheDocument();
    const retries = screen.getAllByRole("button", { name: "Tentar de novo" });
    expect(retries).toHaveLength(2);
    retries.forEach((b) => fireEvent.click(b));
    await waitFor(() => expect(mocks.readInstagramAccount).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.readInstagramDiagnostics).toHaveBeenCalledTimes(2));
  });
});

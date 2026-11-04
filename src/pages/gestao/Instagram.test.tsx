// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Instagram from "./Instagram";
import { INSTAGRAM_OAUTH_STATE_KEY } from "@/features/instagram/oauth";

const mocks = vi.hoisted(() => ({
  unit: { current: null as null | { unit_id: string; unit_slug: string; isGerente: boolean } },
  api: {
    readUnitModules: vi.fn(), readInstagramAccount: vi.fn(), readInstagramSettings: vi.fn(),
    updateInstagramDm: vi.fn(), connectStart: vi.fn(), disconnectInstagram: vi.fn(), resubscribeInstagram: vi.fn(),
    connectCallback: vi.fn(), readInstagramDiagnostics: vi.fn(), setUnitModule: vi.fn(),
  },
  redirect: vi.fn(),
}));
vi.mock("@/features/instagram/api", () => mocks.api);
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit.current }));
vi.mock("@/features/instagram/oauth", async (orig) => ({
  ...(await orig<typeof import("@/features/instagram/oauth")>()),
  redirectToAuthorize: mocks.redirect,
}));

const granted = { instagram: { active: true, granted_at: "2026-10-01" } };
const account = { username: "loja", status: "connected", token_expires_at: "2026-12-01T00:00:00Z", connected_at: "2026-10-01T00:00:00Z", subscribed: true, last_error_code: null };

function view(isGerente = true) {
  mocks.unit.current = { unit_id: "u1", unit_slug: "loja", isGerente };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/g/loja/instagram"]}>
        <Routes>
          <Route path="/g/:unitSlug/instagram" element={<Instagram />} />
          <Route path="/g/:unitSlug/reservas" element={<p>reservas</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks.api).forEach((f) => f.mockReset());
  mocks.redirect.mockReset().mockReturnValue(true);
  sessionStorage.clear();
  mocks.api.readUnitModules.mockResolvedValue(granted);
  mocks.api.readInstagramAccount.mockResolvedValue(account);
  mocks.api.readInstagramSettings.mockResolvedValue({ unit_id: "u1", dm_enabled: false, updated_at: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Página Instagram da loja", () => {
  it("operador é redirecionado e nunca chama status", async () => {
    view(false);
    expect(await screen.findByText("reservas")).toBeTruthy();
    expect(mocks.api.readInstagramAccount).not.toHaveBeenCalled();
    expect(mocks.api.readUnitModules).not.toHaveBeenCalled();
  });

  it("sem grant mostra o aviso e não consulta a conta", async () => {
    mocks.api.readUnitModules.mockResolvedValue({ instagram: { active: false, granted_at: null } });
    view();
    expect(await screen.findByText("Módulo não liberado para esta unidade.")).toBeTruthy();
    expect(mocks.api.readInstagramAccount).not.toHaveBeenCalled();
  });

  it("conectar guarda o state no sessionStorage antes de redirecionar", async () => {
    mocks.api.readInstagramAccount.mockResolvedValue(null);
    mocks.api.connectStart.mockResolvedValue({ authorize_url: "https://www.facebook.com/v26.0/dialog/oauth?client_id=1", state: "ST" });
    let storedAtRedirect: string | null = null;
    mocks.redirect.mockImplementation(() => {
      storedAtRedirect = sessionStorage.getItem(INSTAGRAM_OAUTH_STATE_KEY);
      return true;
    });
    view();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Conectar pelo Facebook" }));
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalledWith("https://www.facebook.com/v26.0/dialog/oauth?client_id=1"));
    expect(storedAtRedirect).toBe("ST");
  });

  it("sem conta mostra os três pré-requisitos acima do botão", async () => {
    mocks.api.readInstagramAccount.mockResolvedValue(null);
    view();
    const btn = await screen.findByRole("button", { name: "Conectar pelo Facebook" });
    const texts = [
      "O Instagram da loja precisa ser profissional e estar ligado a uma Página do Facebook.",
      "Você precisa administrar ou moderar essa Página.",
      "No app do Instagram, ligue Configurações › Mensagens e respostas ao story › Controles de mensagens › Ferramentas conectadas › Permitir acesso às mensagens.",
    ];
    for (const t of texts) {
      const el = screen.getByText(t);
      expect(el.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("não mostra mais 'Acesso válido até'", async () => {
    view();
    await screen.findByText("@loja");
    expect(screen.queryByText(/Acesso válido até/)).toBeNull();
  });

  describe("prazo de acesso aos dados", () => {
    const NOW = "2026-11-04T15:00:00Z";
    async function withExpiry(token_expires_at: string | null) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      mocks.api.readInstagramAccount.mockResolvedValue({ ...account, token_expires_at });
      view();
      await screen.findByText("@loja");
    }

    it("sem prazo (null): nada de prazo nem botão de renovar", async () => {
      await withExpiry(null);
      expect(screen.queryByText(/Reconecte até/)).toBeNull();
      expect(screen.queryByText(/venceu em/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Reconectar pelo Facebook" })).toBeNull();
    });

    it("a mais de 14 dias: texto sem destaque e sem botão (data em BRT)", async () => {
      // 02:00Z de 20/11 ainda é 19/11 em São Paulo.
      await withExpiry("2026-11-20T02:00:00Z");
      const el = screen.getByText("Reconecte até 19/11/2026 para manter o acesso.");
      expect(el.className).not.toMatch(/text-warning/);
      expect(screen.queryByRole("button", { name: "Reconectar pelo Facebook" })).toBeNull();
    });

    it("a 14 dias ou menos: destaque e botão que inicia a conexão", async () => {
      await withExpiry("2026-11-18T15:00:00Z");
      const el = screen.getByText("Reconecte até 18/11/2026 para manter o acesso.");
      expect(el.className).toMatch(/text-warning/);
      mocks.api.connectStart.mockResolvedValue({ authorize_url: "https://www.facebook.com/v26.0/dialog/oauth?x=1", state: "ST" });
      fireEvent.click(screen.getByRole("button", { name: "Reconectar pelo Facebook" }));
      await vi.waitFor(() => expect(mocks.redirect).toHaveBeenCalledWith("https://www.facebook.com/v26.0/dialog/oauth?x=1"));
    });

    it("vencido: mensagem de vencimento e botão", async () => {
      await withExpiry("2026-11-01T12:00:00Z");
      expect(screen.getByText("O acesso aos dados venceu em 01/11/2026. Reconecte para voltar a responder.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconectar pelo Facebook" })).toBeTruthy();
    });
  });

  it("mostra @ da conta e desconecta só após confirmação", async () => {
    mocks.api.disconnectInstagram.mockResolvedValue(undefined);
    view();
    const user = userEvent.setup();
    expect(await screen.findByText("@loja")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(mocks.api.disconnectInstagram).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Confirmar desconexão" }));
    await waitFor(() => expect(mocks.api.disconnectInstagram).toHaveBeenCalledWith("u1"));
  });

  it("reauth_required oferece Reconectar; subscribed:false oferece Assinar de novo", async () => {
    mocks.api.readInstagramAccount.mockResolvedValue({ ...account, status: "reauth_required" });
    view();
    expect(await screen.findByRole("button", { name: "Reconectar pelo Facebook" })).toBeTruthy();
    cleanup();
    mocks.api.readInstagramAccount.mockResolvedValue({ ...account, subscribed: false });
    view();
    expect(await screen.findByRole("button", { name: "Assinar de novo" })).toBeTruthy();
  });

  it("erro ao carregar a conta mostra Tentar de novo sem texto técnico", async () => {
    mocks.api.readInstagramAccount.mockRejectedValue(new Error("FunctionsFetchError boom"));
    view();
    expect(await screen.findByText("Não foi possível carregar a conta do Instagram.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
  });

  it("aba Direct mostra o aviso fixo e o interruptor atualiza", async () => {
    mocks.api.updateInstagramDm.mockResolvedValue(undefined);
    view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Direct" }));
    expect(await screen.findByText("Respostas enviadas pelo app do Instagram não pausam a IA. Para atender você mesmo, use Assumir em Conversas.")).toBeTruthy();
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    await waitFor(() => expect(mocks.api.updateInstagramDm).toHaveBeenCalledWith("u1", true));
  });

  it("interruptor desfaz o estado otimista quando a mutation falha", async () => {
    let reject: (e: Error) => void = () => {};
    mocks.api.updateInstagramDm.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    view();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Direct" }));
    const sw = await screen.findByRole("switch");
    await user.click(sw);
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    reject(new Error("falhou"));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
  });
});

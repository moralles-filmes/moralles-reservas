// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
afterEach(cleanup);

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
    mocks.api.connectStart.mockResolvedValue({ authorize_url: "https://www.instagram.com/oauth", state: "ST" });
    let storedAtRedirect: string | null = null;
    mocks.redirect.mockImplementation(() => {
      storedAtRedirect = sessionStorage.getItem(INSTAGRAM_OAUTH_STATE_KEY);
      return true;
    });
    view();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Conectar Instagram" }));
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalledWith("https://www.instagram.com/oauth"));
    expect(storedAtRedirect).toBe("ST");
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
    expect(await screen.findByRole("button", { name: "Reconectar Instagram" })).toBeTruthy();
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

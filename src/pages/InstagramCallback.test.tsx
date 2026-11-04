// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstagramCallback from "./InstagramCallback";
import { INSTAGRAM_OAUTH_STATE_KEY } from "@/features/instagram/oauth";
import { InstagramApiError } from "@/features/instagram/types";

const mocks = vi.hoisted(() => ({ connectCallback: vi.fn(), auth: { user: { id: "u" } as unknown, loading: false } }));
vi.mock("@/features/instagram/api", () => ({ connectCallback: mocks.connectCallback }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mocks.auth }));

let n = 0;
function open(query: string, stored: string | null, strict = false) {
  window.history.replaceState(null, "", `/instagram/callback${query}`);
  sessionStorage.clear();
  if (stored !== null) sessionStorage.setItem(INSTAGRAM_OAUTH_STATE_KEY, stored);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mk = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/instagram/callback"]}>
        <Routes>
          <Route path="/instagram/callback" element={<InstagramCallback />} />
          <Route path="/g/:slug/instagram" element={<p>pagina da loja</p>} />
          <Route path="/admin/login" element={<p>login</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const el = () => (strict ? <StrictMode>{mk()}</StrictMode> : mk());
  return { ...render(el()), el };
}
const code = () => `c${++n}`;
const ok = { unit_slug: "loja", username: "x", subscribed: true };

beforeEach(() => { mocks.connectCallback.mockReset(); mocks.auth.user = { id: "u" }; mocks.auth.loading = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("InstagramCallback", () => {
  it("limpa code/state da URL antes de chamar a EF", async () => {
    let seen = "?";
    mocks.connectCallback.mockImplementation(async () => { seen = window.location.search; return ok; });
    open(`?code=${code()}&state=S1`, "S1");
    await screen.findByText("pagina da loja");
    expect(mocks.connectCallback).toHaveBeenCalledTimes(1);
    expect(seen).toBe("");
  });

  it("state diferente do guardado: erro e não chama a EF", async () => {
    open(`?code=${code()}&state=OUTRO`, "S1");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(INSTAGRAM_OAUTH_STATE_KEY)).toBeNull();
  });

  it("sem state guardado: erro e não chama a EF", async () => {
    open(`?code=${code()}&state=S1`, null);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("apaga o state guardado antes de chamar a EF", async () => {
    let storedDuringCall: string | null = "?";
    mocks.connectCallback.mockImplementation(async () => { storedDuringCall = sessionStorage.getItem(INSTAGRAM_OAUTH_STATE_KEY); return ok; });
    open(`?code=${code()}&state=S1`, "S1");
    await screen.findByText("pagina da loja");
    expect(storedDuringCall).toBeNull();
  });

  it("em StrictMode chama a EF uma vez só", async () => {
    mocks.connectCallback.mockResolvedValue(ok);
    open(`?code=${code()}&state=S1`, "S1", true);
    await screen.findByText("pagina da loja");
    expect(mocks.connectCallback).toHaveBeenCalledTimes(1);
  });

  it("sem code na URL (reload): erro com link de volta e sem chamar a EF", async () => {
    open("", null);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Voltar ao Instagram" })).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("erro da EF mostra a mensagem do backend e o link de volta", async () => {
    mocks.connectCallback.mockRejectedValue(new InstagramApiError("Esta conta já está ligada a outra unidade.", 409));
    open(`?code=${code()}&state=S1`, "S1");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Esta conta já está ligada a outra unidade."));
    expect(screen.getByRole("link", { name: "Voltar ao Instagram" })).toBeTruthy();
  });

  it("error na URL (autorização negada): mensagem do Facebook e sem chamar a EF", async () => {
    open("?error=access_denied&error_reason=user_denied", null);
    expect((await screen.findByRole("alert")).textContent).toBe("A autorização no Facebook não foi concluída. Inicie a conexão de novo se quiser conectar.");
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("409 de várias Páginas mostra a mensagem do backend", async () => {
    mocks.connectCallback.mockRejectedValue(new InstagramApiError("Há mais de uma conta do Instagram ligada às suas Páginas.", 409));
    open(`?code=${code()}&state=S1`, "S1");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Há mais de uma conta do Instagram ligada às suas Páginas."));
  });

  it("sem usuário autenticado vai ao login sem chamar a EF", async () => {
    mocks.auth.user = null;
    open(`?code=${code()}&state=S1`, "S1");
    expect(await screen.findByText("login")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("novo objeto de usuário (TOKEN_REFRESHED) com a chamada pendente: 1 chamada e nenhum alerta", async () => {
    let resolve: (v: typeof ok) => void = () => {};
    mocks.connectCallback.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { rerender, el } = open(`?code=${code()}&state=S1`, "S1");
    await waitFor(() => expect(mocks.connectCallback).toHaveBeenCalledTimes(1));
    mocks.auth.user = { id: "u" };
    rerender(el());
    expect(mocks.connectCallback).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    resolve(ok);
    await screen.findByText("pagina da loja");
  });

  it("Error comum com texto técnico não aparece na tela", async () => {
    mocks.connectCallback.mockRejectedValue(new Error("TypeError: Failed to fetch at https://x.supabase.co"));
    open(`?code=${code()}&state=S1`, "S1");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/fetch|supabase/i);
    expect(alert.textContent).toMatch(/Não foi possível concluir/);
  });

  it("sessionStorage que lança ao ler: erro na tela e EF não chamada", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    open(`?code=${code()}&state=S1`, "S1");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("sessionStorage que lança ao apagar: erro na tela e EF não chamada", async () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    open(`?code=${code()}&state=S1`, "S1");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });

  it("preserva o history.state do router ao limpar a URL", async () => {
    mocks.connectCallback.mockResolvedValue(ok);
    window.history.replaceState({ idx: 3, key: "k" }, "", "/instagram/callback?code=zz1&state=S1");
    sessionStorage.setItem(INSTAGRAM_OAUTH_STATE_KEY, "S1");
    let stateDuring: unknown = null;
    mocks.connectCallback.mockImplementation(async () => { stateDuring = window.history.state; return ok; });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><Routes><Route path="*" element={<InstagramCallback />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mocks.connectCallback).toHaveBeenCalled());
    expect(stateDuring).toEqual({ idx: 3, key: "k" });
  });
});

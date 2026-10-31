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
  const tree = (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/instagram/callback"]}>
        <Routes>
          <Route path="/instagram/callback" element={<InstagramCallback />} />
          <Route path="/g/:slug/instagram" element={<p>pagina da loja</p>} />
          <Route path="/admin/login" element={<p>login</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}
const code = () => `c${++n}`;
const ok = { unit_slug: "loja", username: "x", subscribed: true };

beforeEach(() => { mocks.connectCallback.mockReset(); mocks.auth.user = { id: "u" }; mocks.auth.loading = false; });
afterEach(cleanup);

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

  it("sem usuário autenticado vai ao login sem chamar a EF", async () => {
    mocks.auth.user = null;
    open(`?code=${code()}&state=S1`, "S1");
    expect(await screen.findByText("login")).toBeTruthy();
    expect(mocks.connectCallback).not.toHaveBeenCalled();
  });
});

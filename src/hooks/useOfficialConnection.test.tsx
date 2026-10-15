// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOfficialConnection, officialPollingInterval, type OfficialConnectionState } from "./useOfficialConnection";
import type { ReactNode } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }));
const state: OfficialConnectionState = { step: "ready_to_connect", items: [], templatesPending: true, granted: true, onboardingState: null };
function setup(unitId = "u1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(({ unit }) => useOfficialConnection(unit), { initialProps: { unit: unitId }, wrapper }) };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("useOfficialConnection", () => {
  it("polling usa etapa e visibilidade", () => {
    expect(officialPollingInterval({ ...state, step: "connecting" }, true)).toBe(5000);
    expect(officialPollingInterval({ ...state, step: "awaiting_echo" }, true)).toBe(5000);
    expect(officialPollingInterval(state, true)).toBe(30000);
    expect(officialPollingInterval({ ...state, step: "connecting" }, false)).toBe(false);
  });
  it("navega diretamente e nunca retém capability no cache de query ou mutation", async () => {
    const url = "https://app.datafyapi.com.br/connect?token=ct_test_only";
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connect_start" ? { url } : state, error: null }));
    const hook = setup();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    const popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    let returned: unknown;
    await act(async () => { returned = await hook.result.current.start(popup, () => true); });
    expect(returned).toBeUndefined();
    expect(popup.location.href).toBe(url);
    expect(JSON.stringify(hook.client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(url);
    expect(hook.client.getMutationCache().getAll()).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith("manage-channels", { body: { action: "official_connect_start", unit_id: "u1" } });
    hook.client.clear();
  });
  it.each(["javascript:alert(1)", "https://evil.test/connect", "https://user:pass@app.datafyapi.com.br/connect", "http://app.datafyapi.com.br/connect"])("recusa endereço inseguro %s", async (url) => {
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connect_start" ? { url } : state }));
    const hook = setup();
    const popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    await expect(hook.result.current.start(popup, () => true)).rejects.toThrow("Não foi possível");
    expect(popup.location.href).toBe("about:blank");
    hook.client.clear();
  });
  it("state projeta apenas o contrato e não guarda campos extras", async () => {
    invoke.mockResolvedValue({ data: { ...state, url: "sensitive-extra-field", token: "private-extra-field" } });
    const hook = setup();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toEqual(state);
    hook.client.clear();
  });
  it("extrai non-2xx e mostra só copy de código conhecido", async () => {
    const json = vi.fn().mockResolvedValue({ code: "GRANT_REQUIRED", error: "provider-private-detail" });
    invoke.mockResolvedValue({ error: new FunctionsHttpError({ json }) });
    const hook = setup("");
    const popup = { close: vi.fn() } as unknown as Window;
    await expect(hook.result.current.start(popup, () => true)).rejects.toThrow("A conexão precisa de liberação");
    expect(json).toHaveBeenCalled();
    hook.client.clear();
  });
  it("mudança de visibilidade interrompe e retoma polling", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    invoke.mockResolvedValue({ data: state });
    const hook = setup();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    vi.useFakeTimers();
    act(() => { hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); });
    const initial = invoke.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(invoke).toHaveBeenCalledTimes(initial);
    act(() => { hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(invoke.mock.calls.length).toBeGreaterThan(initial);
    hook.client.clear();
  });
  it("resposta de start antiga fecha popup sem navegar ou confirmar", async () => {
    let resolve: (value: unknown) => void;
    invoke.mockImplementation((_name, { body }) => body.action === "official_connect_start" ? new Promise((r) => { resolve = r; }) : Promise.resolve({ data: state }));
    const hook = setup();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    const popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    let current = true;
    const request = hook.result.current.start(popup, () => current);
    current = false;
    hook.rerender({ unit: "u2" });
    await act(async () => { resolve({ data: { url: "https://example.test/private" } }); await request; });
    expect(popup.location.href).toBe("about:blank");
    expect(popup.close).toHaveBeenCalledOnce();
    hook.client.clear();
  });
  it("start next confirm fecha janela e retorna apenas marcador; confirm invalida ambas queries", async () => {
    invoke.mockImplementation((_name, { body }) => Promise.resolve({ data: body.action === "official_connect_start" ? { next: "confirm" } : state }));
    const hook = setup();
    const invalidate = vi.spyOn(hook.client, "invalidateQueries");
    const popup = { close: vi.fn() } as unknown as Window;
    await act(async () => {
      expect(await hook.result.current.start(popup, () => true)).toBe("confirm");
      await hook.result.current.confirm();
    });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["official-connection", "u1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-connection", "u1"] });
    hook.client.clear();
  });
});

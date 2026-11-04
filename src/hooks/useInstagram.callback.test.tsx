import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({ connectCallback: vi.fn(), disconnectInstagram: vi.fn() }));
vi.mock("@/features/instagram/api", () => ({
  connectCallback: mocks.connectCallback,
  connectStart: vi.fn(),
  disconnectInstagram: mocks.disconnectInstagram,
  readInstagramAccount: vi.fn(),
  readInstagramConnection: vi.fn(),
  readInstagramDiagnostics: vi.fn(),
  readInstagramSettings: vi.fn(),
  readUnitModules: vi.fn(),
  resubscribeInstagram: vi.fn(),
  setUnitModule: vi.fn(),
  updateInstagramDm: vi.fn(),
}));

import { useConnectInstagramCallback, useDisconnectInstagram } from "./useInstagram";

describe("useConnectInstagramCallback", () => {
  it("com sucesso invalida conta, configurações, conexão e módulo", async () => {
    mocks.connectCallback.mockResolvedValue({ unit_slug: "loja" });
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useConnectInstagramCallback(), { wrapper });
    result.current.mutate({ code: "c", state: "s" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining([
      "instagram-account", "instagram-settings", "instagram-connection", "instagram-module",
    ]));
  });

  it("desconectar invalida conta e conexão da unidade", async () => {
    mocks.disconnectInstagram.mockResolvedValue(undefined);
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDisconnectInstagram("u1"), { wrapper });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey);
    expect(keys).toEqual(expect.arrayContaining([
      ["instagram-account", "u1"], ["instagram-connection", "u1"],
    ]));
  });
});

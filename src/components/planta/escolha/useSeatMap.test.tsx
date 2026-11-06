// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSeatMap } from "./useSeatMap";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }));
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: false, reason: "choice_disabled" }, error: null });
});
afterEach(cleanup);
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}
it("envia parâmetros em snake_case e mantém negativa como dado", async () => {
  const { result } = renderHook(() => useSeatMap({ unitId: "u", hallId: "h", date: "2026-11-10", time: "19:00", partySize: 3 }), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invoke).toHaveBeenCalledWith("public-seat-map", { body: { unit_id: "u", hall_id: "h", date: "2026-11-10", time: "19:00", party_size: 3 } });
  expect(result.current.data).toEqual({ ok: false, reason: "choice_disabled" });
});
it("envia somente token", async () => {
  const { result } = renderHook(() => useSeatMap({ token: "link" }), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(invoke).toHaveBeenCalledWith("public-seat-map", { body: { token: "link" } });
});
it("não consulta sem input", () => {
  const { result } = renderHook(() => useSeatMap(null), { wrapper });
  expect(result.current.fetchStatus).toBe("idle");
  expect(invoke).not.toHaveBeenCalled();
});
it("propaga falha de invoke", async () => {
  const error = new Error("Indisponível");
  invoke.mockResolvedValue({ data: null, error });
  const { result } = renderHook(() => useSeatMap({ token: "link" }), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBe(error);
});

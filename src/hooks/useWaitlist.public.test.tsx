import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAddToWaitlist, useAnonAddToWaitlist } from "./useWaitlist";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: mocks.invoke }, rpc: mocks.rpc } }));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning, error: mocks.error, success: mocks.success } }));
afterEach(() => vi.clearAllMocks());

function wrapper() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const payload = { customer_name: "Ana Silva", customer_phone: "11987654321", party_size: 2, marketing_opt_in: true };

it("routes public form through the EF with explicit opt-in and preserves the code", async () => {
  mocks.invoke.mockResolvedValue({ data: { success: true, code: 42 }, error: null });
  const hook = renderHook(() => useAnonAddToWaitlist("unit-a"), { wrapper: wrapper() });
  let result!: Awaited<ReturnType<typeof hook.result.current.mutateAsync>>;
  await act(async () => { result = await hook.result.current.mutateAsync(payload); });
  expect(result).toEqual({ code: 42 });
  expect(mocks.invoke).toHaveBeenCalledWith("public-waitlist", { body: { unit_id: "unit-a", ...payload } });
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("does not turn a partial post-entry failure into a duplicate entry retry", async () => {
  mocks.invoke.mockResolvedValue({ data: { success: true, code: 42, warning: "consent_not_recorded" }, error: null });
  const hook = renderHook(() => useAnonAddToWaitlist("unit-a"), { wrapper: wrapper() });
  let result!: Awaited<ReturnType<typeof hook.result.current.mutateAsync>>;
  await act(async () => { result = await hook.result.current.mutateAsync(payload); });
  expect(result.code).toBe(42);
  expect(mocks.warning).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("treats an uncertain transport failure as potentially committed", async () => {
  mocks.invoke.mockRejectedValue(new Error("network timeout"));
  const hook = renderHook(() => useAnonAddToWaitlist("unit-a"), { wrapper: wrapper() });
  await expect(act(async () => { await hook.result.current.mutateAsync(payload); })).rejects.toThrow();
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Confira com o restaurante")));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("keeps the panel entry on its authenticated RPC", async () => {
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  const hook = renderHook(() => useAddToWaitlist("unit-a"), { wrapper: wrapper() });
  await act(async () => { await hook.result.current.mutateAsync({ customer_name: "Ana Silva", party_size: 2 }); });
  expect(mocks.rpc).toHaveBeenCalledWith("enter_waitlist", expect.objectContaining({ p_unit_id: "unit-a" }));
  expect(mocks.invoke).not.toHaveBeenCalled();
});

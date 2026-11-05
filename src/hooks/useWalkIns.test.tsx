// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => ({
  list: [] as Array<[string, ...unknown[]]>,
  result: { data: [] as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "in", "is", "range", "update", "delete"]) {
    builder[name] = (...args: unknown[]) => {
      calls.list.push([name, ...args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(calls.result);
  return { supabase: { from: () => builder } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));

import { useDeleteWalkIn, useUpdateWalkInStatus, useWalkIns } from "./useWalkIns";

const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const STALE = "Esse passante já foi atualizado em outro aparelho.";

beforeEach(() => {
  calls.list = [];
  calls.result = { data: [], error: null };
  toastError.mockClear();
  vi.restoreAllMocks();
});

describe("useWalkIns", () => {
  it("ativos: waiting/seated e só os ainda não liberados (released_at is null)", async () => {
    const { result } = renderHook(() => useWalkIns("u1", true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.list).toContainEqual(["in", "status", ["waiting", "seated"]]);
    expect(calls.list).toContainEqual(["is", "released_at", null]);
  });

  it("histórico (onlyActive=false) não filtra por released_at", async () => {
    const { result } = renderHook(() => useWalkIns("u1", false), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.list.some(([n]) => n === "is")).toBe(false);
  });
});

describe("useUpdateWalkInStatus / useDeleteWalkIn", () => {
  it("update filtra id, unit_id e status=waiting e pede select(id)", async () => {
    calls.result = { data: [{ id: "w1" }], error: null };
    const { result } = renderHook(() => useUpdateWalkInStatus("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ id: "w1", status: "no_show" }));
    expect(calls.list).toContainEqual(["eq", "id", "w1"]);
    expect(calls.list).toContainEqual(["eq", "unit_id", "u1"]);
    expect(calls.list).toContainEqual(["eq", "status", "waiting"]);
    expect(calls.list).toContainEqual(["select", "id"]);
  });

  it("zero linhas: erro com a mensagem e invalida em onSettled", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateWalkInStatus("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "w1", status: "seated" }).catch(() => undefined);
    });
    expect(toastError).toHaveBeenCalledWith(STALE);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["walk-ins", "u1"] });
  });

  it("delete filtra id e unit_id, pede select(id)", async () => {
    calls.result = { data: [{ id: "w1" }], error: null };
    const { result } = renderHook(() => useDeleteWalkIn("u1"), { wrapper });
    await act(() => result.current.mutateAsync("w1"));
    expect(calls.list).toContainEqual(["eq", "id", "w1"]);
    expect(calls.list).toContainEqual(["eq", "unit_id", "u1"]);
    expect(calls.list).toContainEqual(["select", "id"]);
  });

  it("delete com zero linhas: mensagem e invalidação", async () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useDeleteWalkIn("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("w1").catch(() => undefined);
    });
    expect(toastError).toHaveBeenCalledWith(STALE);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["walk-ins", "u1"] });
  });
});

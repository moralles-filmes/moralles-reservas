// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as Array<[string, ...unknown[]]> }));
vi.mock("@/lib/supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "in", "is"]) {
    builder[name] = (...args: unknown[]) => {
      calls.list.push([name, ...args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { supabase: { from: () => builder } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useWalkIns } from "./useWalkIns";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  calls.list = [];
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

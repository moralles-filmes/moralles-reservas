// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRelatorioPassantes } from "./useRelatorioPassantes";

const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const results: Record<string, { data: unknown; error: unknown }> = {};
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "order", "range"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      resolve(results[table] ?? { data: [], error: null });
    return builder;
  });
  return { calls, results, from };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

// 10 a 12/11 (3 dias) -> anterior 07 a 09/11.
const range = { from: new Date(2026, 10, 10), to: new Date(2026, 10, 12) };

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  mocks.calls.length = 0;
  for (const k of Object.keys(mocks.results)) delete mocks.results[k];
  vi.clearAllMocks();
});

describe("useRelatorioPassantes", () => {
  it("filtra unit_id em toda query e usa limites BRT dos dois períodos", async () => {
    const { result } = renderHook(() => useRelatorioPassantes("unit-a", range, null), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    for (const t of ["walk_ins", "tables", "halls"]) {
      expect(
        mocks.calls.some((c) => c.table === t && c.method === "eq" && c.args[0] === "unit_id" && c.args[1] === "unit-a"),
      ).toBe(true);
    }
    const walk = mocks.calls.filter((c) => c.table === "walk_ins");
    const gte = walk.filter((c) => c.method === "gte").map((c) => c.args[1]);
    const lt = walk.filter((c) => c.method === "lt").map((c) => c.args[1]);
    expect(gte).toContain("2026-11-10T00:00:00-03:00");
    expect(lt).toContain("2026-11-13T00:00:00-03:00");
    expect(gte).toContain("2026-11-07T00:00:00-03:00");
    expect(lt).toContain("2026-11-10T00:00:00-03:00");
    expect(result.current.error).toBeNull();
  });

  it("erro de leitura vira error", async () => {
    mocks.results.halls = { data: null, error: new Error("falha") };
    const { result } = renderHook(() => useRelatorioPassantes("unit-a", range, null), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
  });
});

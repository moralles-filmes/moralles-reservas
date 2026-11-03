// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSalaoBlocks,
  fetchSalaoPlan,
  fetchSalaoReservations,
  fetchSalaoSeatedWaitlist,
  fetchSalaoDurationSetting,
} from "@/features/planta/api";
import { parseDurationMinutes, useSalaoAoVivo } from "./useSalaoAoVivo";

const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const results: Record<string, { data: unknown; error: unknown }> = {};
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "not", "is", "gte", "lte", "gt", "lt", "order", "maybeSingle"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => resolve(results[table] ?? { data: [], error: null });
    return builder;
  });
  return { calls, results, from };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  mocks.calls.length = 0;
  for (const k of Object.keys(mocks.results)) delete mocks.results[k];
  vi.clearAllMocks();
});

const eqUnit = (table: string) =>
  mocks.calls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "unit_id" && c.args[1] === "unit-a");

describe("fetch* do salão ao vivo", () => {
  it("toda consulta filtra por unit_id", async () => {
    await fetchSalaoPlan("unit-a");
    await fetchSalaoReservations("unit-a", "2026-11-03", "2026-11-02");
    await fetchSalaoSeatedWaitlist("unit-a");
    await fetchSalaoBlocks("unit-a", "2026-11-03");
    await fetchSalaoDurationSetting("unit-a");
    for (const t of ["halls", "tables", "reservations", "waitlist", "table_blocks", "settings"]) {
      expect(eqUnit(t), t).toBe(true);
    }
  });

  it("o filtro de reservas contém hoje e ontem em BRT", async () => {
    await fetchSalaoReservations("unit-a", "2026-11-03", "2026-11-02");
    const or = mocks.calls.find((c) => c.table === "reservations" && c.method === "or")!;
    expect(String(or.args[0])).toContain("date.eq.2026-11-03");
    expect(String(or.args[0])).toContain("date.eq.2026-11-02");
    expect(String(or.args[0])).toContain("arrived_at.not.is.null");
    expect(String(or.args[0])).toContain("released_at.is.null");
  });

  it("bloqueios por sobreposição com o dia BRT", async () => {
    await fetchSalaoBlocks("unit-a", "2026-11-03");
    const gte = mocks.calls.find((c) => c.table === "table_blocks" && c.method === "gte")!;
    const lte = mocks.calls.find((c) => c.table === "table_blocks" && c.method === "lte")!;
    expect(gte.args).toEqual(["blocked_to", "2026-11-03T00:00:00-03:00"]);
    expect(lte.args).toEqual(["blocked_from", "2026-11-03T23:59:59-03:00"]);
  });

  it("o erro do PostgREST sobe como está", async () => {
    const err = { code: "42501", message: "x" };
    mocks.results.waitlist = { data: null, error: err };
    await expect(fetchSalaoSeatedWaitlist("unit-a")).rejects.toBe(err);
  });
});

describe("parseDurationMinutes", () => {
  it("aceita número, string e {minutes}; padrão 90", () => {
    expect(parseDurationMinutes("120")).toBe(120);
    expect(parseDurationMinutes(100)).toBe(100);
    expect(parseDurationMinutes({ minutes: 75 })).toBe(75);
    expect(parseDurationMinutes(undefined)).toBe(90);
    expect(parseDurationMinutes("abc")).toBe(90);
    expect(parseDurationMinutes(0)).toBe(90);
  });
});

describe("useSalaoAoVivo", () => {
  it("lê a duração e usa a key de reservas começando por [reservas, unitId]", async () => {
    mocks.results.settings = { data: { value: "120" }, error: null };
    const { result } = renderHook(() => useSalaoAoVivo("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.durationMinutes).toBe(120);
    expect(client.getQueryCache().findAll({ queryKey: ["reservas", "unit-a"] })).toHaveLength(1);
  });

  it("duração ausente → 90", async () => {
    mocks.results.settings = { data: null, error: null };
    const { result } = renderHook(() => useSalaoAoVivo("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.durationMinutes).toBe(90);
  });

  it("erro numa consulta → isError", async () => {
    mocks.results.table_blocks = { data: null, error: { message: "boom" } };
    const { result } = renderHook(() => useSalaoAoVivo("unit-a"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

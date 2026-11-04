// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeleteHall, useHall, useUpdateHall } from "./useHalls";
import { useDeleteTable, useHallTables, useUpdateTable } from "./useHallTables";
import { useDeleteHallSchedule, useHallSchedules, useUpdateHallSchedule } from "./useHallSchedules";
import {
  HALL_NOT_IN_UNIT_MESSAGE,
  LAYOUT_ROLE_MESSAGE,
  TABLE_NOT_IN_UNIT_MESSAGE,
  layoutErrorMessage,
} from "@/lib/layout-errors";

// Builder que registra a cadeia de cada `.from(tabela)` e resolve o resultado daquela tabela.
const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const results: Record<string, { data: unknown; error: unknown }> = {};
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "single", "maybeSingle", "update", "delete", "insert"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => resolve(results[table] ?? { data: null, error: null });
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  mocks.calls.length = 0;
  for (const k of Object.keys(mocks.results)) delete mocks.results[k];
  vi.clearAllMocks();
});

const callsOf = (table: string, method: string) =>
  mocks.calls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

describe("leitura presa à unidade", () => {
  it("useHall filtra id e unit_id, chave [hall, unitId, hallId], e devolve null para salão de outra unidade", async () => {
    mocks.results.halls = { data: null, error: null };
    const { result } = renderHook(() => useHall("unit-a", "h-b"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(callsOf("halls", "eq")).toEqual(expect.arrayContaining([["id", "h-b"], ["unit_id", "unit-a"]]));
    expect(client.getQueryCache().find({ queryKey: ["hall", "unit-a", "h-b"] })).toBeDefined();
  });

  it("useHallTables filtra unit_id e hall_id, chave [hall-tables, unitId, hallId, …]", async () => {
    mocks.results.tables = { data: [], error: null };
    const { result } = renderHook(() => useHallTables("unit-a", "h-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("tables", "eq")).toEqual(expect.arrayContaining([["unit_id", "unit-a"], ["hall_id", "h-1"]]));
    expect(client.getQueryCache().find({ queryKey: ["hall-tables", "unit-a", "h-1", "all"] })).toBeDefined();
  });

  it("useHallSchedules filtra pelo salão da unidade e tira o embed do resultado", async () => {
    mocks.results.hall_schedules = {
      data: [{ id: "s-1", hall_id: "h-1", halls: { unit_id: "unit-a" } }],
      error: null,
    };
    const { result } = renderHook(() => useHallSchedules("unit-a", "h-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [[cols]] = callsOf("hall_schedules", "select") as [[string]];
    expect(cols).toContain("halls!inner(unit_id)");
    expect(callsOf("hall_schedules", "eq")).toEqual(
      expect.arrayContaining([["hall_id", "h-1"], ["halls.unit_id", "unit-a"]]),
    );
    expect(result.current.data).toEqual([{ id: "s-1", hall_id: "h-1" }]);
    expect(client.getQueryCache().find({ queryKey: ["hall-schedules", "unit-a", "h-1"] })).toBeDefined();
  });

  it("sem unitId as consultas não rodam", () => {
    renderHook(() => useHall("", "h-1"), { wrapper });
    renderHook(() => useHallTables("", "h-1"), { wrapper });
    renderHook(() => useHallSchedules("", "h-1"), { wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("escrita por id com predicado de unidade e retorno conferido", () => {
  it("useUpdateHall filtra unit_id e recusa zero linhas", async () => {
    mocks.results.halls = { data: [], error: null };
    const { result } = renderHook(() => useUpdateHall("unit-a"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: "h-b", name: "X" })).rejects.toThrow(HALL_NOT_IN_UNIT_MESSAGE);
    });
    expect(callsOf("halls", "eq")).toEqual(expect.arrayContaining([["id", "h-b"], ["unit_id", "unit-a"]]));
  });

  it("useDeleteHall filtra unit_id, pede o id de volta e recusa zero linhas", async () => {
    mocks.results.halls = { data: [], error: null };
    const { result } = renderHook(() => useDeleteHall("unit-a"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("h-b")).rejects.toThrow(HALL_NOT_IN_UNIT_MESSAGE);
    });
    expect(callsOf("halls", "eq")).toEqual(expect.arrayContaining([["id", "h-b"], ["unit_id", "unit-a"]]));
    expect(callsOf("halls", "select")).toEqual([["id"]]);
  });

  it("useDeleteHall com uma linha passa", async () => {
    mocks.results.halls = { data: [{ id: "h-1" }], error: null };
    const { result } = renderHook(() => useDeleteHall("unit-a"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("h-1");
    });
  });

  it("useUpdateTable e useDeleteTable filtram unit_id e recusam zero linhas", async () => {
    mocks.results.tables = { data: [], error: null };
    const upd = renderHook(() => useUpdateTable(), { wrapper });
    await act(async () => {
      await expect(
        upd.result.current.mutateAsync({ id: "t-1", unit_id: "unit-a", active: false }),
      ).rejects.toThrow(TABLE_NOT_IN_UNIT_MESSAGE);
    });
    const del = renderHook(() => useDeleteTable(), { wrapper });
    await act(async () => {
      await expect(
        del.result.current.mutateAsync({ id: "t-1", unit_id: "unit-a", hall_id: "h-1" }),
      ).rejects.toThrow(TABLE_NOT_IN_UNIT_MESSAGE);
    });
    const eqs = callsOf("tables", "eq");
    expect(eqs.filter(([c]) => c === "unit_id")).toHaveLength(2);
  });

  it("useUpdateHallSchedule e useDeleteHallSchedule filtram hall_id e recusam zero linhas", async () => {
    mocks.results.hall_schedules = { data: [], error: null };
    const upd = renderHook(() => useUpdateHallSchedule("unit-a"), { wrapper });
    await act(async () => {
      await expect(
        upd.result.current.mutateAsync({ id: "s-1", hall_id: "h-1", slot_minutes: 30 }),
      ).rejects.toThrow(HALL_NOT_IN_UNIT_MESSAGE);
    });
    const del = renderHook(() => useDeleteHallSchedule("unit-a"), { wrapper });
    await act(async () => {
      await expect(del.result.current.mutateAsync({ id: "s-1", hall_id: "h-1" })).rejects.toThrow(
        HALL_NOT_IN_UNIT_MESSAGE,
      );
    });
    expect(callsOf("hall_schedules", "eq").filter(([c]) => c === "hall_id")).toHaveLength(2);
  });
});

describe("layoutErrorMessage", () => {
  it("42501 vira a mensagem de papel; o resto usa o fallback ou a mensagem própria do erro conhecido", () => {
    expect(layoutErrorMessage({ code: "42501", message: "layout_write_forbidden" }, "f")).toBe(LAYOUT_ROLE_MESSAGE);
    expect(LAYOUT_ROLE_MESSAGE).toBe("Só owner ou gerente podem alterar mesas e salões.");
    expect(layoutErrorMessage(new Error(HALL_NOT_IN_UNIT_MESSAGE), "f")).toBe(HALL_NOT_IN_UNIT_MESSAGE);
    expect(layoutErrorMessage({ code: "23505", message: "dup" }, "Erro ao salvar.")).toBe("Erro ao salvar.");
    expect(layoutErrorMessage(null, "Erro ao salvar.")).toBe("Erro ao salvar.");
  });
});

// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hallPlanErrorMessage, useHallPlanData, useSaveHallPlan } from "./useHallPlan";

// Builder que registra a cadeia de cada `.from(tabela)` e resolve o resultado daquela tabela.
const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const results: Record<string, { data: unknown; error: unknown }> = {
    halls: { data: null, error: null },
    tables: { data: [], error: null },
    table_combinations: { data: [], error: null },
  };
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "single", "maybeSingle"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => resolve(results[table]);
    return builder;
  });
  const rpc = vi.fn(async (_fn: string, _args: unknown) => ({ data: "2026-10-31T12:05:00.654321+00:00", error: null as unknown }));
  return { calls, results, from, rpc };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  mocks.calls.length = 0;
  mocks.results.halls = { data: null, error: null };
  mocks.results.tables = { data: [], error: null };
  mocks.results.table_combinations = { data: [], error: null };
  vi.clearAllMocks();
});

const callsOf = (table: string, method: string) =>
  mocks.calls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

const payload = {
  p_hall: { width_cm: 1200, depth_cm: 900, entrance_wall: null, entrance_offset_cm: null, window_walls: [] },
  p_tables: [{ id: "t-1", x: 100, y: 100, w: 80, h: 80, rotation: 0, shape: "square" as const }],
};

describe("useHallPlanData", () => {
  it("lê o salão e as mesas ativas só da unidade e do salão pedidos, com as colunas plan_*", async () => {
    const hall = { id: "h-1", unit_id: "unit-a", name: "Salão", updated_at: "2026-10-31T12:00:00.123456+00:00" };
    const tables = [{ id: "t-1", number: 1 }];
    mocks.results.halls = { data: hall, error: null };
    mocks.results.tables = { data: tables, error: null };
    mocks.results.table_combinations = {
      data: [{ id: "c-1", unit_id: "unit-a", hall_id: "h-1", min_capacity: 5, max_capacity: 8, active: true, table_combination_members: [{ table_id: "t-1" }, { table_id: "t-2" }] }],
      error: null,
    };
    const { result } = renderHook(() => useHallPlanData("unit-a", "h-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callsOf("halls", "eq")).toEqual(expect.arrayContaining([["id", "h-1"], ["unit_id", "unit-a"]]));
    expect(callsOf("tables", "eq")).toEqual(
      expect.arrayContaining([["unit_id", "unit-a"], ["hall_id", "h-1"], ["active", true]]),
    );
    const [[cols]] = callsOf("tables", "select") as [[string]];
    for (const c of ["plan_x", "plan_y", "plan_w", "plan_h", "plan_rotation", "plan_shape", "bookable"]) {
      expect(cols).toContain(c);
    }
    expect(callsOf("table_combinations", "eq")).toEqual(
      expect.arrayContaining([["unit_id", "unit-a"], ["hall_id", "h-1"], ["active", true]]),
    );
    expect(result.current.data).toEqual({
      hall,
      tables,
      combinations: [{ id: "c-1", unit_id: "unit-a", hall_id: "h-1", min_capacity: 5, max_capacity: 8, active: true, table_ids: ["t-1", "t-2"] }],
    });
  });

  it("erro de leitura vira isError", async () => {
    mocks.results.halls = { data: null, error: { code: "XX", message: "x" } };
    const { result } = renderHook(() => useHallPlanData("unit-a", "h-1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("sem unitId ou hallId não lê", () => {
    renderHook(() => useHallPlanData("", "h-1"), { wrapper });
    renderHook(() => useHallPlanData("unit-a", ""), { wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("useSaveHallPlan", () => {
  it("chama save_hall_plan com a revisão em string intacta e o payload sem mudança", async () => {
    const { result } = renderHook(() => useSaveHallPlan("unit-a", "h-1"), { wrapper });
    let saved: string | undefined;
    await act(async () => {
      saved = await result.current.mutateAsync({
        expectedUpdatedAt: "2026-10-31T12:00:00.123456+00:00",
        payload,
      });
    });
    expect(mocks.rpc).toHaveBeenCalledWith("save_hall_plan", {
      p_hall_id: "h-1",
      p_expected_updated_at: "2026-10-31T12:00:00.123456+00:00",
      p_hall: payload.p_hall,
      p_tables: payload.p_tables,
    });
    expect(saved).toBe("2026-10-31T12:05:00.654321+00:00");
  });

  it("sucesso invalida a planta, o salão, as mesas do salão e o salão ao vivo", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveHallPlan("unit-a", "h-1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ expectedUpdatedAt: "x", payload });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["hall-plan", "unit-a", "h-1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["hall", "unit-a", "h-1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["hall-tables", "unit-a", "h-1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["salao-ao-vivo", "unit-a"] });
  });

  it("erro da RPC rejeita a mutation e não invalida nada", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "40001", message: "hall_plan_stale" } });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveHallPlan("unit-a", "h-1"), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ expectedUpdatedAt: "x", payload })).rejects.toMatchObject({
        code: "40001",
      });
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hallPlanErrorMessage", () => {
  it("traduz conflito, permissão e o resto", () => {
    expect(hallPlanErrorMessage({ code: "40001" })).toBe(
      "A planta foi alterada por outra pessoa. Recarregue para ver a versão atual.",
    );
    expect(hallPlanErrorMessage({ code: "42501" })).toBe("Você não tem permissão para editar esta planta.");
    expect(hallPlanErrorMessage({ code: "42501", message: "combination_invalid" })).toBe(
      "Uma combinação tem mesa fora de reserva ou inativa. Revise as combinações.",
    );
    expect(hallPlanErrorMessage({ code: "22023" })).toBe("A planta tem dados inválidos. Recarregue e tente de novo.");
    expect(hallPlanErrorMessage(undefined)).toBe("Não foi possível salvar a planta. Tente de novo.");
    expect(hallPlanErrorMessage(new Error("rede"))).toBe("Não foi possível salvar a planta. Tente de novo.");
  });
});

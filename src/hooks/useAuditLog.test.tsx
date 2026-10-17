// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LOG_MEMBER_TABLES } from "@/lib/audit-log-tables";
import { useAuditLog } from "./useAuditLog";

// Builder que registra cada chamada da cadeia e resolve (thenable) com dados vazios.
const mocks = vi.hoisted(() => {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "or", "in", "eq", "order", "range"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return { calls, builder, from: vi.fn(() => builder) };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

afterEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();
});

const callsOf = (m: string) => mocks.calls.filter(([name]) => name === m).map(([, args]) => args);

describe("useAuditLog — o cliente só consulta as tabelas da policy de membro", () => {
  it("sempre aplica .in('table_name', tabelas do membro), sem filtro de tabela", async () => {
    const { result } = renderHook(() => useAuditLog("u1", "o1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.from).toHaveBeenCalledWith("audit_log");
    expect(callsOf("in")).toEqual([["table_name", ["customers", "reservations", "unit_members"]]]);
    expect(callsOf("in")[0][1]).toEqual([...AUDIT_LOG_MEMBER_TABLES]);
  });

  it("o filtro de tabela da tela entra como .eq ADICIONAL, sem trocar o .in", async () => {
    const { result } = renderHook(() => useAuditLog("u1", "o1", { table: "customers" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsOf("in")).toHaveLength(1);
    expect(callsOf("eq")).toContainEqual(["table_name", "customers"]);
  });
});

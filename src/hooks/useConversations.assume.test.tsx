// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationActions } from "./useConversations";

const db = vi.hoisted(() => {
  const calls: { update?: Record<string, unknown>; eq: Array<[string, unknown]>; select?: string } = { eq: [] };
  const state: { rows: Array<{ id: string }>; error: { message: string } | null } = { rows: [], error: null };
  const builder = {
    update: vi.fn((v: Record<string, unknown>) => { calls.update = v; return builder; }),
    eq: vi.fn((c: string, v: unknown) => { calls.eq.push([c, v]); return builder; }),
    select: vi.fn((c: string) => { calls.select = c; return Promise.resolve({ data: state.rows, error: state.error }); }),
  };
  return { calls, state, builder, from: vi.fn(() => builder) };
});
vi.mock("@/lib/supabase", () => ({ supabase: { from: db.from, channel: vi.fn(), removeChannel: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "operator" } }) }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useConversationActions("unit-1"), { wrapper });
}

beforeEach(() => {
  db.calls.update = undefined;
  db.calls.eq = [];
  db.calls.select = undefined;
  db.state.rows = [{ id: "conv-1" }];
  db.state.error = null;
  vi.clearAllMocks();
});

describe("assumeConversation", () => {
  it("starts the handoff clock and filters by conversation and unit", async () => {
    const before = Date.now();
    const { result } = setup();
    await act(async () => { await result.current.assumeConversation.mutateAsync("conv-1"); });
    expect(db.from).toHaveBeenCalledWith("conversations");
    expect(db.calls.update).toMatchObject({ status: "human_active", assigned_to: "operator" });
    const handoffAt = db.calls.update?.handoff_at as string;
    expect(typeof handoffAt).toBe("string");
    expect(Date.parse(handoffAt)).toBeGreaterThanOrEqual(before);
    expect(db.calls.eq).toEqual([["id", "conv-1"], ["unit_id", "unit-1"]]);
    expect(db.calls.select).toBe("id");
  });

  it("rejects when no row was updated", async () => {
    db.state.rows = [];
    const { result } = setup();
    await act(async () => {
      await expect(result.current.assumeConversation.mutateAsync("conv-1")).rejects.toThrow("Conversa não encontrada ou sem permissão.");
    });
  });

  it("propagates database errors", async () => {
    db.state.error = { message: "boom" };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.assumeConversation.mutateAsync("conv-1")).rejects.toMatchObject({ message: "boom" });
    });
  });
});

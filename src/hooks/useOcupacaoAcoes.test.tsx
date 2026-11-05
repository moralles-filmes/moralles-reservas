// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { seatActionErrorMessage, useSetOccupantTables, useSetOccupantPartySize } from "./useOcupacaoAcoes";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("ocupação", () => {
  it.each([
    ["seat_taken", "Essa mesa acabou"],
    ["seat_blocked", "Essa mesa está"],
    ["seat_action_invalid", "Essa ocupação"],
    ["unknown", "Não foi possível"],
  ])("traduz %s", (message, expected) => {
    expect(seatActionErrorMessage({ message })).toContain(expected);
  });

  it("traduz permissão", () => {
    expect(seatActionErrorMessage({ code: "42501" })).toBe("Sem permissão para esta mesa.");
  });

  it("envia allowOverlap e invalida os quatro prefixos mesmo em erro", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "seat_taken" } });
    const { result } = renderHook(() => useSetOccupantTables("u"), { wrapper });
    result.current.mutate({ occupant: { kind: "walk_in", id: "w" }, tableIds: ["a", "b"], allowOverlap: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpc).toHaveBeenCalledWith("set_occupant_tables", {
      p_kind: "walk_in",
      p_id: "w",
      p_table_ids: ["a", "b"],
      p_allow_overlap: true,
    });
    for (const key of ["reservas", "walk-ins", "waitlist", "occupant-tables"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, "u"] });
    }
  });

  it("preserva false de ajuste sem mudança", async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    rpc.mockResolvedValue({ data: false, error: null });
    const { result } = renderHook(() => useSetOccupantPartySize("u"), { wrapper });
    result.current.mutate({ occupant: { kind: "waitlist", id: "w" }, partySize: 4 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(false);
  });
});

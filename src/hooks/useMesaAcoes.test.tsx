// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  insert: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mocks.rpc, from: vi.fn(() => ({ insert: mocks.insert })) },
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

import {
  presenceErrorMessage,
  useReleaseWaitlistEntry,
  useReleaseWalkIn,
  useReservationPresence,
  useSeatWaitlistEntry,
} from "./useMesaAcoes";
import { useCreateWalkIn } from "./useWalkIns";

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.insert.mockResolvedValue({ error: null });
});

describe("useReservationPresence", () => {
  it("arrive chama a RPC, invalida reservas e oferece Desfazer", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReservationPresence("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ reservationId: "r1", action: "arrive" }));
    expect(mocks.rpc).toHaveBeenCalledWith("set_reservation_presence", { p_reservation_id: "r1", p_action: "arrive" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reservas", "u1"] });
    const [msg, opts] = mocks.success.mock.calls[0];
    expect(msg).toBe("Chegada marcada.");
    expect(opts.action.label).toBe("Desfazer");
    opts.action.onClick();
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenLastCalledWith("set_reservation_presence", { p_reservation_id: "r1", p_action: "undo_arrive" }),
    );
  });

  it("undo_arrive e release têm toasts próprios", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useReservationPresence("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ reservationId: "r1", action: "undo_arrive" }));
    expect(mocks.success).toHaveBeenLastCalledWith("Chegada desfeita.");
    await act(() => result.current.mutateAsync({ reservationId: "r1", action: "release" }));
    expect(mocks.success).toHaveBeenLastCalledWith("Mesa liberada.");
  });

  it("erro vira toast mapeado", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23514", details: "presence_final" } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useReservationPresence("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ reservationId: "r1", action: "release" }).catch(() => undefined);
    });
    expect(mocks.error).toHaveBeenCalledWith("Esta mesa já foi liberada.");
  });
});

describe("fila e passante", () => {
  it("seat_waitlist_entry", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSeatWaitlistEntry("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ waitlistId: "w1", tableId: "t1", tableNumber: 7 }));
    expect(mocks.rpc).toHaveBeenCalledWith("seat_waitlist_entry", { p_waitlist_id: "w1", p_table_id: "t1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["waitlist", "u1"] });
    expect(mocks.success).toHaveBeenCalledWith("Cliente sentado na mesa 7.");
  });

  it("release_waitlist_entry", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReleaseWaitlistEntry("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ waitlistId: "w1" }));
    expect(mocks.rpc).toHaveBeenCalledWith("release_waitlist_entry", { p_waitlist_id: "w1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["waitlist", "u1"] });
    expect(mocks.success).toHaveBeenCalledWith("Mesa liberada.");
  });

  it("release_walk_in", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReleaseWalkIn("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ walkInId: "p1" }));
    expect(mocks.rpc).toHaveBeenCalledWith("release_walk_in", { p_walk_in_id: "p1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["walk-ins", "u1"] });
    expect(mocks.success).toHaveBeenCalledWith("Mesa liberada.");
  });
});

describe("invalidação também em erro (dois tablets disputando)", () => {
  const rpcError = { code: "23514", details: "not_seatable" };
  beforeEach(() => mocks.rpc.mockResolvedValue({ data: null, error: rpcError }));

  it("useReservationPresence", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReservationPresence("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ reservationId: "r1", action: "arrive" }).catch(() => undefined);
    });
    expect(mocks.error).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reservas", "u1"] });
  });

  it("useSeatWaitlistEntry", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSeatWaitlistEntry("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ waitlistId: "w1", tableId: "t1" }).catch(() => undefined);
    });
    expect(mocks.error).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["waitlist", "u1"] });
  });

  it("useReleaseWaitlistEntry", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReleaseWaitlistEntry("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ waitlistId: "w1" }).catch(() => undefined);
    });
    expect(mocks.error).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["waitlist", "u1"] });
  });

  it("useReleaseWalkIn", async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useReleaseWalkIn("u1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ walkInId: "p1" }).catch(() => undefined);
    });
    expect(mocks.error).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["walk-ins", "u1"] });
  });
});

describe("presenceErrorMessage", () => {
  it.each([
    [{ code: "42501" }, "Sem permissão para esta mesa."],
    [{ code: "23514", details: "arrival_not_allowed" }, "Só dá para marcar chegada de reserva pendente ou confirmada de hoje."],
    [{ code: "23514", details: "release_requires_arrival" }, "Marque a chegada antes de liberar a mesa."],
    [{ code: "23514", details: "presence_final" }, "Esta mesa já foi liberada."],
    [{ code: "23514", details: "not_seatable" }, "Este cliente não está mais aguardando na fila."],
    [{ code: "23514", details: "not_seated" }, "Este cliente não está sentado."],
    [{ code: "23514", details: "born_with_presence" }, "Não foi possível atualizar a mesa. Recarregue a tela."],
    [new Error("x"), "Não foi possível atualizar a mesa. Recarregue a tela."],
    [null, "Não foi possível atualizar a mesa. Recarregue a tela."],
  ])("%j", (err, msg) => {
    expect(presenceErrorMessage(err)).toBe(msg);
  });
});

describe("useCreateWalkIn", () => {
  it("seated grava status, seated_at e table_id numa linha só", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateWalkIn("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ customer_name: "Zé", party_size: 2, table_id: "t1", seated: true }));
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const row = mocks.insert.mock.calls[0][0];
    expect(row).toMatchObject({ unit_id: "u1", customer_name: "Zé", party_size: 2, status: "seated", table_id: "t1" });
    expect(typeof row.seated_at).toBe("string");
    expect(row).not.toHaveProperty("seated");
  });

  it("sem seated mantém o insert antigo", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateWalkIn("u1"), { wrapper });
    await act(() => result.current.mutateAsync({ customer_name: "Zé", party_size: 2 }));
    expect(mocks.insert.mock.calls[0][0]).toEqual({ unit_id: "u1", customer_name: "Zé", party_size: 2 });
  });
});

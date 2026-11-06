// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { CreateReservaError, useCreateReserva, type CreateReservaParams } from "./useReservas";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }));
const params: CreateReservaParams = {
  unit_id: "unit", organization_id: "org", name: "Ana Silva", phone: "11999998888",
  email: "ana@example.com", date: "2026-11-20", time: "19:00", party_size: 2,
  seat: { kind: "table", id: "table-12" },
};
beforeEach(() => invoke.mockReset());
function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(() => useCreateReserva(), { wrapper }), invalidate };
}
it("envia a mesa, preserva a reason na recusa e invalida o mapa", async () => {
  invoke.mockResolvedValue({ data: { success: false, reason: "seat_unavailable" }, error: null });
  const { result, invalidate } = setup();
  await act(async () => {
    await expect(result.current.mutateAsync(params)).rejects.toMatchObject({
      name: "CreateReservaError", reason: "seat_unavailable",
    });
  });
  expect(invoke).toHaveBeenCalledWith("create-reservation", expect.objectContaining({ body: expect.objectContaining({ seat: params.seat }) }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["seat-map"] });
});
it("preserva a reason do corpo de erro não 2xx mesmo com a mesma mensagem", async () => {
  invoke.mockResolvedValue({ data: null, error: { message: "Disabled", context: { body: JSON.stringify({ reason: "seat_choice_disabled", message: "Disabled" }) } } });
  const { result } = setup();
  await act(async () => {
    await expect(result.current.mutateAsync({ ...params, seat: undefined })).rejects.toBeInstanceOf(CreateReservaError);
  });
  await waitFor(() => expect(result.current.error).toMatchObject({ reason: "seat_choice_disabled", message: "Disabled" }));
  expect(invoke).toHaveBeenCalledWith("create-reservation", expect.objectContaining({ body: expect.objectContaining({ seat: null }) }));
});

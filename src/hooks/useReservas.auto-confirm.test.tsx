// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateManualReserva, useCreateReserva } from "./useReservas";

const invoke = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

const input = {
  unit_id: "unit-1", organization_id: "org-1", name: "Ana Silva", phone: "11999998888",
  email: "ana@example.com", date: "2026-10-20", time: "19:00", party_size: 2,
};
const customer = { id: "customer-1", name: input.name, phone: input.phone, email: input.email };
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}
beforeEach(() => invoke.mockReset());

it("accepts only a persisted confirmed reservation without payment", async () => {
  invoke.mockResolvedValue({ data: { success: true, reservation_id: "reservation-1", reservation_code: "ABC123",
    reservation_status: "confirmed", requires_payment: false,
    payment_amount_cents: null, customer }, error: null });
  const { result } = renderHook(() => useCreateReserva(), { wrapper });
  const reservation = await result.current.mutateAsync(input);
  expect(reservation.status).toBe("confirmed");
  expect(reservation.payment_status).toBe("not_required");
  expect(invoke.mock.calls).toHaveLength(1);
});

it.each([
  { reservation_status: undefined, requires_payment: false },
  { reservation_status: "pending", requires_payment: false },
  { reservation_status: "confirmed", requires_payment: true },
  { reservation_status: "pending", requires_payment: true },
  { reservation_status: "confirmed", requires_payment: false, payment_amount_cents: 5000 },
])("rejects an ambiguous or contradictory successful response: %j", async fields => {
  invoke.mockResolvedValue({ data: { success: true, reservation_id: "reservation-1",
    reservation_code: "ABC123", customer, ...fields }, error: null });
  const { result } = renderHook(() => useCreateReserva(), { wrapper });
  await expect(result.current.mutateAsync(input)).rejects.toThrow("Não foi possível confirmar o estado da reserva");
  expect(invoke.mock.calls).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith("create-checkout-session", expect.anything());
});

it("creates manual reservations confirmed without sending a pending choice", async () => {
  invoke.mockResolvedValue({ data: { success: true, reservation_id: "reservation-1", reservation_code: "ABC123",
    reservation_status: "confirmed", customer }, error: null });
  const { result } = renderHook(() => useCreateManualReserva(input.unit_id), { wrapper });
  const response = await result.current.mutateAsync({ ...input, source: "web", notify: false, override: false });
  expect(response.reservation_status).toBe("confirmed");
  expect(invoke).toHaveBeenCalledWith("create-manual-reservation", {
    body: expect.not.objectContaining({ status: "pending" }),
  });
  expect(invoke.mock.calls[0][1].body).not.toHaveProperty("status");
});

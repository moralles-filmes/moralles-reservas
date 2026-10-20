import { beforeEach, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateReserva } from "./useReservas";

const invoke = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

const input = {
  unit_id: "unit-1", organization_id: "org-1", name: "Ana Silva",
  phone: "11999998888", email: "ana@example.com", date: "2026-10-20",
  time: "19:00", party_size: 2,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    data: {
      success: true, reservation_id: "reservation-1", reservation_code: "ABC123",
      reservation_status: "confirmed", requires_payment: false,
      customer: { id: "customer-1", name: input.name, phone: input.phone, email: input.email },
    },
    error: null,
  });
});

it.each([false, true])("encaminha marketing_opt_in=%s como booleano literal à Edge Function", async (marketingOptIn) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useCreateReserva(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  result.current.mutate({ ...input, marketing_opt_in: marketingOptIn });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create-reservation", {
    body: expect.objectContaining({ marketing_opt_in: marketingOptIn }),
  }));
});

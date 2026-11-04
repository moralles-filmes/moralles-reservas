// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservaCard } from "./ReservaCard";
import type { Reserva } from "@/types/reserva";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/hooks/useReservas", () => ({
  useUpdateReservaStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useMesaAcoes", () => ({
  useReservationPresence: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: "u1", isGerente: false }),
}));
vi.mock("@/hooks/useReservationDuration", () => ({ useReservationDuration: () => 90 }));

function reserva(over: Partial<Reserva> = {}): Reserva {
  return {
    id: "r1",
    unit_id: "u1",
    date: "2026-10-30",
    time: "19:00:00",
    party_size: 2,
    status: "confirmed",
    notes: null,
    reservation_code: "ABC123",
    customer: { name: "Ana" },
    arrived_at: null,
    released_at: null,
    ...over,
  } as unknown as Reserva;
}

describe("ReservaCard situação ao vivo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T22:12:00Z")); // 19:12 BRT
  });
  afterEach(() => vi.useRealTimers());

  it("confirmada às 19:00 com agora 19:12 mostra Confirmada e Atrasada 12 min", () => {
    render(<ReservaCard reserva={reserva()} />);
    expect(screen.getByText("Confirmada")).toBeInTheDocument();
    expect(screen.getByText("Atrasada 12 min")).toBeInTheDocument();
  });

  it("cancelada mostra só o status gravado", () => {
    render(<ReservaCard reserva={reserva({ status: "cancelled" })} />);
    expect(screen.getByText("Cancelada")).toBeInTheDocument();
    expect(screen.queryByText(/Atrasada/)).not.toBeInTheDocument();
  });
});

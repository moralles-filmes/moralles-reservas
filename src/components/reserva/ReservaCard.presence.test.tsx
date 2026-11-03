// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReservaCard } from "./ReservaCard";
import { brtNow } from "@/lib/table-situation-core";
import type { Reserva } from "@/types/reserva";

const mock = vi.hoisted(() => ({ presence: vi.fn(), isGerente: false }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/hooks/useReservas", () => ({
  useUpdateReservaStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useMesaAcoes", () => ({
  useReservationPresence: () => ({ mutate: mock.presence, isPending: false }),
}));
vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: "u1", isGerente: mock.isGerente }),
}));

const today = brtNow(new Date()).date;
const tomorrow = brtNow(new Date()).tomorrow;

function reserva(over: Partial<Reserva> = {}): Reserva {
  return {
    id: "r1",
    unit_id: "u1",
    date: today,
    time: "20:00:00",
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

beforeEach(() => {
  mock.presence.mockReset();
  mock.isGerente = false;
});

describe("ReservaCard presença", () => {
  it("confirmada de hoje sem chegada mostra Chegou e não Liberar mesa", () => {
    render(<ReservaCard reserva={reserva()} showActions />);
    expect(screen.getByRole("button", { name: "Chegou" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Liberar mesa" })).not.toBeInTheDocument();
  });

  it("Chegou chama arrive", () => {
    render(<ReservaCard reserva={reserva({ status: "pending" })} showActions />);
    screen.getByRole("button", { name: "Chegou" }).click();
    expect(mock.presence).toHaveBeenCalledWith({ reservationId: "r1", action: "arrive" });
  });

  it("com chegada mostra Liberar mesa e Desfazer chegada", () => {
    render(<ReservaCard reserva={reserva({ arrived_at: "2026-11-03T22:00:00Z" })} showActions />);
    expect(screen.queryByRole("button", { name: "Chegou" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Liberar mesa" }).click();
    expect(mock.presence).toHaveBeenCalledWith({ reservationId: "r1", action: "release" });
    screen.getByRole("button", { name: "Desfazer chegada" }).click();
    expect(mock.presence).toHaveBeenCalledWith({ reservationId: "r1", action: "undo_arrive" });
  });

  it("liberada não mostra nenhum botão de presença", () => {
    render(
      <ReservaCard
        reserva={reserva({ arrived_at: "2026-11-03T22:00:00Z", released_at: "2026-11-03T23:00:00Z" })}
        showActions
      />,
    );
    expect(screen.queryByRole("button", { name: "Liberar mesa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desfazer chegada" })).not.toBeInTheDocument();
  });

  it("chegada antiga (3 dias) sem liberação não mostra Liberar mesa nem Desfazer chegada; ontem mostra", () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    const threeDaysAgo = brtNow(old).date;
    const { unmount } = render(
      <ReservaCard reserva={reserva({ date: threeDaysAgo, arrived_at: "2026-10-30T22:00:00Z" })} showActions />,
    );
    expect(screen.queryByRole("button", { name: "Liberar mesa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desfazer chegada" })).not.toBeInTheDocument();
    unmount();
    render(
      <ReservaCard
        reserva={reserva({ date: brtNow(new Date()).yesterday, arrived_at: "2026-11-02T22:00:00Z" })}
        showActions
      />,
    );
    expect(screen.getByRole("button", { name: "Liberar mesa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desfazer chegada" })).toBeInTheDocument();
  });

  it("reserva de amanhã não mostra Chegou", () => {
    render(<ReservaCard reserva={reserva({ date: tomorrow })} showActions />);
    expect(screen.queryByRole("button", { name: "Chegou" })).not.toBeInTheDocument();
  });

  it("sem showActions não mostra botões", () => {
    render(<ReservaCard reserva={reserva()} />);
    expect(screen.queryByRole("button", { name: "Chegou" })).not.toBeInTheDocument();
  });

  it("operador também vê os três botões e continua sem Cancelar", () => {
    mock.isGerente = false;
    const { rerender } = render(<ReservaCard reserva={reserva()} showActions />);
    expect(screen.getByRole("button", { name: "Chegou" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    rerender(<ReservaCard reserva={reserva({ arrived_at: "2026-11-03T22:00:00Z" })} showActions />);
    expect(screen.getByRole("button", { name: "Liberar mesa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desfazer chegada" })).toBeInTheDocument();
  });
});

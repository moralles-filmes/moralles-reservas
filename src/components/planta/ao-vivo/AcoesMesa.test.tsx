// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mesa, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";
import type { TableState } from "@/lib/table-situation-core";

const m = vi.hoisted(() => {
  const mk = () => ({ mutate: vi.fn(), isPending: false, variables: undefined as unknown });
  return { presence: mk(), seat: mk(), relEntry: mk(), relWalk: mk(), create: mk(), update: mk() };
});

vi.mock("@/hooks/useMesaAcoes", () => ({
  useReservationPresence: () => m.presence,
  useSeatWaitlistEntry: () => m.seat,
  useReleaseWaitlistEntry: () => m.relEntry,
  useReleaseWalkIn: () => m.relWalk,
}));
vi.mock("@/hooks/useWalkIns", () => ({
  useCreateWalkIn: () => m.create,
  useUpdateWalkInStatus: () => m.update,
}));

import { AcoesMesa } from "./AcoesMesa";

const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT
const table = { id: "t1", number: 7, capacity: 2, max_capacity: 4, hall_id: "h1" } as unknown as Mesa;
const res = { id: "r1", customer_id: "c1" } as unknown as Reserva;
const entry = (id: string, priority: number, party = 2, customer_id: string | null = null) =>
  ({
    id,
    priority,
    party_size: party,
    customer_id,
    customer_name: `N-${id}`,
    status: "waiting",
    created_at: "2026-11-03T17:00:00Z",
  }) as unknown as WaitlistEntry;

function setup(state: TableState, extra: Partial<Parameters<typeof AcoesMesa>[0]> = {}) {
  render(
    <MemoryRouter>
      <AcoesMesa
        unitId="u1"
        basePath="/o/loja"
        table={table}
        state={state}
        now={NOW}
        reservations={[res]}
        waitlistSeated={[]}
        waitlistActive={[]}
        waitingWalkIns={[]}
        blocks={[]}
        {...extra}
      />
    </MemoryRouter>,
  );
}
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);
const links = () => screen.queryAllByRole("link").map((l) => l.textContent);

beforeEach(() => {
  for (const v of Object.values(m)) {
    v.mutate.mockClear();
    v.isPending = false;
    v.variables = undefined;
  }
});

describe("AcoesMesa", () => {
  it.each(["arriving", "late", "reserved"] as const)("%s: marcar chegada + conversa", (situation) => {
    setup({ situation, focusReservationId: "r1" });
    expect(names()).toEqual(["Marcar chegada"]);
    expect(links()).toEqual(["Abrir conversa"]);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/o/loja/conversas?cliente=c1");
    fireEvent.click(screen.getByRole("button", { name: "Marcar chegada" }));
    expect(m.presence.mutate).toHaveBeenCalledWith({ reservationId: "r1", action: "arrive" });
  });

  it("reservada sem customer_id não mostra conversa", () => {
    setup({ situation: "reserved", focusReservationId: "r1" }, { reservations: [{ id: "r1" } as unknown as Reserva] });
    expect(links()).toEqual([]);
  });

  it("ocupada por reserva", () => {
    setup({ situation: "occupied", occupant: { kind: "reservation", id: "r1", since: "x", partySize: 2 } });
    expect(names()).toEqual(["Liberar mesa", "Desfazer chegada"]);
    expect(links()).toEqual(["Abrir conversa"]);
    fireEvent.click(screen.getByRole("button", { name: "Liberar mesa" }));
    expect(m.presence.mutate).toHaveBeenCalledWith({ reservationId: "r1", action: "release" });
    fireEvent.click(screen.getByRole("button", { name: "Desfazer chegada" }));
    expect(m.presence.mutate).toHaveBeenCalledWith({ reservationId: "r1", action: "undo_arrive" });
  });

  it("ocupada por fila: conversa só com customer_id", () => {
    const occupant = { kind: "waitlist" as const, id: "w1", since: "x", partySize: 2 };
    setup({ situation: "occupied", occupant }, { waitlistSeated: [entry("w1", 1, 2, "c9")] });
    expect(names()).toEqual(["Liberar mesa"]);
    expect(links()).toEqual(["Abrir conversa"]);
    fireEvent.click(screen.getByRole("button", { name: "Liberar mesa" }));
    expect(m.relEntry.mutate).toHaveBeenCalledWith({ waitlistId: "w1" });
  });

  it("ocupada por fila sem customer_id", () => {
    const occupant = { kind: "waitlist" as const, id: "w1", since: "x", partySize: 2 };
    setup({ situation: "occupied", occupant }, { waitlistSeated: [entry("w1", 1)] });
    expect(links()).toEqual([]);
  });

  it("ocupada por passante: só liberar", () => {
    setup({ situation: "occupied", occupant: { kind: "walk_in", id: "p1", since: "x", partySize: 2 } });
    expect(names()).toEqual(["Liberar mesa"]);
    expect(links()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Liberar mesa" }));
    expect(m.relWalk.mutate).toHaveBeenCalledWith({ walkInId: "p1" });
  });

  it("botão desabilitado só para o id em andamento", () => {
    m.presence.isPending = true;
    m.presence.variables = { reservationId: "r1", action: "release" };
    setup({ situation: "occupied", occupant: { kind: "reservation", id: "r1", since: "x", partySize: 2 } });
    expect(screen.getByRole("button", { name: "Liberar mesa" })).toBeDisabled();
  });

  it("livre: sentar da fila com a mesa selecionada, prioridade primeiro e aviso de capacidade", () => {
    setup({ situation: "free" }, { waitlistActive: [entry("b", 5, 2), entry("a", 1, 6)] });
    const seatBtns = screen.getAllByRole("button", { name: /^Sentar da fila N-/ });
    expect(seatBtns.map((b) => b.getAttribute("aria-label"))).toEqual(["Sentar da fila N-a", "Sentar da fila N-b"]);
    expect(screen.getByText(/passa da capacidade da mesa \(4\)/)).toBeInTheDocument();
    fireEvent.click(seatBtns[1]);
    expect(m.seat.mutate).toHaveBeenCalledWith({ waitlistId: "b", tableId: "t1", tableNumber: 7 });
  });

  it("livre: entrada de dia anterior não aparece em Sentar da fila", () => {
    const velha = { ...entry("velha", 0), created_at: "2026-10-20T15:00:00Z" } as WaitlistEntry;
    setup({ situation: "free" }, { waitlistActive: [velha, entry("a", 1)] });
    const seatBtns = screen.getAllByRole("button", { name: /^Sentar da fila N-/ });
    expect(seatBtns.map((b) => b.getAttribute("aria-label"))).toEqual(["Sentar da fila N-a"]);
  });

  it("sem basePath (slug ausente) não mostra Abrir conversa", () => {
    setup({ situation: "reserved", focusReservationId: "r1" }, { basePath: undefined });
    expect(links()).toEqual([]);
  });

  it("livre: sentar passante existente em espera", () => {
    const w = { id: "p1", customer_name: "Ze", party_size: 3, status: "waiting" } as unknown as WalkIn;
    setup({ situation: "free" }, { waitingWalkIns: [w] });
    fireEvent.click(screen.getByRole("button", { name: "Sentar passante Ze" }));
    expect(m.update.mutate).toHaveBeenCalledWith({ id: "p1", status: "seated", table_id: "t1" });
  });

  it("livre: passante novo cria sentado na mesa", () => {
    setup({ situation: "free" });
    const submit = screen.getByRole("button", { name: "Sentar novo passante" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome do passante"), { target: { value: " Ana " } });
    fireEvent.change(screen.getByLabelText("Pessoas"), { target: { value: "3" } });
    fireEvent.click(submit);
    expect(m.create.mutate).toHaveBeenCalledWith(
      { customer_name: "Ana", party_size: 3, table_id: "t1", seated: true },
      expect.anything(),
    );
  });

  it("bloqueada: nenhum botão, texto com o fim do bloqueio", () => {
    setup(
      { situation: "blocked" },
      {
        blocks: [
          { table_id: "t1", hall_id: null, blocked_from: "2026-11-03T15:00:00Z", blocked_to: "2026-11-03T20:30:00Z" },
        ],
      },
    );
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByText("Mesa bloqueada até 17:30")).toBeInTheDocument();
  });
});

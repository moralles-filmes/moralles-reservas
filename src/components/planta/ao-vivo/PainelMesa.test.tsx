// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Mesa, ReservaComCliente } from "@/types/reserva";
import type { TableState } from "@/lib/table-situation-core";
import { PainelMesa } from "./PainelMesa";

const now = new Date("2026-11-05T19:50:00-03:00");
const table = (id: string, number: number): Mesa => ({
  id, number, unit_id: "u1", hall_id: "h1", capacity: 4, min_capacity: 1,
  max_capacity: 4, location: "internal", active: true,
});
const table1 = table("t1", 3);
const table2 = table("t2", 4);

function reserva(id: string, overrides: Partial<ReservaComCliente> = {}): ReservaComCliente {
  return {
    id, unit_id: "u1", customer_id: `c-${id}`, table_id: "t1", date: "2026-11-05",
    time: "20:00:00", party_size: 2, status: "confirmed", notes: null,
    reservation_code: id.toUpperCase(), created_at: "2026-11-01T12:00:00Z",
    updated_at: "2026-11-01T12:00:00Z", customer: { name: `Cliente ${id}` }, ...overrides,
  };
}

const renderPanel = (options: {
  state: TableState;
  reservations?: ReservaComCliente[];
  occupantTables?: Array<{ table_id: string; reservation_id: string | null; walk_in_id: string | null; waitlist_id: string | null; overlap_ok: boolean }>;
  states?: Map<string, TableState>;
  tables?: Mesa[];
  }) => render(
  <PainelMesa
    table={table1}
    state={options.state}
    reservations={options.reservations ?? []}
    walkIns={[]}
    waitlistSeated={[]}
    now={now}
    durationMinutes={120}
    occupantTables={options.occupantTables}
    states={options.states}
    tables={options.tables ?? [table1, table2]}
  />,
);

describe("PainelMesa", () => {
  it("usa ReservaDetalhe para a reserva em foco", () => {
    const focused = reserva("foco", { time: "19:55:00", source: "instagram" });
    renderPanel({ state: { situation: "arriving", focusReservationId: focused.id }, reservations: [focused] });
    expect(screen.getByTestId("reserva-detalhe")).toBeTruthy();
    expect(screen.getByText("Cliente foco")).toBeTruthy();
    expect(screen.getByText("Instagram")).toBeTruthy();
    expect(screen.queryByText("2 pessoas às 19:55")).toBeNull();
  });

  it("encontra reserva de combinação em Outras reservas via occupantTables", () => {
    const focused = reserva("foco", { time: "19:00:00" });
    const combo = reserva("combo", { table_id: "t2", time: "20:10:00" });
    renderPanel({
      state: { situation: "late", focusReservationId: focused.id },
      reservations: [focused, combo],
      occupantTables: [
        { table_id: "t1", reservation_id: "combo", walk_in_id: null, waitlist_id: null, overlap_ok: false },
        { table_id: "t2", reservation_id: "combo", walk_in_id: null, waitlist_id: null, overlap_ok: false },
      ],
    });
    const others = screen.getByTestId("painel-mesa-outras");
    expect(within(others).getByText("Cliente combo")).toBeTruthy();
  });

  it("sinaliza reserva próxima quando a mesa está ocupada por passante", () => {
    const upcoming = reserva("prox", { time: "20:00:00", status: "pending" });
    const occupied = {
      situation: "occupied",
      occupant: { kind: "walk_in", id: "w1", since: "2026-11-05T19:20:00-03:00", partySize: 2 },
    } as TableState;
    renderPanel({
      state: occupied,
      reservations: [upcoming],
      states: new Map([["t1", occupied]]),
    });
    expect(within(screen.getByTestId("painel-mesa-outras")).getByText("Mesa em uso")).toBeTruthy();
  });
});

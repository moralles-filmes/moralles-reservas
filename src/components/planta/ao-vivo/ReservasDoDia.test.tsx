// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mesa, OccupantTable, ReservaComCliente } from "@/types/reserva";
import type { TableState } from "@/lib/table-situation-core";
import { ReservasDoDia } from "./ReservasDoDia";

const today = "2026-11-03";
const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT

const row = (id: string, extra: Partial<ReservaComCliente> = {}) =>
  ({
    id,
    date: today,
    time: "16:00:00",
    status: "confirmed",
    table_id: "t3",
    party_size: 2,
    arrived_at: null,
    released_at: null,
    reservation_code: "ABC123",
    customer: { id: "c-" + id, name: id, phone: "11987650000" },
    ...extra,
  }) as ReservaComCliente;

const tables = [
  { id: "t3", number: 3 },
  { id: "t4", number: 4 },
] as Mesa[];

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

function setup(
  reservations: ReservaComCliente[],
  extra: { occupantTables?: OccupantTable[]; states?: Map<string, TableState> } = {},
) {
  const onPick = vi.fn();
  render(
    <ReservasDoDia
      reservations={reservations}
      tables={tables}
      occupantTables={extra.occupantTables ?? []}
      states={extra.states ?? new Map()}
      today={today}
      now={NOW}
      durationMinutes={90}
      onPick={onPick}
      renderActions={(_r, close) => (
        <button type="button" onClick={close}>
          Trocar mesa
        </button>
      )}
    />,
  );
  return { onPick };
}

describe("ReservasDoDia", () => {
  it("separa A chegar, Sentadas e Finalizadas, com Finalizadas recolhida", () => {
    setup([
      row("João"),
      row("Sentado", { arrived_at: "2026-11-03T17:00:00Z" }),
      row("Cancelado", { status: "cancelled" }),
      row("Ausente", { status: "no_show" }),
      row("Liberado", { arrived_at: "2026-11-03T16:00:00Z", released_at: "2026-11-03T17:30:00Z" }),
    ]);
    expect(screen.getByText("A chegar (1)")).toBeInTheDocument();
    expect(screen.getByText("Sentadas (1)")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Finalizadas (3)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Cancelado")).toBeNull();

    fireEvent.click(toggle);
    const finished = screen.getByTestId("reservas-finalizadas");
    expect(within(finished).getByText("Cancelada")).toBeInTheDocument();
    expect(within(finished).getByText("Não compareceu")).toBeInTheDocument();
    expect(within(finished).getByText("Mesa liberada")).toBeInTheDocument();
  });

  it("busca sem acento e por dígitos do telefone", () => {
    setup([row("João"), row("Maria", { customer: { id: "c-m", name: "Maria", phone: "1122223333" } })]);
    const input = screen.getByRole("searchbox", { name: "Buscar por nome ou telefone" });

    fireEvent.change(input, { target: { value: "joao" } });
    expect(screen.getByText("João")).toBeInTheDocument();
    expect(screen.queryByText("Maria")).toBeNull();
    expect(screen.getByText("A chegar (1)")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "9876" } });
    expect(screen.getByText("João")).toBeInTheDocument();
    expect(screen.queryByText("Maria")).toBeNull();

    fireEvent.change(input, { target: { value: "inexistente" } });
    expect(screen.getByText("Nenhuma reserva encontrada")).toBeInTheDocument();
  });

  it("reserva sem mesa mostra Sem mesa e o card oferece Trocar mesa", () => {
    const { onPick } = setup([row("Flutuante", { table_id: null })]);
    const linha = screen.getByText("Flutuante").closest("button")!;
    expect(linha).toHaveTextContent("Sem mesa");

    fireEvent.click(linha);
    expect(onPick).toHaveBeenCalledWith(null, "Flutuante");
    const card = screen.getByRole("dialog");
    expect(within(card).getByTestId("reserva-detalhe")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Trocar mesa" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reserva em mesa fora da planta não aparece como Sem mesa", () => {
    setup([row("Antiga", { table_id: "t-inativa" })]);
    const linha = screen.getByText("Antiga").closest("button")!;
    expect(linha).toHaveTextContent("Mesa fora da planta");
    expect(linha).not.toHaveTextContent("Sem mesa");
  });

  it("mesas juntas aparecem como Mesas 3+4 e o toque destaca a mesa principal", () => {
    const occupantTables = ["t4", "t3"].map((table_id) => ({
      table_id,
      reservation_id: "Grupo",
      walk_in_id: null,
      waitlist_id: null,
      overlap_ok: false,
    })) as OccupantTable[];
    const { onPick } = setup([row("Grupo")], { occupantTables });
    const linha = screen.getByText("Grupo").closest("button")!;
    expect(linha).toHaveTextContent("Mesas 3+4");
    fireEvent.click(linha);
    expect(onPick).toHaveBeenCalledWith(tables[0], "Grupo");
  });

  it("avisa Mesa em uso quando outro ocupante está na mesa", () => {
    const states = new Map([
      ["t3", { situation: "occupied", occupant: { kind: "walk_in", id: "w1" } } as unknown as TableState],
    ]);
    setup([row("Chegando", { time: "15:10:00" })], { states });
    expect(screen.getByText("Chegando").closest("button")!).toHaveTextContent("Mesa em uso");
  });
});

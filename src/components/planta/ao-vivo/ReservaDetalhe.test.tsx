// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReservaComCliente } from "@/types/reserva";
import { ReservaDetalhe } from "./ReservaDetalhe";

const now = new Date("2026-11-05T19:50:00-03:00");

function reserva(overrides: Partial<ReservaComCliente> = {}): ReservaComCliente {
  return {
    id: "r1",
    unit_id: "u1",
    customer_id: "c1",
    table_id: "t1",
    date: "2026-11-05",
    time: "20:00:00",
    party_size: 8,
    original_party_size: 4,
    status: "confirmed",
    notes: "Aniversário, mesa tranquila",
    reservation_code: "AB12CD",
    source: "whatsapp",
    table_choice: "customer",
    created_at: "2026-11-01T12:00:00Z",
    updated_at: "2026-11-01T12:00:00Z",
    customer: { id: "c1", name: "Ana Silva", phone: "11987654321" },
    ...overrides,
  };
}

const renderDetail = (r: ReservaComCliente, tableNumbers = [12], inUse = false) =>
  render(<ReservaDetalhe reserva={r} tableNumbers={tableNumbers} now={now} durationMinutes={120} inUse={inUse} />);

describe("ReservaDetalhe", () => {
  it("mostra os dados completos da reserva", () => {
    renderDetail(reserva());
    expect(screen.getByTestId("reserva-detalhe")).toBeTruthy();
    expect(screen.getByText("Ana Silva")).toBeTruthy();
    expect(screen.getByText("#AB12CD")).toBeTruthy();
    expect(screen.getByText("(11) 98765-4321")).toBeTruthy();
    expect(screen.getByText("8 pessoas")).toBeTruthy();
    expect(screen.getByText("reservou para 4")).toBeTruthy();
    expect(screen.getByText("20:00")).toBeTruthy();
    expect(screen.getByText("Mesa 12")).toBeTruthy();
    expect(screen.getByText("Aniversário, mesa tranquila")).toBeTruthy();
    expect(screen.getByText("WhatsApp")).toBeTruthy();
    expect(screen.getByText("Escolhida pelo cliente")).toBeTruthy();
    expect(screen.getByText("Chega em 10 min")).toBeTruthy();
  });

  it("oferece telefone como link tel com prefixo brasileiro", () => {
    renderDetail(reserva());
    expect(screen.getByRole("link", { name: "(11) 98765-4321" }).getAttribute("href")).toBe("tel:+5511987654321");
  });

  it.each([
    ["customer", "Escolhida pelo cliente"],
    ["system", "Definida pelo sistema"],
    ["staff", "Ajustada pela equipe"],
  ] as const)("mostra o selo %s", (choice, label) => {
    renderDetail(reserva({ table_choice: choice }));
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("não mostra selo de escolha quando nula", () => {
    renderDetail(reserva({ table_choice: null }));
    expect(screen.queryByText(/Escolhida pelo cliente|Definida pelo sistema|Ajustada pela equipe/)).toBeNull();
  });

  it("formata nenhuma, uma ou várias mesas em ordem numérica", () => {
    const { rerender } = render(<ReservaDetalhe reserva={reserva()} tableNumbers={[]} now={now} durationMinutes={120} inUse={false} />);
    expect(screen.getByText("Sem mesa")).toBeTruthy();
    rerender(<ReservaDetalhe reserva={reserva()} tableNumbers={[12]} now={now} durationMinutes={120} inUse={false} />);
    expect(screen.getByText("Mesa 12")).toBeTruthy();
    rerender(<ReservaDetalhe reserva={reserva()} tableNumbers={[5, 3, 4]} now={now} durationMinutes={120} inUse={false} />);
    expect(screen.getByText("Mesas 3+4+5")).toBeTruthy();
  });

  it("mostra origem conhecida e oculta origem nula ou desconhecida", () => {
    const { rerender } = renderDetail(reserva({ source: "web" }));
    expect(screen.getByText("Página online")).toBeTruthy();
    rerender(<ReservaDetalhe reserva={reserva({ source: null })} tableNumbers={[12]} now={now} durationMinutes={120} inUse={false} />);
    expect(screen.queryByText("Origem")).toBeNull();
  });

  it("mostra Mesa em uso somente quando inUse", () => {
    const { rerender } = renderDetail(reserva());
    expect(screen.queryByText("Mesa em uso")).toBeNull();
    rerender(<ReservaDetalhe reserva={reserva()} tableNumbers={[12]} now={now} durationMinutes={120} inUse />);
    expect(screen.getByText("Mesa em uso")).toBeTruthy();
  });
});

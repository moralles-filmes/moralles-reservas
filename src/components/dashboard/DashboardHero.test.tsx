// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardHero } from "./DashboardHero";

afterEach(cleanup);

describe("DashboardHero", () => {
  it("mostra frase e ações", () => {
    const onNewReservation = vi.fn();
    render(<MemoryRouter><DashboardHero dateLabel="Hoje" hours={[{ hour: 20, label: "20h", reservations: 3, guests: 6, isPeak: true }]} unitSlug="casa" onNewReservation={onNewReservation} aside={null} /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Pico às 20h, com 3 reservas" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Abrir operacional" }).getAttribute("href")).toBe("/o/casa");
    fireEvent.click(screen.getByRole("button", { name: "Nova reserva" }));
    expect(onNewReservation).toHaveBeenCalledOnce();
  });

  it("dia vazio mostra estado vazio sem gráfico", () => {
    render(<MemoryRouter><DashboardHero dateLabel="Hoje" hours={[{ hour: 20, label: "20h", reservations: 0, guests: 0, isPeak: false }]} unitSlug="casa" onNewReservation={vi.fn()} aside={null} /></MemoryRouter>);
    expect(screen.getByText("Nenhuma reserva para hoje")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

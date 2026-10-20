// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Reserva } from "@/types/reserva";
import { WizardSuccess } from "./WizardSuccess";

const context = vi.hoisted(() => ({ reservation: null as Reserva | null }));
vi.mock("./useReservaWizard", () => ({ useReservaWizardContext: () => ({
  state: { confirmed: context.reservation }, actions: { reset: vi.fn() },
}) }));

const reservation = {
  id: "reservation-1", reservation_code: "ABC123", date: "2026-10-20", time: "19:00",
  party_size: 2, status: "confirmed", payment_status: "not_required",
} as Reserva;
beforeEach(() => { context.reservation = null; });

it("states that a confirmed reservation is independent of WhatsApp or email delivery", () => {
  context.reservation = reservation;
  render(<WizardSuccess />);
  expect(screen.getByRole("img", { name: "Reserva confirmada" })).toHaveClass("text-success");
  expect(screen.getByRole("heading", { name: "Reserva confirmada!" })).toBeInTheDocument();
  expect(screen.getByText(/mensagem por WhatsApp ou e-mail, quando habilitada, é enviada separadamente/i)).toBeInTheDocument();
  expect(screen.queryByText(/receberá.*em breve|em instantes/i)).not.toBeInTheDocument();
});

it("never labels an unexpected pending state as confirmed", () => {
  context.reservation = { ...reservation, status: "pending", payment_status: "pending_payment" };
  render(<WizardSuccess />);
  expect(screen.getByRole("alert")).toHaveTextContent("Estado da reserva não confirmado");
  expect(screen.queryByRole("heading", { name: "Reserva confirmada!" })).not.toBeInTheDocument();
});

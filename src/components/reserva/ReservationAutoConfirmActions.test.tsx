// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ManualReservaDialog } from "./ManualReservaDialog";

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/hooks/useReservas", () => ({
  useCreateManualReserva: () => ({ mutateAsync: mock.create, isPending: false }),
}));
vi.mock("@/hooks/useHalls", () => ({ useHallsWithSchedules: () => ({ data: [] }) }));

beforeEach(() => {
  mock.create.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

it("creates manual reservations without a pending approval switch", () => {
  render(<ManualReservaDialog open onOpenChange={vi.fn()} unitId="unit-1" organizationId="org-1" />);
  expect(screen.getByRole("heading", { name: "Nova reserva manual" })).toBeInTheDocument();
  expect(screen.queryByText("Reserva confirmada")).not.toBeInTheDocument();
  expect(screen.queryByText(/Desligado entra como/)).not.toBeInTheDocument();
  expect(screen.getByText("Avisar cliente")).toBeInTheDocument();
});

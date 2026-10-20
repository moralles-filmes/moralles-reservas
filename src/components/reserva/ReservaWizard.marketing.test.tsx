import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReservaWizard } from "./ReservaWizard";
import { useReservaWizardContext } from "./wizard/useReservaWizard";

const createReserva = vi.fn();
vi.mock("@/hooks/useReservas", () => ({
  useCreateReserva: () => ({ mutateAsync: createReserva, isPending: false }),
}));
vi.mock("./wizard/StepDateTimeParty", () => ({
  StepDateTimeParty: () => {
    const { actions } = useReservaWizardContext();
    return <button onClick={() => actions.goToStep(3)}>Ir aos dados</button>;
  },
}));

const firstUnit = { id: "unit-1", name: "Ren <Sushi>", organization_id: "org-1" };
const nextUnit = { id: "unit-2", name: "Outra Loja", organization_id: "org-1" };

async function fillGuestInfo() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Ir aos dados" }));
  await user.type(screen.getByLabelText(/Nome Completo/), "Ana Silva");
  await user.type(screen.getByLabelText(/E-mail/), "ana@example.com");
  await user.type(screen.getByLabelText(/Celular/), "11999998888");
  return user;
}

beforeEach(() => {
  createReserva.mockReset();
  createReserva.mockImplementation(async (data) => ({
    id: "reservation-1", reservation_code: "ABC123", date: "2026-10-20",
    time: "19:00", party_size: 2, status: "confirmed", payment_status: "not_required", ...data,
  }));
});

describe.each(["dialog", "embedded"] as const)("ReservaWizard %s", (mode) => {
  it("inicia sem consentimento e envia booleano falso; o reinício apaga escolha anterior", async () => {
    render(<ReservaWizard mode={mode} unit={firstUnit} halls={[]} />);
    const user = await fillGuestInfo();
    const checkbox = screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios do Ren <Sushi>/ });
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reservar" }));
    await waitFor(() => expect(createReserva).toHaveBeenCalledWith(expect.objectContaining({ marketing_opt_in: false })));
    await user.click(screen.getByRole("button", { name: "Fazer outra reserva" }));
    await user.click(screen.getByRole("button", { name: "Ir aos dados" }));
    expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios/ })).toHaveAttribute("data-state", "unchecked");
  });

  it("envia true só após marcação explícita e limpa ao trocar de unidade", async () => {
    const { rerender } = render(<ReservaWizard mode={mode} unit={firstUnit} halls={[]} />);
    const user = await fillGuestInfo();
    const checkbox = screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios/ });
    await user.click(screen.getByText(/Quero receber ofertas e benefícios/));
    expect(checkbox).toHaveAttribute("data-state", "checked");
    await user.click(screen.getByRole("button", { name: "Reservar" }));
    await waitFor(() => expect(createReserva).toHaveBeenCalledWith(expect.objectContaining({ marketing_opt_in: true })));
    await user.click(screen.getByRole("button", { name: "Fazer outra reserva" }));
    await user.click(screen.getByRole("button", { name: "Ir aos dados" }));
    expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios/ })).toHaveAttribute("data-state", "unchecked");
    await user.click(screen.getByText(/Quero receber ofertas e benefícios/));
    rerender(<ReservaWizard mode={mode} unit={nextUnit} halls={[]} />);
    await user.click(screen.getByRole("button", { name: "Ir aos dados" }));
    expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios do Outra Loja/ })).toHaveAttribute("data-state", "unchecked");
  });
});

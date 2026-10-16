import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitlistFormPublic } from "./WaitlistFormPublic";

const addToWaitlist = vi.fn();
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
vi.mock("@/hooks/useWaitlist", () => ({
  useAnonAddToWaitlist: () => ({ mutateAsync: addToWaitlist }),
}));

beforeEach(() => {
  addToWaitlist.mockReset();
  addToWaitlist.mockResolvedValue({ code: 42 });
});

async function submit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Nome *"), "Ana Silva");
  await user.type(screen.getByLabelText("WhatsApp *"), "11999998888");
  await user.click(screen.getByRole("button", { name: "Entrar na fila" }));
  return user;
}

it("envia false por padrão e apresenta escolha de marketing separada do aviso operacional", async () => {
  render(<WaitlistFormPublic unitId="unit-1" unitName="Ren <Sushi>" />);
  expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios do Ren <Sushi>/ })).toHaveAttribute("data-state", "unchecked");
  expect(screen.getByText("Avisaremos pelo WhatsApp quando a mesa estiver pronta.")).toBeInTheDocument();
  await submit();
  await waitFor(() => expect(addToWaitlist).toHaveBeenCalledWith(expect.objectContaining({ marketing_opt_in: false })));
});

it("envia true após marcação explícita e apaga escolha ao trocar de unidade", async () => {
  const { rerender } = render(<WaitlistFormPublic unitId="unit-1" unitName="Ren Sushi" />);
  const user = userEvent.setup();
  await user.click(screen.getByText(/Quero receber ofertas e benefícios/));
  expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios/ })).toHaveAttribute("data-state", "checked");
  await submit();
  await waitFor(() => expect(addToWaitlist).toHaveBeenCalledWith(expect.objectContaining({ marketing_opt_in: true })));
  rerender(<WaitlistFormPublic unitId="unit-2" unitName="Outra Loja" />);
  expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios do Outra Loja/ })).toHaveAttribute("data-state", "unchecked");
});

it("ignora confirmação atrasada da unidade anterior", async () => {
  let resolveEntry: (value: { code: number }) => void;
  addToWaitlist.mockReturnValue(new Promise((resolve) => { resolveEntry = resolve; }));
  const { rerender } = render(<WaitlistFormPublic unitId="unit-1" unitName="Ren Sushi" />);
  await submit();
  await waitFor(() => expect(addToWaitlist).toHaveBeenCalledTimes(1));
  rerender(<WaitlistFormPublic unitId="unit-2" unitName="Outra Loja" />);
  resolveEntry!({ code: 42 });
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Quero receber ofertas e benefícios do Outra Loja/ })).toHaveAttribute("data-state", "unchecked"));
  expect(screen.queryByText("Você está na fila")).not.toBeInTheDocument();
});

it("mostra os valores padrão dos selects após trocar de unidade", async () => {
  const { rerender } = render(<WaitlistFormPublic unitId="unit-1" unitName="Ren Sushi" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: /Quantas pessoas/ }));
  await user.click(screen.getByRole("option", { name: "4 pessoas" }));
  await user.click(screen.getByRole("combobox", { name: /Prioridade no atendimento/ }));
  await user.click(screen.getByRole("option", { name: /Idoso/ }));
  expect(screen.getByRole("combobox", { name: /Quantas pessoas/ })).toHaveTextContent("4 pessoas");
  expect(screen.getByRole("combobox", { name: /Prioridade no atendimento/ })).toHaveTextContent("Idoso (60+)");
  rerender(<WaitlistFormPublic unitId="unit-2" unitName="Outra Loja" />);
  expect(screen.getByRole("combobox", { name: /Quantas pessoas/ })).toHaveTextContent("2 pessoas");
  expect(screen.getByRole("combobox", { name: /Prioridade no atendimento/ })).toHaveTextContent("Não sou prioritário");
});

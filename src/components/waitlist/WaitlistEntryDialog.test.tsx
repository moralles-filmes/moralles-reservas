// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WaitlistEntry } from "@/types/reserva";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: m.rpc,
    from: () => ({ update: (v: unknown) => ({ eq: (col: string, val: string) => m.update(v, col, val) }) }),
  },
}));
vi.mock("sonner", () => ({ toast: { error: m.toastError, success: m.toastSuccess } }));

import { WaitlistEntryDialog } from "./WaitlistEntryDialog";

const renderDialog = (props: Partial<Parameters<typeof WaitlistEntryDialog>[0]> = {}) => {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WaitlistEntryDialog unitId="u1" open onOpenChange={onOpenChange} {...props} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
};

const submit = () => screen.getByRole("button", { name: /^(Adicionar à fila|Salvar alterações)$/ });

beforeEach(() => {
  m.rpc.mockReset().mockResolvedValue({ error: null });
  m.update.mockReset().mockResolvedValue({ error: null });
  m.toastError.mockClear();
  m.toastSuccess.mockClear();
});

describe("WaitlistEntryDialog", () => {
  it("nome vazio não chama rpc e mostra toast", () => {
    renderDialog();
    fireEvent.click(submit());
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.toastError).toHaveBeenCalledWith("Informe o nome do cliente.");
  });

  it("adicionar envia enter_waitlist com unidade e nome e fecha", async () => {
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByLabelText(/Nome do cliente/), { target: { value: "  Maria  " } });
    fireEvent.click(submit());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.rpc).toHaveBeenCalledWith(
      "enter_waitlist",
      expect.objectContaining({ p_unit_id: "u1", p_customer_name: "Maria", p_party_size: 2 }),
    );
  });

  it("modo editar preenche os campos com a entrada e salva por update", async () => {
    const entry = {
      id: "w1",
      customer_name: "Beto",
      customer_phone: "11999990000",
      party_size: 4,
      requested_for_time: "19:30:00",
      notes: "Janela",
    } as unknown as WaitlistEntry;
    const { onOpenChange } = renderDialog({ entry });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Editar cliente" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Nome do cliente/)).toHaveValue("Beto");
    expect(screen.getByLabelText(/WhatsApp/)).toHaveValue("11999990000");
    expect(screen.getByLabelText(/Horário preferencial/)).toHaveValue("19:30");
    expect(screen.getByLabelText(/Observações/)).toHaveValue("Janela");
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ customer_name: "Beto", party_size: 4, requested_for_time: "19:30" }),
      "id",
      "w1",
    );
  });
});

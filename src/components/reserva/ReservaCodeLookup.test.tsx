import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ReservaCodeLookup, ReservaCodeLookupResult } from "./ReservaCodeLookup";
import { buildConfirmationMessage } from "@/lib/zapi";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const real = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...real, useNavigate: () => navigate };
});

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const UNIT = "bbbbbbbb-0000-0000-0000-000000000001";
const TOKEN = "dddddddd-0000-0000-0000-000000000001";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  navigate.mockReset();
  rpc.mockReset();
});

async function buscar(codigo: string) {
  await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
  await userEvent.type(screen.getByPlaceholderText(/AB1C2DEF/i), codigo);
  await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));
}

describe("ReservaCodeLookupResult", () => {
  it("não afirma nada enquanto está parado ou buscando", () => {
    const { rerender } = render(<ReservaCodeLookupResult state="idle" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/não foi possível consultar/i)).not.toBeInTheDocument();
    rerender(<ReservaCodeLookupResult state="pending" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });

  it("diz 'não encontrada' quando a RPC devolveu null", () => {
    render(<ReservaCodeLookupResult state="notFound" onRetry={() => {}} />);
    expect(screen.getByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  // O ramo que esta frente existe para criar. Ele não existia, e por isso 54
  // dias de HTTP 401 chegaram ao cliente como "código errado".
  it("diz que FALHOU, nunca 'não encontrada', quando a consulta deu erro", async () => {
    const onRetry = vi.fn();
    render(<ReservaCodeLookupResult state="error" onRetry={onRetry} />);

    expect(
      screen.getByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ReservaCodeLookup", () => {
  it("leva para /acompanhar quando o código resolve", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
    expect(navigate).toHaveBeenCalledWith(`/acompanhar/${TOKEN}`);
  });

  it("não navega quando a RPC devolve null — diz que não encontrou", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  it("não navega e não diz 'não encontrada' quando a RPC dá erro", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });

  // Defeito real de produção: o cliente copia o código exatamente como o
  // sistema o exibe (com "#" — WizardSuccess, AcompanharReserva, WhatsApp) e
  // COLA no campo. maxLength=8 cortava a colagem ANTES de qualquer sanitização
  // rodar, comendo o último caractere real do código ("#8GY6EG9X" virava
  // "#8GY6EG9" no DOM). Usa paste (não type) porque é isso que reproduz o
  // truncamento pela colagem de uma vez só — ver relatório.
  it("cola '#8GY6EG9X' do WhatsApp e busca pelo código sem a cerquilha, sem perder o último caractere", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste("#8GY6EG9X");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("digita '#' no começo e o caractere não aparece no campo", async () => {
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.type(input, "#AB1C2DEF");

    expect(input.value).toBe("AB1C2DEF");
  });

  // FIX ROUND 2 — caso mais provável que o da round 1: a DialogDescription
  // deste componente diz "recebido no WhatsApp", e a mensagem que o próprio
  // sistema manda (zapi.ts) é isso que o cliente tem na tela pra copiar. Ele
  // não recorta só o código — copia a bolha inteira. A string aqui vem do
  // PRÓPRIO template de produção, não de um exemplo inventado.
  it("cola a mensagem REAL de confirmação (gerada por buildConfirmationMessage) e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    const mensagemReal = buildConfirmationMessage({
      name: "Maria",
      date: "22/09/2026",
      time: "20:00",
      partySize: 2,
      code: "8GY6EG9X",
    });

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste(mensagemReal);
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("cola 'Código: #8GY6EG9X' sem emoji e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste("Código: #8GY6EG9X");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerStatsBlock } from "./CustomerStatsBlock";
import type { CustomerStats } from "@/types/reserva";

// Os mesmos números que o pré-voo da migration 108 mede no STATS-1
// (supabase/tests/local-preflight/12-customer-stats-108.sql), para os dois lados
// falarem da mesma coisa.
const cheio: CustomerStats = {
  total: 4,
  confirmed: 2,
  no_shows: 1,
  cancelled: 1,
  no_show_rate: 0.333,
  last_visit: "2026-09-05",
};

describe("CustomerStatsBlock", () => {
  it("mostra os números quando tem stats", () => {
    render(
      <CustomerStatsBlock stats={cheio} isLoading={false} isError={false} onRetry={() => {}} />
    );
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText(/Última presença/)).toBeInTheDocument();
  });

  // O ramo que a migration 108 torna alcançável: a RPC passa a recusar com 42501
  // quem não é membro da org do cliente. Antes desta mudança o erro caía num
  // `: null` e a caixa renderizava VAZIA — sem explicação e sem retry.
  it("mostra erro e botão de retry quando a consulta falha, em vez de caixa vazia", async () => {
    const onRetry = vi.fn();
    render(
      <CustomerStatsBlock stats={undefined} isLoading={false} isError onRetry={onRetry} />
    );

    expect(screen.getByText(/não foi possível carregar/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // Erro e "sem dado" são resultados diferentes: silenciar o primeiro como o
  // segundo já mascarou incidente neste repo.
  it("erro vence stats ausentes — não renderiza rótulo de número nenhum", () => {
    render(
      <CustomerStatsBlock stats={undefined} isLoading={false} isError onRetry={() => {}} />
    );
    expect(screen.queryByText("Reservas")).not.toBeInTheDocument();
  });

  // Se a consulta falhar DEPOIS de já ter trazido dado, o React Query mantém o
  // `data` anterior. Mostrar número velho ao lado de nada seria pior que dizer
  // que falhou.
  it("erro vence stats em cache — não mostra número obsoleto como se fosse atual", () => {
    render(<CustomerStatsBlock stats={cheio} isLoading={false} isError onRetry={() => {}} />);
    expect(screen.getByText(/não foi possível carregar/i)).toBeInTheDocument();
    expect(screen.queryByText("Reservas")).not.toBeInTheDocument();
    expect(screen.queryByText(/Última presença/)).not.toBeInTheDocument();
  });

  it("carregando mostra skeleton, sem número e sem erro", () => {
    render(
      <CustomerStatsBlock stats={undefined} isLoading isError={false} onRetry={() => {}} />
    );
    expect(screen.queryByText("Reservas")).not.toBeInTheDocument();
    expect(screen.queryByText(/não foi possível carregar/i)).not.toBeInTheDocument();
  });

  it("taxa de no-show só destaca com amostra de 3 ou mais", () => {
    const { container } = render(
      <CustomerStatsBlock
        stats={{ ...cheio, total: 2, confirmed: 1, no_shows: 1, no_show_rate: 0.5 }}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  // `no_show_rate` null é "não há denominador", não zero — a RPC devolve
  // `0::numeric` nesse caso e a irmã `get_customer_stats_bulk` devolve null, então
  // a UI tem de aguentar os dois sem renderizar "0%" como se fosse medição.
  it("taxa null renderiza travessão, não 0%", () => {
    render(
      <CustomerStatsBlock
        stats={{ total: 0, confirmed: 0, no_shows: 0, cancelled: 0, no_show_rate: null, last_visit: null }}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/Última presença/)).not.toBeInTheDocument();
  });
});

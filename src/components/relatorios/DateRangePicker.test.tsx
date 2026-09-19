import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateRangePicker } from "./DateRangePicker";

// O Popper do Radix (usado pelo Popover) exige ResizeObserver, que o jsdom não
// implementa.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

// O calendário abre no mês corrente (não recebe `defaultMonth`), então os dias
// alvo são montados nesse mês — todo mês tem dia 10 e 18.
const noMesCorrente = (d: number) => {
  const hoje = new Date();
  return new Date(hoje.getFullYear(), hoje.getMonth(), d);
};

/**
 * Os botões de dia do react-day-picker v8 não têm aria-label: o nome acessível é
 * só o número. Com `showOutsideDays` (padrão do wrapper Calendar) o mesmo número
 * pode aparecer duas vezes, então os dias de fora do mês — marcados com
 * `day-outside` pelo classNames do wrapper — ficam de fora da busca.
 */
const botaoDoDia = (d: number): HTMLElement => {
  const alvo = Array.from(
    document.querySelectorAll<HTMLElement>('button[name="day"]'),
  ).find(
    (b) => !b.classList.contains("day-outside") && b.textContent?.trim() === String(d),
  );
  if (!alvo) throw new Error(`dia ${d} do mês corrente não encontrado no calendário`);
  return alvo;
};

const TRIGGER = /^\d{2} \w{3}, \d{4} - \d{2} \w{3}, \d{4}$/;

// Filtro já em vigor quando o usuário abre o calendário. É o estado que causava o
// defeito: se o rascunho continuasse sendo esse intervalo completo, o primeiro
// clique ajustaria uma ponta dele e filtraria sozinho.
const emVigor = {
  from: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 20),
  to: noMesCorrente(28),
};

function montar() {
  const onChange = vi.fn();
  render(<DateRangePicker value={emVigor} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

describe("DateRangePicker — intervalo só é aplicado no segundo clique", () => {
  it("primeiro clique não chama onChange e mantém o calendário aberto", async () => {
    const { onChange, user } = montar();

    await user.click(screen.getByRole("button", { name: TRIGGER }));
    await user.click(botaoDoDia(10));

    expect(onChange).not.toHaveBeenCalled();
    // Segue aberto: o dia 18 precisa estar clicável para fechar o intervalo.
    expect(botaoDoDia(18)).toBeInTheDocument();
  });

  it("segundo clique chama onChange uma vez, com as pontas normalizadas", async () => {
    const { onChange, user } = montar();

    await user.click(screen.getByRole("button", { name: TRIGGER }));
    await user.click(botaoDoDia(10));
    await user.click(botaoDoDia(18));

    expect(onChange).toHaveBeenCalledTimes(1);
    const range = onChange.mock.calls[0][0];
    expect(range.from).toEqual(new Date(noMesCorrente(10).setHours(0, 0, 0, 0)));
    expect(range.to).toEqual(new Date(noMesCorrente(18).setHours(23, 59, 59, 999)));
  });

  it("clicar em cima de uma ponta do filtro em vigor começa seleção nova, não limpa", async () => {
    // Antes, clicar exatamente na ponta inicial devolvia `undefined` e a seleção
    // inteira sumia sem explicação.
    const { onChange, user } = montar();

    await user.click(screen.getByRole("button", { name: TRIGGER }));
    await user.click(botaoDoDia(28));

    expect(onChange).not.toHaveBeenCalled();

    await user.click(botaoDoDia(18));
    expect(onChange).toHaveBeenCalledTimes(1);
    const range = onChange.mock.calls[0][0];
    expect(range.from).toEqual(new Date(noMesCorrente(18).setHours(0, 0, 0, 0)));
    expect(range.to).toEqual(new Date(noMesCorrente(28).setHours(23, 59, 59, 999)));
  });

  it("preset aplica o filtro num clique só — o atalho não passa pelo calendário", async () => {
    const { onChange, user } = montar();

    await user.click(screen.getByRole("button", { name: TRIGGER }));
    await user.click(screen.getByText("Últimos 7 dias"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

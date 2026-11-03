import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SalaoAoVivo from "./SalaoAoVivo";

const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT

const hall = { id: "h1", unit_id: "u1", name: "Salão", active: true, sort_order: 0, plan_width_cm: 1200, plan_depth_cm: 900 };
const mk = (id: string, n: number) => ({
  id, unit_id: "u1", hall_id: "h1", number: n, capacity: 4, min_capacity: 2, max_capacity: 4, active: true,
});
const tables = [mk("t1", 1), mk("t2", 2), mk("t3", 3), mk("t4", 4), mk("t5", 5)];
const res = (id: string, table_id: string, time: string, extra = {}) => ({
  id, unit_id: "u1", table_id, date: "2026-11-03", time, party_size: 2, status: "confirmed",
  arrived_at: null, released_at: null, customer: { id: "c" + id, name: "Cliente " + id, phone: "11999990000" }, ...extra,
});

const hookData = {
  halls: [hall],
  tables,
  reservations: [
    res("r3", "t3", "14:00", { arrived_at: "2026-11-03T17:20:00Z" }), // ocupada (Mesa 3)
    res("r2", "t2", "14:40"), // atrasada
    res("r4", "t4", "15:05"), // chegando
    res("r5", "t5", "17:00"), // reservada
  ],
  walkIns: [],
  waitlistActive: [],
  waitlistSeated: [],
  blocks: [{ table_id: "t1", hall_id: null, blocked_from: "2026-11-03T00:00:00Z", blocked_to: "2026-11-04T00:00:00Z" }],
  durationMinutes: 90,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};
let current: typeof hookData = hookData;

vi.mock("@/hooks/useSalaoAoVivo", () => ({ useSalaoAoVivo: () => current }));
let currentUnitId = "u1";
vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: currentUnitId, unit_slug: "moralles", isGerente: true }),
}));

function setMedia(matches: (q: string) => boolean) {
  window.matchMedia = ((q: string) => ({
    matches: matches(q), media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const renderPage = () => render(<MemoryRouter><SalaoAoVivo /></MemoryRouter>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  current = hookData;
  currentUnitId = "u1";
  setMedia(() => false);
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("SalaoAoVivo", () => {
  it("legenda traz a contagem de cada situação", () => {
    renderPage();
    const legend = screen.getByRole("list", { name: "Situação das mesas" });
    for (const label of ["Bloqueada", "Ocupada", "Atrasada", "Chegando", "Reservada"]) {
      const item = within(legend).getByText(label).closest("li")!;
      expect(item).toHaveTextContent("1");
    }
    expect(within(legend).getByText("Livre").closest("li")).toHaveTextContent("0");
  });

  it("prefers-reduced-motion renderiza a vista 2D", () => {
    setMedia((q) => q.includes("prefers-reduced-motion"));
    renderPage();
    expect(screen.getByTestId("planta-2d")).toBeInTheDocument();
  });

  it("largura 390 renderiza a vista 2D", () => {
    setMedia((q) => q.includes("max-width: 639px"));
    renderPage();
    expect(screen.getByTestId("planta-2d")).toBeInTheDocument();
  });

  it("tocar na Mesa 3 mostra o ocupante no painel", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 3,/ }));
    const painel = screen.getByTestId("painel-mesa");
    expect(painel).toHaveTextContent("Mesa 3");
    expect(painel).toHaveTextContent("Cliente r3");
  });

  it("tocar numa linha de próximas chegadas seleciona a mesa", () => {
    renderPage();
    const chegadas = screen.getByTestId("proximas-chegadas");
    fireEvent.click(within(chegadas).getByText("Cliente r5").closest("button")!);
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 5");
    expect(screen.getByRole("button", { name: /^Mesa 5,/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("isError mostra Tentar de novo", () => {
    current = { ...hookData, isError: true };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(hookData.refetch).toHaveBeenCalled();
  });

  it("unidade ainda vazia mostra o esqueleto, não o estado vazio", () => {
    currentUnitId = "";
    current = { ...hookData, halls: [], tables: [] };
    const { container } = renderPage();
    expect(screen.queryByText("Cadastre salões e mesas na Gestão")).toBeNull();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("erro na primeira carga (sem dados completos) mostra a tela de erro, não a cena", () => {
    current = { ...hookData, isError: true, hasData: false } as typeof hookData;
    renderPage();
    expect(screen.queryByTestId("planta-3d")).toBeNull();
    expect(screen.getByText("Não foi possível carregar o salão.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("erro de refetch com dados em cache mantém a cena e avisa Dados desatualizados", () => {
    current = { ...hookData, isError: true, hasData: true } as typeof hookData;
    renderPage();
    expect(screen.getByTestId("planta-3d")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível carregar o salão.")).toBeNull();
    expect(screen.getByText("Dados desatualizados")).toBeInTheDocument();
    hookData.refetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(hookData.refetch).toHaveBeenCalled();
  });

  it("trocar de salão pelo seletor limpa a mesa selecionada; próximas chegadas não", () => {
    const hall2 = { ...hall, id: "h2", name: "Varanda", sort_order: 1 };
    const t6 = { ...mk("t6", 6), hall_id: "h2" };
    current = {
      ...hookData,
      halls: [hall, hall2],
      tables: [...tables, t6],
      reservations: [...hookData.reservations, res("r6", "t6", "18:00")],
    };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 3,/ }));
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 3");
    fireEvent.click(screen.getByRole("button", { name: "Varanda" }));
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Toque numa mesa");
    // volta ao salão 1 e escolhe uma mesa; depois pula para o salão 2 via próximas chegadas
    fireEvent.click(screen.getByRole("button", { name: "Salão" }));
    fireEvent.click(within(screen.getByTestId("proximas-chegadas")).getByText("Cliente r6").closest("button")!);
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 6");
  });

  it("o painel só anuncia a troca de mesa, não o conteúdo que muda por minuto", () => {
    renderPage();
    const painel = screen.getByTestId("painel-mesa");
    expect(painel).not.toHaveAttribute("aria-live");
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 3,/ }));
    expect(within(painel).getByRole("status")).toHaveTextContent("Mesa 3 selecionada");
  });

  it("o plano girado do 3D não carrega a animação de entrada, que sobrescreveria o transform", () => {
    renderPage();
    const plano = screen.getByTestId("planta-3d-plano");
    expect(plano.style.transform).toContain("rotateX(56deg)");
    expect(plano.style.transform).toContain("rotateZ(-36deg)");
    expect(plano.className).not.toContain("animate-settle");
    expect(screen.getByTestId("planta-3d-entrada").className).toContain("animate-settle");
  });

  it("reserva em mesa fora da planta não aparece como sem mesa", () => {
    current = { ...hookData, reservations: [...hookData.reservations, res("r9", "t-inativa", "18:00")] };
    renderPage();
    const linha = within(screen.getByTestId("proximas-chegadas")).getByText("Cliente r9").closest("button")!;
    expect(linha).toHaveTextContent("em mesa fora da planta");
    expect(linha).not.toHaveTextContent("sem mesa");
  });

  it("no 3D só o botão da mesa recebe ponteiro; o resto da cena não rouba o toque", () => {
    renderPage();
    expect(screen.getByTestId("planta-3d-entrada").className).toContain("pointer-events-none");
    expect(screen.getByTestId("planta-3d-plano").className).toContain("pointer-events-none");
    const botao = screen.getByRole("button", { name: /^Mesa 3,/ });
    expect(botao.className).toContain("pointer-events-auto");
    let el: HTMLElement | null = botao.parentElement;
    while (el && el !== screen.getByTestId("planta-3d")) {
      expect(el.className, "ancestral do botão").toContain("pointer-events-none");
      el = el.parentElement;
    }
  });
});

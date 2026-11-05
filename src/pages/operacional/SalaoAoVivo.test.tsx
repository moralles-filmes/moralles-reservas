import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SalaoAoVivo from "./SalaoAoVivo";

const NOW = new Date("2026-11-03T18:00:00Z"); // 15:00 BRT

const hall = { id: "h1", unit_id: "u1", name: "Salão", active: true, sort_order: 0, plan_width_cm: 1200, plan_depth_cm: 900 };
const mk = (id: string, n: number) => ({
  id, unit_id: "u1", hall_id: "h1", number: n, capacity: 4, min_capacity: 2, max_capacity: 4, active: true, bookable: true,
});
const tables = [mk("t1", 1), mk("t2", 2), mk("t3", 3), mk("t4", 4), mk("t5", 5)];
const res = (id: string, table_id: string, time: string, extra = {}) => ({
  id, unit_id: "u1", table_id, customer_id: "c" + id, date: "2026-11-03", time, party_size: 2, status: "confirmed",
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
  occupantTables: [],
  walkIns: [],
  waitlistActive: [],
  waitlistSeated: [],
  blocks: [{ table_id: "t1", hall_id: null, blocked_from: "2026-11-03T00:00:00Z", blocked_to: "2026-11-04T00:00:00Z" }],
  durationMinutes: 90,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};
// Sem dayReservations explícito, a lista do dia é a mesma das reservas ativas.
let current: typeof hookData & { dayReservations?: unknown[] } = hookData;

vi.mock("@/hooks/useSalaoAoVivo", () => ({
  useSalaoAoVivo: () => ({ ...current, dayReservations: current.dayReservations ?? current.reservations }),
}));
const tableMutate = vi.fn();
vi.mock("@/hooks/useOcupacaoAcoes", () => ({
  useSetOccupantTables: () => ({ mutate: tableMutate, isPending: false }),
  useSetOccupantPartySize: () => ({ mutate: vi.fn(), isPending: false }),
}));
const presenceMutate = vi.fn();
vi.mock("@/hooks/useMesaAcoes", () => ({
  useReservationPresence: () => ({ mutate: presenceMutate, isPending: false, variables: undefined }),
  useSeatWaitlistEntry: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useReleaseWaitlistEntry: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useReleaseWalkIn: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock("@/hooks/useWalkIns", () => ({
  useWalkIns: () => ({ data: [] }),
  useCreateWalkIn: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWalkInStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useWaitlist", () => ({
  useNotifyWaitlist: () => ({ mutate: vi.fn(), isPending: false }),
  useAddToWaitlist: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWaitlistEntry: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useWaitlistTemplates", () => ({ useWaitlistTemplates: () => ({ data: [] }) }));
let currentUnitId = "u1";
let currentSlug: string | undefined = "moralles";
vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: currentUnitId, unit_slug: currentSlug, isGerente: true }),
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
  tableMutate.mockReset();
  current = hookData;
  currentUnitId = "u1";
  currentSlug = "moralles";
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

  it("a mesa selecionada mostra as ações da sua situação", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 4,/ })); // chegando
    fireEvent.click(within(screen.getByTestId("painel-mesa")).getByRole("button", { name: "Marcar chegada" }));
    expect(presenceMutate).toHaveBeenCalledWith({ reservationId: "r4", action: "arrive" });
  });

  it("com slug, a mesa chegando oferece Abrir conversa; sem slug, não monta /o//conversas", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 4,/ }));
    expect(within(screen.getByTestId("painel-mesa")).getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/o/moralles/conversas?cliente=cr4",
    );
    cleanup();
    currentSlug = undefined;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 4,/ }));
    expect(within(screen.getByTestId("painel-mesa")).queryByRole("link", { name: "Abrir conversa" })).toBeNull();
  });

  it("tocar numa linha de próximas chegadas seleciona a mesa", () => {
    renderPage();
    const chegadas = screen.getByTestId("reservas-do-dia");
    fireEvent.click(within(chegadas).getByText("Cliente r5").closest("button")!);
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 5");
    expect(screen.getByRole("button", { name: /^Mesa 5,/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("tocar numa reserva mais tarde de uma mesa atrasada destaca a reserva tocada, sem o atraso da outra", () => {
    // Mesa 2: r2 das 14:40 atrasada (agora 15:00) e rg das 19:00 ainda por vir.
    current = { ...hookData, reservations: [...hookData.reservations, res("rg", "t2", "19:00")] };
    renderPage();
    fireEvent.click(within(screen.getByTestId("reservas-do-dia")).getByText("Cliente rg").closest("button")!);
    const outras = within(screen.getByTestId("painel-mesa")).getByTestId("painel-mesa-outras");
    const linha = within(outras).getByText("Cliente rg").closest("li")!;
    expect(linha).toHaveAttribute("aria-current", "true");
    expect(linha).toHaveTextContent("19:00");
    expect(linha).not.toHaveTextContent(/Atrasada/);
    // Tocar direto na mesa tira o destaque.
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 2,/ }));
    expect(within(screen.getByTestId("painel-mesa-outras")).getByText("Cliente rg").closest("li")).not.toHaveAttribute(
      "aria-current",
    );
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
    fireEvent.click(within(screen.getByTestId("reservas-do-dia")).getByText("Cliente r6").closest("button")!);
    expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 6");
  });

  describe("modo Todos", () => {
    const hall2 = { ...hall, id: "h2", name: "Varanda", sort_order: 1, plan_width_cm: null, plan_depth_cm: null };
    const t6 = { ...mk("t6", 6), hall_id: "h2" };
    const twoHalls = () => ({
      ...hookData,
      halls: [hall, hall2],
      tables: [...tables, t6],
      reservations: [...hookData.reservations, res("r6", "t6", "18:00")],
    });

    it("com 1 salão não há botão Todos", () => {
      renderPage();
      expect(screen.queryByRole("button", { name: "Todos" })).toBeNull();
    });

    it("abre no salão individual, sem etiquetas", () => {
      current = twoHalls();
      renderPage();
      expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByRole("button", { name: /^Mesa 6,/ })).toBeNull();
    });

    it("Todos mostra as mesas dos dois salões, os nomes, soma a legenda e grava a preferência", () => {
      current = twoHalls();
      renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Todos" }));
      expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^Mesa 3,/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Mesa 6,/ })).toBeInTheDocument();
      expect(screen.getByTestId("planta-3d")).toHaveTextContent("Varanda");
      expect(screen.getByTestId("planta-3d")).toHaveTextContent("Varanda · grade automática");
      expect(screen.getByText("6 mesas")).toBeInTheDocument();
      const legend = screen.getByRole("list", { name: "Situação das mesas" });
      expect(within(legend).getByText("Reservada").closest("li")).toHaveTextContent("2");
      expect(localStorage.getItem("salao-ao-vivo:hall:u1")).toBe("all");
      expect(screen.queryByText(/Planta ainda não desenhada/)).toBeNull();
    });

    it("recarregar com all salvo abre em Todos", () => {
      current = twoHalls();
      localStorage.setItem("salao-ao-vivo:hall:u1", "all");
      renderPage();
      expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: /^Mesa 6,/ })).toBeInTheDocument();
    });

    it("próxima chegada em Todos não sai do modo Todos e seleciona a mesa", () => {
      current = twoHalls();
      localStorage.setItem("salao-ao-vivo:hall:u1", "all");
      renderPage();
      fireEvent.click(within(screen.getByTestId("reservas-do-dia")).getByText("Cliente r6").closest("button")!);
      expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("painel-mesa")).toHaveTextContent("Mesa 6");
      expect(localStorage.getItem("salao-ao-vivo:hall:u1")).toBe("all");
    });
  });

  it("o painel só anuncia a troca de mesa, não o conteúdo que muda por minuto", () => {
    renderPage();
    const painel = screen.getByTestId("painel-mesa");
    expect(painel).not.toHaveAttribute("aria-live");
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 3,/ }));
    expect(within(painel).getByRole("status")).toHaveTextContent("Mesa 3 selecionada");
  });

  it("Fila de espera: Adicionar à fila abre o diálogo no modo adicionar", () => {
    renderPage();
    fireEvent.click(within(screen.getByTestId("resumo-fila")).getByRole("button", { name: "Adicionar à fila" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Adicionar à fila" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Nome do cliente/)).toHaveValue("");
  });

  describe("tela cheia", () => {
    const request = vi.fn(() => Promise.resolve());
    const exitFs = vi.fn(() => Promise.resolve());
    afterEach(() => {
      delete document.documentElement.requestFullscreen;
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    });
    const withApi = () => {
      request.mockClear();
      Object.defineProperty(document.documentElement, "requestFullscreen", {
        configurable: true,
        writable: true,
        value: request,
      });
      Object.defineProperty(document, "exitFullscreen", { configurable: true, writable: true, value: exitFs });
    };

    it("liga com a API: pede no documentElement, usa a camada fixed e o botão vira Sair", () => {
      withApi();
      renderPage();
      expect(screen.queryByTestId("salao-tela-cheia")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
      expect(request).toHaveBeenCalledTimes(1);
      const camada = screen.getByTestId("salao-tela-cheia");
      expect(camada.parentElement).toBe(document.body);
      expect(camada.className).toContain("fixed");
      expect(within(camada).getByTestId("painel-mesa")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sair da tela cheia" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Sair da tela cheia" }));
      expect(screen.queryByTestId("salao-tela-cheia")).toBeNull();
      expect(screen.getByRole("button", { name: "Tela cheia" })).toBeInTheDocument();
    });

    it("sem a API a camada liga mesmo assim", () => {
      renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
      expect(screen.getByTestId("salao-tela-cheia")).toBeInTheDocument();
    });

    it("sair pela tela cheia do navegador (Esc) com o diálogo aberto mantém o que foi digitado", () => {
      withApi();
      renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
      fireEvent.click(within(screen.getByTestId("resumo-fila")).getByRole("button", { name: "Adicionar à fila" }));
      fireEvent.change(within(screen.getByRole("dialog")).getByLabelText(/Nome do cliente/), {
        target: { value: "Maria" },
      });
      // O navegador sai da tela cheia: fullscreenElement já é null e o evento chega.
      act(() => {
        document.dispatchEvent(new Event("fullscreenchange"));
      });
      expect(screen.queryByTestId("salao-tela-cheia")).toBeNull();
      expect(within(screen.getByRole("dialog")).getByLabelText(/Nome do cliente/)).toHaveValue("Maria");
    });

    it("em tela cheia, Adicionar à fila abre o diálogo", () => {
      renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
      fireEvent.click(within(screen.getByTestId("resumo-fila")).getByRole("button", { name: "Adicionar à fila" }));
      expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Adicionar à fila" })).toBeInTheDocument();
    });
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
    const linha = within(screen.getByTestId("reservas-do-dia")).getByText("Cliente r9").closest("button")!;
    expect(linha).toHaveTextContent("Mesa fora da planta");
    expect(linha).not.toHaveTextContent("Sem mesa");
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

describe("escolha de mesas", () => {
  const setupPick = () => {
    current = { ...hookData, blocks: [], tables: [...tables, { ...mk("t6", 6), bookable: false }] };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 4,/ }));
  };

  it("troca mesa e impede escolher outro ocupante", () => {
    setupPick();
    fireEvent.click(screen.getByRole("button", { name: "Trocar mesa" }));
    expect(screen.getByRole("region", { name: "Seleção de mesas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Mesa 3,/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 1,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(tableMutate).toHaveBeenCalledWith(
      { occupant: { kind: "reservation", id: "r4" }, tableIds: ["t1"], allowOverlap: false },
      expect.anything(),
    );
  });

  it("junta inclusive mesa não reservável", () => {
    setupPick();
    fireEvent.click(screen.getByRole("button", { name: "Juntar mesas" }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 6,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(tableMutate).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ["t4", "t6"] }),
      expect.anything(),
    );
  });

  it.each(["Cancelar", "Escape"])("%s sai sem mutação", action => {
    setupPick();
    fireEvent.click(screen.getByRole("button", { name: "Trocar mesa" }));
    if (action === "Escape") {
      fireEvent.keyDown(document, { key: action });
    } else {
      fireEvent.click(screen.getByRole("button", { name: action }));
    }
    expect(screen.queryByRole("region", { name: "Seleção de mesas" })).toBeNull();
    expect(tableMutate).not.toHaveBeenCalled();
  });

  it("confirma conflito com allowOverlap", () => {
    tableMutate.mockImplementationOnce((_args, callbacks) =>
      callbacks.onSuccess({ status: "conflict", conflicts: [{ time: "18:00", customer_name: "Ana" }] }),
    );
    setupPick();
    fireEvent.click(screen.getByRole("button", { name: "Trocar mesa" }));
    fireEvent.click(screen.getByRole("button", { name: /^Mesa 1,/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(
      screen.getByText("Livre até 18:00, quando chega a reserva de Ana. Colocar mesmo assim?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Colocar mesmo assim" }));
    expect(tableMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowOverlap: true }),
      expect.anything(),
    );
  });

  it("ajuste acima da capacidade oferece juntar", () => {
    setupPick();
    fireEvent.click(screen.getByRole("button", { name: "Ajustar pessoas" }));
    fireEvent.change(screen.getByLabelText("Número de pessoas"), { target: { value: "8" } });
    expect(screen.getByText("Não cabe na mesa atual")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Juntar mesas" }));
    expect(screen.getByRole("region", { name: "Seleção de mesas" })).toBeInTheDocument();
  });
});

it("passante sentado oferece ajuste", () => {
  current = {
    ...hookData,
    blocks: [],
    walkIns: [
      {
        id: "w",
        table_id: "t1",
        status: "seated",
        seated_at: "2026-11-03T17:00:00Z",
        released_at: null,
        party_size: 2,
        customer_name: "Ana",
      },
    ],
  } as unknown as typeof hookData;
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: /^Mesa 1,/ }));
  expect(screen.getByRole("button", { name: "Trocar mesa" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Juntar mesas" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Ajustar pessoas" })).toBeInTheDocument();
});

it("reserva sem mesa abre o card e inicia a seleção", () => {
  const unassigned = res("sem-mesa", null, "18:00");
  current = { ...hookData, reservations: [...hookData.reservations, unassigned] };
  renderPage();
  const list = screen.getByTestId("reservas-do-dia");
  const row = within(list).getByText("Cliente sem-mesa").closest("button");
  expect(row).toHaveTextContent("Sem mesa");
  fireEvent.click(row);
  const card = screen.getByRole("dialog");
  fireEvent.click(within(card).getByRole("button", { name: "Trocar mesa" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("region", { name: "Seleção de mesas" })).toBeInTheDocument();
});

describe("card da lista do dia: presença e conversa", () => {
  const openCard = (name: string) => {
    renderPage();
    const list = screen.getByTestId("reservas-do-dia");
    fireEvent.click(within(list).getByText(name).closest("button")!);
    return screen.getByRole("dialog");
  };

  beforeEach(() => {
    current = hookData;
    currentSlug = "moralles";
    presenceMutate.mockClear();
  });

  it("reserva que não chegou oferece Marcar chegada e Abrir conversa", () => {
    const card = openCard("Cliente r2");
    fireEvent.click(within(card).getByRole("button", { name: "Marcar chegada" }));
    expect(presenceMutate).toHaveBeenCalledWith({ reservationId: "r2", action: "arrive" });
    expect(within(card).getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/o/moralles/conversas?cliente=cr2",
    );
    expect(within(card).queryByRole("button", { name: "Liberar mesa" })).toBeNull();
  });

  it("reserva que chegou oferece Liberar mesa e Desfazer chegada", () => {
    const card = openCard("Cliente r3");
    expect(within(card).queryByRole("button", { name: "Marcar chegada" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Desfazer chegada" }));
    expect(presenceMutate).toHaveBeenCalledWith({ reservationId: "r3", action: "undo_arrive" });
    fireEvent.click(within(card).getByRole("button", { name: "Liberar mesa" }));
    expect(presenceMutate).toHaveBeenCalledWith({ reservationId: "r3", action: "release" });
  });

  it("reserva sem mesa não marca chegada (só Trocar mesa)", () => {
    current = { ...hookData, reservations: [...hookData.reservations, res("sem-mesa", null, "18:00")] };
    const card = openCard("Cliente sem-mesa");
    expect(within(card).queryByRole("button", { name: "Marcar chegada" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Trocar mesa" })).toBeInTheDocument();
  });

  it("sem slug da unidade, Abrir conversa some", () => {
    currentSlug = undefined;
    const card = openCard("Cliente r2");
    expect(within(card).queryByRole("link", { name: "Abrir conversa" })).toBeNull();
  });
});

it("cancelada aparece só na lista sem mudar a situação das mesas", () => {
  current = { ...hookData, dayReservations: [...hookData.reservations, res("cancelada", "t5", "15:00", { status: "cancelled" })] };
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Finalizadas (1)" }));
  expect(within(screen.getByTestId("reservas-finalizadas")).getByText("Cliente cancelada")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Mesa 5,/ })).toHaveAccessibleName(/Reservada/);
});

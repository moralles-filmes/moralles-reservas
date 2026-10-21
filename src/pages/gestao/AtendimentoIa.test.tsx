// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AtendimentoIa from "./AtendimentoIa";
import { STORE_TEXT_LIMITS } from "../../../supabase/functions/_shared/agent/global-prompt-core";

const mocks = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const results = {
    read: { data: [], error: null } as { data: unknown; error: unknown },
    write: { data: [{ key: "a" }, { key: "b" }, { key: "c" }], error: null } as { data: unknown; error: unknown },
  };
  // `pending` segura a leitura para testar o estado de carregamento.
  const gate = { pending: false };
  const from = vi.fn((_table: string) => {
    let writing = false;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "upsert"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        if (m === "upsert") writing = true;
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (!writing && gate.pending) return new Promise(() => {});
      return resolve(writing ? results.write : results.read);
    };
    return builder;
  });
  const unit = { current: { unit_id: "unit-a", isGerente: true } as { unit_id: string; isGerente: boolean } | null };
  const toast = { success: vi.fn(), error: vi.fn() };
  return { calls, results, gate, from, unit, toast };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => mocks.unit.current }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mocks.unit.current = { unit_id: "unit-a", isGerente: true };
});

afterEach(() => {
  cleanup();
  mocks.calls.length = 0;
  mocks.gate.pending = false;
  mocks.results.read = { data: [], error: null };
  mocks.results.write = { data: [{ key: "a" }, { key: "b" }, { key: "c" }], error: null };
  vi.clearAllMocks();
});

const renderPage = () =>
  render(
    <QueryClientProvider client={client}>
      <AtendimentoIa />
    </QueryClientProvider>,
  );

const callsOf = (m: string) => mocks.calls.filter((c) => c.method === m).map((c) => c.args);
const menu = () => screen.getByLabelText("Cardápio") as HTMLTextAreaElement;
const delivery = () => screen.getByLabelText("Delivery/retirada") as HTMLTextAreaElement;
const extra = () => screen.getByLabelText("Outras informações") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
const ready = async () => {
  await screen.findByLabelText("Cardápio");
};

describe("AtendimentoIa: conteúdo", () => {
  it("mostra título, avisos fixos e o modo atual (ausente = Apenas reservas)", async () => {
    renderPage();
    await ready();
    expect(screen.getByRole("heading", { name: "Atendimento por IA" })).toBeTruthy();
    expect(screen.getByText("Escreva informações, não ordens para a IA.")).toBeTruthy();
    expect(screen.getByText("Promoções e preços por dia vão em Reservas → Ajustes → Preços e condições.")).toBeTruthy();
    expect(screen.getByText("Modo atual: Apenas reservas")).toBeTruthy();
    expect(
      screen.getByText(
        "Estes textos só são usados quando o atendimento está no modo reservas + dúvidas. O modo é mudado pela plataforma.",
      ),
    ).toBeTruthy();
  });

  it("mostra Reservas + dúvidas quando agent_mode é reservations_faq e preenche os campos salvos", async () => {
    mocks.results.read = {
      data: [
        { key: "agent_mode", value: "reservations_faq" },
        { key: "restaurant_menu", value: "Rodízio R$ 100" },
        { key: "delivery_response", value: "Só retirada" },
        { key: "restaurant_extra_info", value: "Estacionamento" },
      ],
      error: null,
    };
    renderPage();
    await ready();
    expect(screen.getByText("Modo atual: Reservas + dúvidas")).toBeTruthy();
    expect(menu().value).toBe("Rodízio R$ 100");
    expect(delivery().value).toBe("Só retirada");
    expect(extra().value).toBe("Estacionamento");
  });

  it("lê só as chaves da loja e o modo, da unidade ativa", async () => {
    renderPage();
    await ready();
    expect(callsOf("eq")).toContainEqual(["unit_id", "unit-a"]);
    expect(callsOf("in")).toEqual([["key", ["restaurant_menu", "delivery_response", "restaurant_extra_info", "agent_mode"]]]);
  });
});

describe("AtendimentoIa: contador e limite", () => {
  it("cada campo mostra contador com o limite de STORE_TEXT_LIMITS", async () => {
    renderPage();
    await ready();
    expect(screen.getByText(`0/${STORE_TEXT_LIMITS.restaurant_menu}`)).toBeTruthy();
    expect(screen.getByText(`0/${STORE_TEXT_LIMITS.delivery_response}`)).toBeTruthy();
    expect(screen.getByText(`0/${STORE_TEXT_LIMITS.restaurant_extra_info}`)).toBeTruthy();
  });

  it("conta emoji como 1 caractere", async () => {
    renderPage();
    await ready();
    fireEvent.change(menu(), { target: { value: "😀😀😀" } });
    expect(screen.getByText(`3/${STORE_TEXT_LIMITS.restaurant_menu}`)).toBeTruthy();
  });

  it("no limite exato o campo é válido; um acima bloqueia Salvar, marca o campo e explica", async () => {
    renderPage();
    await ready();
    const limit = STORE_TEXT_LIMITS.delivery_response;
    fireEvent.change(delivery(), { target: { value: "a".repeat(limit) } });
    expect(saveButton().disabled).toBe(false);
    expect(delivery().getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByText(`Passou de ${limit} caracteres.`)).toBeNull();

    fireEvent.change(delivery(), { target: { value: "a".repeat(limit + 1) } });
    expect(saveButton().disabled).toBe(true);
    expect(delivery().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(`Passou de ${limit} caracteres.`)).toBeTruthy();
    expect(delivery().getAttribute("aria-describedby")).toContain("delivery_response-problem");
    // O aviso é de um campo só.
    expect(menu().getAttribute("aria-invalid")).toBe("false");
  });

  it("caractere de controle bloqueia Salvar e mostra a mensagem do campo", async () => {
    renderPage();
    await ready();
    fireEvent.change(extra(), { target: { value: "oi\x01tchau" } });
    expect(saveButton().disabled).toBe(true);
    expect(extra().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Use só texto, sem caracteres de controle.")).toBeTruthy();
  });

  it("dado legado com \\r\\n: o contador mede o texto já normalizado e Salvar grava só \\n", async () => {
    // O navegador normaliza o que se digita; o `\r` só chega por dado legado já salvo.
    mocks.results.read = { data: [{ key: "restaurant_menu", value: "a\r\nb\rc" }], error: null };
    const user = userEvent.setup();
    renderPage();
    await ready();
    expect(screen.getByText(`5/${STORE_TEXT_LIMITS.restaurant_menu}`)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(1));
    const rows = callsOf("upsert")[0][0] as Array<{ key: string; value: string }>;
    expect(rows.find((r) => r.key === "restaurant_menu")?.value).toBe("a\nb\nc");
  });

  it("campo inválido não grava mesmo se o botão for acionado", async () => {
    renderPage();
    await ready();
    fireEvent.change(menu(), { target: { value: "a".repeat(STORE_TEXT_LIMITS.restaurant_menu + 1) } });
    fireEvent.click(saveButton());
    expect(callsOf("upsert")).toEqual([]);
  });
});

describe("AtendimentoIa: salvar", () => {
  it("grava as 3 chaves num upsert, normalizando quebras, e avisa o sucesso", async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    fireEvent.change(menu(), { target: { value: "Rodízio\nSobremesa" } });
    fireEvent.change(delivery(), { target: { value: "Retirada" } });
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(1));
    expect(callsOf("upsert")).toEqual([
      [
        [
          { unit_id: "unit-a", key: "restaurant_menu", value: "Rodízio\nSobremesa" },
          { unit_id: "unit-a", key: "delivery_response", value: "Retirada" },
          { unit_id: "unit-a", key: "restaurant_extra_info", value: "" },
        ],
        { onConflict: "unit_id,key" },
      ],
    ]);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "Sem permissão para editar estes textos."],
    ["22023", "Texto acima do limite ou com caracteres inválidos."],
    ["XX000", "Não foi possível salvar. Tente novamente."],
  ])("erro %s do banco mostra a cópia por código, nunca a mensagem crua", async (code, copy) => {
    mocks.results.write = { data: null, error: { code, message: "linha rejeitada: cardápio secreto" } };
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(copy));
    expect(JSON.stringify(mocks.toast.error.mock.calls)).not.toContain("cardápio secreto");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("zero linhas gravadas (error nulo) é erro, não sucesso", async () => {
    mocks.results.write = { data: [], error: null };
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Nenhuma alteração foi gravada."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe("AtendimentoIa: estados e permissão", () => {
  it("carregando: mostra o esqueleto e nenhum campo", () => {
    mocks.gate.pending = true;
    renderPage();
    expect(screen.getByTestId("atendimento-ia-loading")).toBeTruthy();
    expect(screen.queryByLabelText("Cardápio")).toBeNull();
  });

  it("erro de leitura: mostra a falha com Tentar novamente, que lê de novo e abre o formulário", async () => {
    mocks.results.read = { data: null, error: { code: "XX000", message: "x" } };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Não foi possível carregar os textos do atendimento.");
    expect(screen.queryByLabelText("Cardápio")).toBeNull();
    mocks.results.read = { data: [{ key: "restaurant_menu", value: "Voltou" }], error: null };
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await ready();
    expect(menu().value).toBe("Voltou");
  });

  it("vazio: campos em branco e Salvar habilitado", async () => {
    renderPage();
    await ready();
    expect(menu().value).toBe("");
    expect(saveButton().disabled).toBe(false);
  });

  it("sem ser owner/gerente: só a mensagem, sem formulário e sem leitura", () => {
    mocks.unit.current = { unit_id: "unit-a", isGerente: false };
    renderPage();
    expect(screen.getByText("Só o dono ou o gerente da loja edita o atendimento por IA.")).toBeTruthy();
    expect(screen.queryByLabelText("Cardápio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("unidade ainda não resolvida: esqueleto, sem leitura", () => {
    mocks.unit.current = null;
    renderPage();
    expect(screen.getByTestId("atendimento-ia-loading")).toBeTruthy();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

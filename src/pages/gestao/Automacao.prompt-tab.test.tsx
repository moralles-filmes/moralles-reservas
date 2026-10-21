// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Automacao from "./Automacao";
import { STORE_TEXT_LIMITS } from "../../../supabase/functions/_shared/agent/global-prompt-core";

type Row = { key: string; value: unknown; unit_id: string };

const mocks = vi.hoisted(() => {
  const state = {
    read: { data: [] as unknown, error: null as unknown },
    // Resposta de cada `upsert(row).select()`; o padrão devolve a própria linha.
    write: (row: { key: string }): { data: unknown; error: unknown } => ({ data: [row], error: null }),
    upserts: [] as Array<{ row: Row; options: unknown; selected: boolean }>,
  };
  const from = vi.fn((_table: string) => {
    let current: { row: Row; options: unknown; selected: boolean } | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => {
      if (current) current.selected = true;
      return builder;
    };
    builder.eq = () => builder;
    builder.upsert = (row: Row, options: unknown) => {
      current = { row, options, selected: false };
      state.upserts.push(current);
      return builder;
    };
    builder.then = (resolve: (v: unknown) => unknown) => resolve(current ? state.write(current.row) : state.read);
    return builder;
  });
  const invoke = vi.fn();
  const unit = { id: "unit-a", name: "Unidade A", organization_id: "org-a", organization_name: "Org", default_whatsapp_provider: "datafy" };
  const toast = { success: vi.fn(), error: vi.fn() };
  return { state, from, invoke, unit, toast };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from, functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/useAllUnits", () => ({ useUnitBySlug: () => ({ isLoading: false, data: mocks.unit }) }));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/components/whatsapp/DatafyAdminCard", () => ({ DatafyAdminCard: () => null }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

beforeEach(() => {
  mocks.invoke.mockImplementation((_name, { body }) =>
    Promise.resolve({
      error: null,
      data: body.action === "list" ? { channels: [] } : body.action === "list_provider_metadata" ? { providers: [] } : { success: true },
    }),
  );
});

afterEach(() => {
  cleanup();
  mocks.state.read = { data: [], error: null };
  mocks.state.write = (row) => ({ data: [row], error: null });
  mocks.state.upserts.length = 0;
  vi.clearAllMocks();
});

const settingsRows = (over: Record<string, unknown> = {}) =>
  Object.entries({ agent_mode: "reservations_faq", agent_name: "Yumi", ...over }).map(([key, value]) => ({ key, value }));

async function openPromptTab() {
  const user = userEvent.setup();
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <Automacao />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("tab", { name: "Instruções do agente" }));
  await screen.findByLabelText("Nome do agente");
  return user;
}

const FIELDS = [
  ["agent_name", "Nome do agente"],
  ["restaurant_menu", "Cardápio (URL ou texto)"],
  ["delivery_response", "Resposta sobre delivery / take-away"],
  ["restaurant_extra_info", "Outras informações (estacionamento, contatos, regras da casa)"],
  ["ai_system_prompt", "Instruções adicionais ao agente"],
  ["ai_context_extra", "Observações extras para o bot"],
] as const;

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Salvar configuração" }) as HTMLButtonElement;
/** Texto do contador ligado ao campo por `aria-describedby`. */
const counterOf = (label: string) => {
  const ids = (field(label).getAttribute("aria-describedby") ?? "").split(" ");
  const counterId = ids.find((id) => id.endsWith("-counter"));
  return counterId ? document.getElementById(counterId)?.textContent : undefined;
};
const savedByKey = () => Object.fromEntries(mocks.state.upserts.map((u) => [u.row.key, u.row.value]));

describe("PromptTab: contador e limite nas 7 chaves", () => {
  it.each(FIELDS)("%s: contador com o limite de STORE_TEXT_LIMITS", async (key, label) => {
    await openPromptTab();
    expect(counterOf(label)).toBe(`0/${STORE_TEXT_LIMITS[key]}`);
  });

  it("o campo do nome não leva limite digitado à mão (vem de STORE_TEXT_LIMITS)", async () => {
    await openPromptTab();
    expect(field("Nome do agente").getAttribute("maxlength")).toBe(String(STORE_TEXT_LIMITS.agent_name));
  });

  it.each(FIELDS)("%s: um acima do limite bloqueia Salvar, marca o campo e explica", async (key, label) => {
    await openPromptTab();
    const limit = STORE_TEXT_LIMITS[key];
    fireEvent.change(field(label), { target: { value: "a".repeat(limit) } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(field(label), { target: { value: "a".repeat(limit + 1) } });
    expect(saveButton().disabled).toBe(true);
    expect(field(label).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(`Passou de ${limit} caracteres.`)).toBeTruthy();
  });

  it("o nome é medido já aparado: espaços nas pontas não contam", async () => {
    await openPromptTab();
    fireEvent.change(field("Nome do agente"), { target: { value: `  ${"a".repeat(STORE_TEXT_LIMITS.agent_name)}  ` } });
    expect(counterOf("Nome do agente")).toBe(`${STORE_TEXT_LIMITS.agent_name}/${STORE_TEXT_LIMITS.agent_name}`);
    expect(saveButton().disabled).toBe(false);
  });

  it("modo fora de AGENT_MODES bloqueia Salvar com aviso", async () => {
    mocks.state.read = { data: settingsRows({ agent_mode: "modo_antigo" }), error: null };
    await openPromptTab();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Escolha o modo do agente.")).toBeTruthy();
  });
});

describe("PromptTab: salvar", () => {
  it("grava as 7 chaves com .select(), conferindo a linha devolvida", async () => {
    const user = await openPromptTab();
    fireEvent.change(field("Cardápio (URL ou texto)"), { target: { value: "Rodízio" } });
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Configuração do agente salva."));
    expect(Object.keys(savedByKey()).sort()).toEqual(
      ["agent_mode", "agent_name", "ai_context_extra", "ai_system_prompt", "delivery_response", "restaurant_extra_info", "restaurant_menu"],
    );
    expect(savedByKey().restaurant_menu).toBe("Rodízio");
    expect(mocks.state.upserts.every((u) => u.selected)).toBe(true);
    expect(mocks.state.upserts.every((u) => JSON.stringify(u.options) === JSON.stringify({ onConflict: "unit_id,key" }))).toBe(true);
  });

  it("normaliza \\r\\n e \\r de dado legado antes de gravar e mede o texto já normalizado", async () => {
    // O navegador normaliza o que o usuário digita; o `\r` só chega por dado legado já salvo.
    mocks.state.read = {
      data: settingsRows({
        restaurant_menu: "linha 1\r\nlinha 2\rlinha 3",
        ai_system_prompt: "a\r\nb",
      }),
      error: null,
    };
    const user = await openPromptTab();
    expect(counterOf("Cardápio (URL ou texto)")).toBe(`${"linha 1\nlinha 2\nlinha 3".length}/${STORE_TEXT_LIMITS.restaurant_menu}`);
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
    expect(savedByKey().restaurant_menu).toBe("linha 1\nlinha 2\nlinha 3");
    expect(savedByKey().ai_system_prompt).toBe("a\nb");
  });

  it("o nome continua aparado ao gravar", async () => {
    const user = await openPromptTab();
    fireEvent.change(field("Nome do agente"), { target: { value: "  Sakura  " } });
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
    expect(savedByKey().agent_name).toBe("Sakura");
  });

  it("uma chave inválida: NENHUMA das 7 é gravada (sem gravação parcial)", async () => {
    const user = await openPromptTab();
    fireEvent.change(field("Observações extras para o bot"), {
      target: { value: "a".repeat(STORE_TEXT_LIMITS.ai_context_extra + 1) },
    });
    // O botão já está bloqueado; mesmo assim o clique não pode gravar nada.
    await user.click(saveButton());
    fireEvent.click(saveButton());
    expect(mocks.state.upserts).toEqual([]);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "Sem permissão para editar estes textos."],
    ["22023", "Texto acima do limite ou com caracteres inválidos."],
    ["XX000", "Não foi possível salvar. Tente novamente."],
  ])("erro %s do banco mostra a cópia por código, uma vez, nunca a mensagem crua", async (code, copy) => {
    mocks.state.write = () => ({ data: null, error: { code, message: "linha rejeitada: cardápio secreto" } });
    const user = await openPromptTab();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(copy));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.toast.error.mock.calls)).not.toContain("cardápio secreto");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("linha não gravada (error nulo, zero linhas) é erro, não sucesso", async () => {
    mocks.state.write = () => ({ data: [], error: null });
    const user = await openPromptTab();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Nenhuma alteração foi gravada."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajustes from "./Ajustes";
import { STORE_TEXT_LIMITS } from "../../../../supabase/functions/_shared/agent/global-prompt-core";

type Row = { unit_id: string; key: string; value: unknown };

const mocks = vi.hoisted(() => {
  const state = {
    read: { data: [] as unknown, error: null as unknown },
    write: (rows: unknown[]): { data: unknown; error: unknown } => ({ data: rows, error: null }),
    upserts: [] as Array<{ rows: Row[]; options: unknown; selected: boolean }>,
  };
  const from = vi.fn((_table: string) => {
    let current: { rows: Row[]; options: unknown; selected: boolean } | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = () => {
      if (current) current.selected = true;
      return builder;
    };
    builder.eq = () => builder;
    builder.in = () => builder;
    builder.upsert = (rows: Row[], options: unknown) => {
      current = { rows, options, selected: false };
      state.upserts.push(current);
      return builder;
    };
    builder.then = (resolve: (v: unknown) => unknown) => resolve(current ? state.write(current.rows) : state.read);
    return builder;
  });
  const toast = { success: vi.fn(), error: vi.fn() };
  return { state, from, toast };
});

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));
vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => ({ unit_id: "unit-a" }) }));
vi.mock("./Saloes", () => ({ BreadcrumbReservas: () => null }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

afterEach(() => {
  cleanup();
  mocks.state.read = { data: [], error: null };
  mocks.state.write = (rows) => ({ data: rows, error: null });
  mocks.state.upserts.length = 0;
  vi.clearAllMocks();
});

async function openAjustes() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <Ajustes />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Regras e Condições");
  return user;
}

const rules = () => screen.getByLabelText("Regras e Condições") as HTMLTextAreaElement;
const info = () => screen.getByLabelText("Informações adicionais") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
const counterOf = (el: HTMLElement) => {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ");
  const counterId = ids.find((id) => id.endsWith("-counter"));
  return counterId ? document.getElementById(counterId)?.textContent : undefined;
};
const saved = () => Object.fromEntries((mocks.state.upserts[0]?.rows ?? []).map((r) => [r.key, r.value]));

describe("Ajustes: textos do agente (Regras e Condições, Informações adicionais)", () => {
  it("mostra contador com o limite de STORE_TEXT_LIMITS nos dois", async () => {
    await openAjustes();
    expect(counterOf(rules())).toBe(`0/${STORE_TEXT_LIMITS.rules_and_conditions}`);
    expect(counterOf(info())).toBe(`0/${STORE_TEXT_LIMITS.additional_info}`);
  });

  it.each([
    ["rules_and_conditions", rules],
    ["additional_info", info],
  ] as const)("%s: um acima do limite bloqueia Salvar, marca o campo e explica; o limite exato vale", async (key, el) => {
    await openAjustes();
    const limit = STORE_TEXT_LIMITS[key];
    fireEvent.change(el(), { target: { value: "a".repeat(limit) } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(el(), { target: { value: "a".repeat(limit + 1) } });
    expect(saveButton().disabled).toBe(true);
    expect(el().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(`Passou de ${limit} caracteres.`)).toBeTruthy();
    fireEvent.click(saveButton());
    expect(mocks.state.upserts).toEqual([]);
  });

  it("dado legado acima do limite já abre bloqueado (não grava o lote com texto que o banco recusaria)", async () => {
    mocks.state.read = {
      data: [{ key: "rules_and_conditions", value: "a".repeat(STORE_TEXT_LIMITS.rules_and_conditions + 1) }],
      error: null,
    };
    await openAjustes();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(`Passou de ${STORE_TEXT_LIMITS.rules_and_conditions} caracteres.`)).toBeTruthy();
  });

  it("mede já aparado e normalizado: espaços e \\r\\n nas pontas não contam", async () => {
    await openAjustes();
    const limit = STORE_TEXT_LIMITS.additional_info;
    fireEvent.change(info(), { target: { value: `  ${"a".repeat(limit)}\n  ` } });
    expect(counterOf(info())).toBe(`${limit}/${limit}`);
    expect(saveButton().disabled).toBe(false);
  });

  it("grava o lote de 7 num upsert com .select(), normalizando \\r (dado legado) antes de aparar", async () => {
    // O navegador normaliza o que se digita; o `\r` só chega por dado legado já salvo.
    mocks.state.read = {
      data: [
        { key: "rules_and_conditions", value: "  linha 1\r\nlinha 2\rlinha 3  " },
        { key: "additional_info", value: "a\r\nb" },
      ],
      error: null,
    };
    const user = await openAjustes();
    expect(counterOf(rules())).toBe(`${"linha 1\nlinha 2\nlinha 3".length}/${STORE_TEXT_LIMITS.rules_and_conditions}`);
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Ajustes salvos."));
    expect(mocks.state.upserts).toHaveLength(1);
    expect(mocks.state.upserts[0].rows).toHaveLength(7);
    expect(mocks.state.upserts[0].selected).toBe(true);
    expect(JSON.stringify(mocks.state.upserts[0].options)).toBe(JSON.stringify({ onConflict: "unit_id,key" }));
    expect(saved().rules_and_conditions).toBe("linha 1\nlinha 2\nlinha 3");
    expect(saved().additional_info).toBe("a\nb");
  });

  it.each([0, 6])("volta %i linhas em vez de 7 (error nulo): erro, não sucesso", async (n) => {
    mocks.state.write = (rows) => ({ data: rows.slice(0, n), error: null });
    const user = await openAjustes();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Nenhuma alteração foi gravada."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "Sem permissão para editar estes textos."],
    ["22023", "Texto acima do limite ou com caracteres inválidos."],
    ["XX000", "Não foi possível salvar. Tente novamente."],
  ])("erro %s do banco mostra a cópia por código, nunca a mensagem crua", async (code, copy) => {
    mocks.state.write = () => ({ data: null, error: { code, message: "linha rejeitada: regras secretas" } });
    const user = await openAjustes();
    await user.click(saveButton());
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(copy));
    expect(JSON.stringify(mocks.toast.error.mock.calls)).not.toContain("regras secretas");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

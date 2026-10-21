// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlatformAgenteIa from "./AgenteIa";

const ME = "11111111-aaaa-bbbb-cccc-111111111111";
const OTHER = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";

const version = (n: number, over: Record<string, unknown> = {}) => ({
  id: `v${n}`,
  slot: "global_persona",
  version: n,
  body: `corpo da versão ${n}`,
  note: `motivo da versão ${n}`,
  created_at: "2026-10-20T15:30:00Z",
  created_by: ME,
  ...over,
});

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  slotRefetch: vi.fn(),
  listRefetch: vi.fn(),
  fetchNextPage: vi.fn(),
  publish: vi.fn(),
  activate: vi.fn(),
  slot: {} as Record<string, unknown>,
  list: {} as Record<string, unknown>,
  publishState: { isPending: false },
  activateState: { isPending: false },
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: ME } }) }));
vi.mock("@/hooks/useAiPromptVersions", () => ({
  useAiPromptSlot: () => ({ ...mocks.slot, refetch: mocks.slotRefetch }),
  useAiPromptVersionList: () => ({ ...mocks.list, refetch: mocks.listRefetch, fetchNextPage: mocks.fetchNextPage }),
  usePublishAiPromptVersion: () => ({ mutate: mocks.publish, ...mocks.publishState }),
  useActivateAiPromptVersion: () => ({ mutate: mocks.activate, ...mocks.activateState }),
}));

const ACTIVE = version(3, { body: "Você é {{agent_name}} do {{restaurant_name}}.\nSeja breve." });

function setSlot(over: Record<string, unknown> = {}) {
  mocks.slot = {
    isLoading: false,
    isError: false,
    data: { activeVersionId: "v3", activatedAt: "2026-10-21T10:00:00Z", activatedBy: ME, active: ACTIVE },
    ...over,
  };
}
function setList(over: Record<string, unknown> = {}) {
  mocks.list = {
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    data: { pages: [[ACTIVE, version(2, { created_by: OTHER }), version(1, { created_by: null })]] },
    ...over,
  };
}

beforeEach(() => {
  setSlot();
  setList();
  mocks.publishState.isPending = false;
  mocks.activateState.isPending = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const editor = () => screen.getByLabelText("Texto do prompt global") as HTMLTextAreaElement;
const publishButton = () => screen.getByRole("button", { name: "Publicar" }) as HTMLButtonElement;
const type = (value: string) => fireEvent.change(editor(), { target: { value } });

/** Abre a confirmação de publicar com um texto válido e devolve o botão de confirmar. */
function openPublishDialog(value = "texto novo") {
  type(value);
  fireEvent.click(publishButton());
  const dialog = screen.getByRole("dialog");
  return {
    dialog,
    note: within(dialog).getByLabelText("Motivo") as HTMLTextAreaElement,
    confirm: within(dialog).getByRole("button", { name: "Publicar" }) as HTMLButtonElement,
  };
}

describe("Agente de IA — versão ativa e editor", () => {
  it("mostra o cabeçalho, a cópia de propagação e a versão ativa", () => {
    render(<PlatformAgenteIa />);
    expect(screen.getByRole("heading", { name: "Agente de IA — prompt global" })).toBeTruthy();
    expect(screen.getByText(/A mudança vale para todas as lojas em até 1 minuto/)).toBeTruthy();
    expect(screen.getByText(/só a persona e o tom/)).toBeTruthy();
    const card = screen.getByText("Versão ativa").closest('[class*="rounded"]') as HTMLElement;
    expect(within(card).getByText("v3")).toBeTruthy();
    expect(within(card).getByText("Você")).toBeTruthy();
    expect(within(card).getByText("motivo da versão 3")).toBeTruthy();
    expect(within(card).getByText(new Date("2026-10-20T15:30:00Z").toLocaleString("pt-BR"))).toBeTruthy();
  });

  it("o editor começa com o corpo ativo e o contador conta code points", () => {
    render(<PlatformAgenteIa />);
    expect(editor().value).toBe(ACTIVE.body);
    expect(screen.getByTestId("prompt-counter").textContent).toBe(`${Array.from(ACTIVE.body).length}/4000`);
    type("😀😀");
    expect(screen.getByTestId("prompt-counter").textContent).toBe("2/4000");
  });

  it("lista as variáveis aceitas", () => {
    render(<PlatformAgenteIa />);
    expect(screen.getByText("{{agent_name}}")).toBeTruthy();
    expect(screen.getByText("{{restaurant_name}}")).toBeTruthy();
  });

  it("a pré-visualização troca os placeholders pelos nomes de exemplo", () => {
    render(<PlatformAgenteIa />);
    expect(screen.getByTestId("prompt-preview").textContent).toBe("Você é Yumi do Restaurante Exemplo.\nSeja breve.");
    type("Oi, sou {{agent_name}}");
    expect(screen.getByTestId("prompt-preview").textContent).toBe("Oi, sou Yumi");
  });
});

describe("Agente de IA — publicar", () => {
  it("Publicar fica bloqueado quando o corpo é igual ao ativo", () => {
    render(<PlatformAgenteIa />);
    expect(publishButton().disabled).toBe(true);
  });

  it.each([
    ["placeholder desconhecido", "oi {{outro}}"],
    ["delimitador <<<", "oi <<< x"],
    ["delimitador >>>", "oi >>> x"],
    ["vazio", ""],
    ["só espaços", "   \n  "],
    ["4001 caracteres", "a".repeat(4001)],
    ["caractere de controle", "oi\u0007"],
  ])("Publicar fica bloqueado com corpo inválido: %s", (_nome, valor) => {
    render(<PlatformAgenteIa />);
    type(valor);
    expect(publishButton().disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("4000 caracteres ainda publica; 4001 passa do limite no contador", () => {
    render(<PlatformAgenteIa />);
    type("a".repeat(4000));
    expect(publishButton().disabled).toBe(false);
    type("a".repeat(4001));
    expect(screen.getByTestId("prompt-counter").textContent).toBe("4001/4000");
    expect(screen.getByRole("alert").textContent).toMatch(/Passou de 4000/);
  });

  it("o motivo é obrigatório: vazio, só espaços e acima de 280 bloqueiam a confirmação", () => {
    render(<PlatformAgenteIa />);
    const { note, confirm } = openPublishDialog();
    expect(confirm.disabled).toBe(true);
    fireEvent.change(note, { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(note, { target: { value: "a".repeat(281) } });
    expect(confirm.disabled).toBe(true);
    expect(within(screen.getByRole("dialog")).getByText("281/280")).toBeTruthy();
    fireEvent.change(note, { target: { value: "a".repeat(280) } });
    expect(confirm.disabled).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("a confirmação mostra o diff contra a ativa", () => {
    render(<PlatformAgenteIa />);
    const { dialog } = openPublishDialog("Você é {{agent_name}} do {{restaurant_name}}.\nSeja simpática.");
    const rows = within(dialog).getAllByText(/Seja|Você é/).map((el) => [el.getAttribute("data-kind"), el.textContent]);
    expect(rows).toEqual([
      ["same", "  Você é {{agent_name}} do {{restaurant_name}}."],
      ["remove", "- Seja breve."],
      ["add", "+ Seja simpática."],
    ]);
  });

  it("o corpo gravado e contado é normalizado (\\r\\n e \\r viram \\n) mesmo se o campo devolver CR", () => {
    render(<PlatformAgenteIa />);
    // O textarea do navegador e do jsdom já normaliza o valor; força um campo que devolve CR cru.
    const field = editor();
    Object.defineProperty(field, "value", { configurable: true, get: () => "a\r\nb\rc", set: () => undefined });
    fireEvent.change(field);
    expect(screen.getByTestId("prompt-counter").textContent).toBe("5/4000");
    fireEvent.click(publishButton());
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "m" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publicar" }));
    expect(mocks.publish.mock.calls[0][0].body).toBe("a\nb\nc");
  });

  it("publica com o id esperado e o motivo", () => {
    render(<PlatformAgenteIa />);
    const { note, confirm } = openPublishDialog("a\nb");
    fireEvent.change(note, { target: { value: "ajuste de tom" } });
    fireEvent.click(confirm);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls[0][0]).toEqual({
      body: "a\nb",
      note: "ajuste de tom",
      expectedActiveVersionId: "v3",
    });
  });

  it("sucesso: toast, confirmação fecha e o editor volta ao corpo ativo", () => {
    mocks.publish.mockImplementation((_vars, opts) => opts.onSuccess());
    render(<PlatformAgenteIa />);
    const { note, confirm } = openPublishDialog();
    fireEvent.change(note, { target: { value: "motivo" } });
    fireEvent.click(confirm);
    expect(mocks.toastSuccess).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor().value).toBe(ACTIVE.body);
  });

  it("40001 mostra a cópia de conflito e fecha a confirmação, mantendo o texto digitado", () => {
    mocks.publish.mockImplementation((_vars, opts) =>
      opts.onError({ code: "40001", message: "prompt_version_conflict" }),
    );
    render(<PlatformAgenteIa />);
    const { note, confirm } = openPublishDialog("meu texto");
    fireEvent.change(note, { target: { value: "motivo" } });
    fireEvent.click(confirm);
    expect(mocks.toastError).toHaveBeenCalledWith("Outra pessoa publicou uma versão. Recarregue antes de publicar.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor().value).toBe("meu texto");
  });

  it("outro erro mostra a cópia mapeada, sem a mensagem crua, e mantém a confirmação aberta", () => {
    mocks.publish.mockImplementation((_vars, opts) =>
      opts.onError({ code: "XX000", message: "detalhe interno sk-ant-123" }),
    );
    render(<PlatformAgenteIa />);
    const { note, confirm } = openPublishDialog();
    fireEvent.change(note, { target: { value: "motivo" } });
    fireEvent.click(confirm);
    expect(mocks.toastError).toHaveBeenCalledWith("Não foi possível concluir. Tente novamente.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("Agente de IA — histórico", () => {
  it("lista as versões com número, data, autor, motivo e marca Ativa", () => {
    render(<PlatformAgenteIa />);
    const v3 = screen.getByTestId("version-3");
    expect(within(v3).getByText("Ativa")).toBeTruthy();
    expect(within(v3).getByText(/Você/)).toBeTruthy();
    expect(within(screen.getByTestId("version-2")).getByText(/Admin 9f8e7d6c/)).toBeTruthy();
    expect(within(screen.getByTestId("version-1")).getByText(/Sistema \(versão inicial\)/)).toBeTruthy();
    expect(within(screen.getByTestId("version-2")).getByText("motivo da versão 2")).toBeTruthy();
    expect(within(screen.getByTestId("version-2")).queryByText("Ativa")).toBeNull();
  });

  it("Restaurar não aparece na ativa, aparece nas outras", () => {
    render(<PlatformAgenteIa />);
    expect(within(screen.getByTestId("version-3")).queryByRole("button", { name: "Restaurar esta versão" })).toBeNull();
    expect(within(screen.getByTestId("version-2")).getByRole("button", { name: "Restaurar esta versão" })).toBeTruthy();
  });

  it("Ver diff mostra a versão contra a ativa", () => {
    render(<PlatformAgenteIa />);
    fireEvent.click(within(screen.getByTestId("version-1")).getByRole("button", { name: "Ver diff" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("- Você é {{agent_name}} do {{restaurant_name}}.")).toBeTruthy();
    expect(within(dialog).getByText("+ corpo da versão 1")).toBeTruthy();
  });

  it("Restaurar exige motivo e chama a RPC de ativar com o id esperado", () => {
    render(<PlatformAgenteIa />);
    fireEvent.click(within(screen.getByTestId("version-1")).getByRole("button", { name: "Restaurar esta versão" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Restaurar" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "voltar ao tom original" } });
    fireEvent.click(confirm);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate.mock.calls[0][0]).toEqual({
      versionId: "v1",
      expectedActiveVersionId: "v3",
      note: "voltar ao tom original",
    });
  });

  it("40001 ao restaurar mostra a cópia de conflito", () => {
    mocks.activate.mockImplementation((_vars, opts) => opts.onError({ code: "40001", message: "x" }));
    render(<PlatformAgenteIa />);
    fireEvent.click(within(screen.getByTestId("version-1")).getByRole("button", { name: "Restaurar esta versão" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "m" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restaurar" }));
    expect(mocks.toastError).toHaveBeenCalledWith("Outra pessoa publicou uma versão. Recarregue antes de publicar.");
  });

  it("Carregar mais aparece só com próxima página e chama fetchNextPage", () => {
    render(<PlatformAgenteIa />);
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
    cleanup();
    setList({ hasNextPage: true });
    render(<PlatformAgenteIa />);
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });
});

describe("Agente de IA — os 4 estados", () => {
  it("slot carregando: skeleton, sem editor", () => {
    setSlot({ isLoading: true, data: undefined });
    const { container } = render(<PlatformAgenteIa />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByLabelText("Texto do prompt global")).toBeNull();
  });

  it("slot com erro: mensagem e Tentar novamente chama refetch", () => {
    setSlot({ isError: true, data: undefined });
    render(<PlatformAgenteIa />);
    expect(screen.queryByLabelText("Texto do prompt global")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(mocks.slotRefetch).toHaveBeenCalled();
  });

  it("slot ausente (antes do db push): estado vazio legível, não tela em branco", () => {
    setSlot({ data: null });
    render(<PlatformAgenteIa />);
    expect(screen.getByText(/ainda não foi inicializado/)).toBeTruthy();
    expect(screen.queryByLabelText("Texto do prompt global")).toBeNull();
  });

  it("histórico carregando: skeleton", () => {
    setList({ isLoading: true, data: undefined });
    const { container } = render(<PlatformAgenteIa />);
    expect(screen.getByText("Histórico").closest('[class*="rounded"]')?.querySelector(".animate-pulse")).not.toBeNull();
    expect(container).toBeTruthy();
  });

  it("histórico com erro: Tentar novamente chama refetch da lista", () => {
    setList({ isError: true, data: undefined });
    render(<PlatformAgenteIa />);
    expect(screen.getByText("Não foi possível carregar o histórico.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(mocks.listRefetch).toHaveBeenCalled();
    expect(mocks.slotRefetch).not.toHaveBeenCalled();
  });

  it("histórico vazio: mensagem própria", () => {
    setList({ data: { pages: [[]] } });
    render(<PlatformAgenteIa />);
    expect(screen.getByText("Nenhuma versão publicada ainda.")).toBeTruthy();
  });
});

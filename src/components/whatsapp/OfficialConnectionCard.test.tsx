// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialConnectionCard } from "./OfficialConnectionCard";
import { DATAFY_CONNECT_ORIGIN } from "../../../supabase/functions/_shared/datafy-onboarding-core";

const READY = { step: "ready_to_connect", granted: true, items: [], templatesPending: true, migration: null as { fromProvider: string } | null };
const mocks = vi.hoisted(() => ({ start: vi.fn(), confirm: vi.fn(), error: vi.fn(), data: null as unknown }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@/hooks/useOfficialConnection", () => ({ useOfficialConnection: () => ({
  data: mocks.data,
  start: mocks.start, confirm: mocks.confirm,
}) }));
const MIGRATION_WARNING = "Ao conectar, o WhatsApp desconecta os aparelhos vinculados, inclusive a automação atual. Logo depois, gere um novo QR Code em Conexão atual e escaneie para a automação voltar. Faça num horário de pouco movimento.";
const message = (origin = DATAFY_CONNECT_ORIGIN, coexistence = true) => window.dispatchEvent(new MessageEvent("message", {
  origin, data: { source: "datafy", event: "connected", data: { coexistence } },
}));

describe("OfficialConnectionCard", () => {
  let popup: Window;
  beforeEach(() => {
    vi.clearAllMocks();
    popup = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    mocks.start.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(undefined);
    mocks.data = READY;
  });
  it.each(["ready_to_connect", "connecting"])("migração avisa a queda antes de conectar (%s)", (step) => {
    mocks.data = { ...READY, step, migration: { fromProvider: "uazapi" } };
    render(<OfficialConnectionCard unitId="u1" />);
    expect(screen.getByRole("note").textContent).toBe(MIGRATION_WARNING);
    expect(screen.getByRole("button", { name: "Conectar WhatsApp oficial" })).toBeTruthy();
  });
  it("sem migração não mostra o aviso de queda", () => {
    render(<OfficialConnectionCard unitId="u1" />);
    expect(screen.queryByText(MIGRATION_WARNING)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });
  it.each(["subscription_pending", "awaiting_echo"])("migração depois de conectar não repete o aviso (%s)", (step) => {
    mocks.data = { ...READY, step, granted: false, migration: { fromProvider: "uazapi" } };
    render(<OfficialConnectionCard unitId="u1" />);
    expect(screen.queryByText(MIGRATION_WARNING)).toBeNull();
    expect(screen.getByRole("button", { name: "Já concluí a conexão" })).toBeTruthy();
  });
  it("awaiting_cutover informa que a troca é do suporte e não oferece ação", () => {
    mocks.data = { ...READY, step: "awaiting_cutover", granted: false, migration: { fromProvider: "uazapi" } };
    render(<OfficialConnectionCard unitId="u1" />);
    expect(screen.getByText("Canal oficial pronto. A troca será feita pelo suporte.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(MIGRATION_WARNING)).toBeNull();
    expect(screen.queryByText("Envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato")).toBeNull();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("abre a janela antes de start resolver e não renderiza link", async () => {
    let resolve: () => void;
    mocks.start.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
    render(<OfficialConnectionCard unitId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }));
    expect(window.open).toHaveBeenCalledWith("about:blank", "datafy-conexao", "width=600,height=760");
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(window.open).mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
    expect(document.body.innerHTML).not.toContain("ct_");
    await act(async () => resolve());
  });
  it("ignora origem errada e confirma evento válido uma vez enquanto pendente", async () => {
    mocks.confirm.mockImplementation(() => new Promise(() => undefined));
    render(<OfficialConnectionCard unitId="u1" />);
    act(() => message("https://evil.test"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    act(() => { message(); message(); });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Já concluí a conexão" }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it("avisa sobre conexão sem app sem confirmar automaticamente", async () => {
    render(<OfficialConnectionCard unitId="u1" />);
    act(() => message(DATAFY_CONNECT_ORIGIN, false));
    expect(screen.getByRole("alert").textContent).toContain("Este número foi conectado sem o app WhatsApp Business");
    expect(mocks.confirm).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Já concluí a conexão" })));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it("confirma start next confirm e fecha janela; erro fecha janela", async () => {
    mocks.start.mockResolvedValueOnce("confirm").mockRejectedValueOnce(new Error("falha"));
    render(<OfficialConnectionCard unitId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(popup.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }));
    await waitFor(() => expect(popup.close).toHaveBeenCalledTimes(2));
    expect(mocks.error).toHaveBeenCalled();
  });
  it("troca de unidade invalida resposta em voo e não confirma a unidade anterior", async () => {
    let resolve: (next: string) => void;
    let current: () => boolean;
    mocks.start.mockImplementation((_popup, isCurrent) => {
      current = isCurrent;
      return new Promise((r) => { resolve = r; });
    });
    const view = render(<OfficialConnectionCard unitId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }));
    expect(current()).toBe(true);
    view.rerender(<OfficialConnectionCard unitId="u2" />);
    expect(current()).toBe(false);
    await act(async () => resolve("confirm"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    act(() => message());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  });
  it("popup bloqueado não inicia ação; evento error mostra copy fixa", () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(<OfficialConnectionCard unitId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar WhatsApp oficial" }));
    expect(mocks.start).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: DATAFY_CONNECT_ORIGIN, data: { source: "datafy", event: "error" } })));
    expect(mocks.error).toHaveBeenLastCalledWith("A conexão não foi concluída. Tente de novo na janela da Datafy.");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useConversations } from "@/hooks/useConversations";
import { ConversationsWaitingPanel } from "./ConversationsWaitingPanel";

vi.mock("@/hooks/useConversations", () => ({ useConversations: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function show(state: Record<string, unknown> = {}) {
  const refetch = vi.fn();
  vi.mocked(useConversations).mockReturnValue({ data: [], isLoading: false, isError: false, refetch, ...state } as unknown as ReturnType<typeof useConversations>);
  render(<MemoryRouter><ConversationsWaitingPanel unitId="unit" unitSlug="casa" /></MemoryRouter>);
  return refetch;
}

describe("ConversationsWaitingPanel", () => {
  it("carregando", () => {
    show({ isLoading: true });
    expect(screen.getByTestId("conversations-skeleton")).toBeTruthy();
  });
  it("erro", () => {
    const refetch = show({ isError: true });
    expect(screen.getByText("Não foi possível carregar as conversas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
  it("vazio", () => {
    show();
    expect(screen.getByText("Nenhuma conversa aguardando resposta")).toBeTruthy();
  });
  it("lista", () => {
    show({ data: [{ id: "1", contact_name: "Maria", last_message_at: new Date().toISOString() }] });
    expect(screen.getByText("Maria")).toBeTruthy();
    expect(screen.getByText("Aguardando atendente")).toBeTruthy();
    expect(useConversations).toHaveBeenCalledWith("unit", "awaiting_human");
    expect(screen.getByRole("link", { name: "Abrir conversas" }).getAttribute("href")).toBe("/g/casa/conversas");
  });
});

// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Conversas from "./Conversas";

const io = vi.hoisted(() => ({ list: [] as Record<string, unknown>[], loading: false, error: false, info: vi.fn() }));
const unitId = "aaaaaaaa-0000-0000-0000-000000000001";
const mk = (id: string, customer_id: string, name: string, status = "human_active") => ({
  id, unit_id: unitId, customer_id, status, contact_name: name, customer: { phone: "11999999999" },
  last_message_at: "2026-10-16T14:00:00.000Z", updated_at: "2026-10-16T14:00:00.000Z",
});

vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => ({ unit_id: unitId, organization_id: "org", unit_slug: "loja" }) }));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({ data: io.loading || io.error ? undefined : io.list, isLoading: io.loading, isError: io.error, refetch: vi.fn() }),
  useConversationActions: () => ({ assumeConversation: { isPending: false }, releaseToAI: { isPending: false }, markResolved: { isPending: false } }),
}));
vi.mock("@/hooks/useSendManualMessage", () => ({ useSendManualMessage: () => ({ isPending: false, mutate: vi.fn() }) }));
vi.mock("@/hooks/useDebounce", () => ({ useDebounce: (v: string) => v }));
vi.mock("@/hooks/useWhatsappTemplates", () => ({
  useWhatsappTemplates: () => ({ query: { isSuccess: true, isError: false, isFetching: false, refetch: vi.fn(), data: { mode: "unofficial", channelId: "channel" } } }),
}));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/lib/supabase", () => ({ supabase: {
  from: () => { const q: Record<string, unknown> = {}; let id: unknown; q.select = () => q; q.eq = (c: string, v: unknown) => { if (c === "id") id = v; return q; };
    q.single = async () => ({ data: { ...(io.list.find((c) => c.id === id) ?? io.list[0]), messages: [] }, error: null }); return q; },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: io.info } }));

function Loc() { const l = useLocation(); return <div data-testid="loc">{l.search}</div>; }
function Nav() { const n = useNavigate(); return <button onClick={() => n("/g/loja/conversas?cliente=c1")}>ir</button>; }
function mount(search: string) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/g/loja/conversas${search}`]}><Conversas /><Loc /><Nav /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { io.info.mockReset(); io.loading = false; io.error = false; });

describe("Conversas deep link ?cliente=", () => {
  it("abre a conversa do cliente e remove o parâmetro", async () => {
    io.list = [mk("c-a", "c0", "Outro"), mk("c-b", "c1", "Cliente Um")];
    mount("?cliente=c1&x=1");
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("?x=1"));
    await waitFor(() => expect(screen.getAllByText("Cliente Um").length).toBeGreaterThan(1));
    expect(io.info).not.toHaveBeenCalled();
  });

  it("com mais de uma conversa do mesmo cliente, abre a primeira da lista", async () => {
    io.list = [mk("c-a", "c1", "Primeira"), mk("c-b", "c1", "Segunda")];
    mount("?cliente=c1");
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeTruthy());
    expect(screen.getAllByText("Primeira").length).toBeGreaterThan(1);
  });

  it("sem conversa, avisa e remove o parâmetro", async () => {
    io.list = [mk("c-a", "c0", "Outro")];
    mount("?cliente=c1");
    await waitFor(() => expect(io.info).toHaveBeenCalledWith("Ainda não há conversa com este cliente."));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(""));
    expect(io.info).toHaveBeenCalledTimes(1);
  });

  it("não processa enquanto carrega", async () => {
    io.list = []; io.loading = true;
    mount("?cliente=c1");
    expect(io.info).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc").textContent).toBe("?cliente=c1");
  });

  it("uma segunda navegação para o mesmo cliente na página montada reabre a conversa", async () => {
    io.list = [mk("c-b", "c1", "Cliente Um")];
    mount("?cliente=c1");
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(""));
    fireEvent.click(screen.getByLabelText("Voltar para a lista"));
    await waitFor(() => expect(screen.queryByPlaceholderText(/Digite a mensagem/)).toBeNull());
    fireEvent.click(screen.getByText("ir"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(""));
  });

  it("com erro na lista, não avisa e mantém o parâmetro", () => {
    io.list = []; io.error = true;
    mount("?cliente=c1");
    expect(io.info).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc").textContent).toBe("?cliente=c1");
  });
});

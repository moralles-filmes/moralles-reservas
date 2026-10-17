// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Conversas from "./Conversas";

const io = vi.hoisted(() => ({
  mode: "official" as "official" | "unofficial" | "unavailable",
  snapshotError: false,
  detail: null as null | Record<string, unknown>,
  detailPending: false,
  detailError: false,
  hidden: false,
  channelRefetch: vi.fn(),
  send: vi.fn(),
}));
const id = "bbbbbbbb-0000-0000-0000-000000000001";
const unitId = "aaaaaaaa-0000-0000-0000-000000000001";
const list = { id, unit_id: unitId, customer_id: "customer", status: "human_active", contact_name: "Cliente Teste",
  customer: { phone: "11999999999" }, last_message_at: "2026-10-16T14:00:00.000Z", updated_at: "2026-10-16T14:00:00.000Z" };

vi.mock("@/hooks/useCurrentUnit", () => ({ useCurrentUnit: () => ({ unit_id: unitId, organization_id: "org", unit_slug: "loja" }) }));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({ data: [list], isLoading: false, isError: false, refetch: vi.fn() }),
  useConversationActions: () => ({ assumeConversation: { isPending: false }, releaseToAI: { isPending: false }, markResolved: { isPending: false } }),
}));
vi.mock("@/hooks/useSendManualMessage", () => ({ useSendManualMessage: () => ({ isPending: false, mutate: io.send }) }));
vi.mock("@/hooks/useDebounce", () => ({ useDebounce: (value: string) => value }));
vi.mock("@/hooks/useWhatsappTemplates", async () => {
  const { useCallback, useState } = await import("react");
  return { useWhatsappTemplates: () => {
    const [, refresh] = useState(0);
    const refetch = useCallback(async () => { io.channelRefetch(); refresh(value => value + 1); }, []);
    return { query: {
      isSuccess: !io.snapshotError, isError: io.snapshotError, isFetching: false, refetch,
      data: io.snapshotError ? undefined : { mode: io.mode, channelId: io.mode === "unavailable" ? null : "channel" },
    } };
  } };
});
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/lib/supabase", () => ({ supabase: {
  from: () => { const query = {
    select: () => query, eq: () => query,
    single: async () => {
      if (io.detailPending) return new Promise(() => {});
      if (io.detailError) return { data: null, error: new Error("synthetic") };
      return { data: io.detail, error: null };
    },
  }; return query; },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn(),
} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  io.mode = "official"; io.snapshotError = false; io.detailPending = false; io.detailError = false; io.hidden = false;
  io.send.mockReset(); io.channelRefetch.mockReset();
  vi.spyOn(document, "hidden", "get").mockImplementation(() => io.hidden);
  io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString() }] };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Conversas /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(screen.getByText("Cliente Teste"));
  return client;
}

describe("Conversas service window", () => {
  it("blocks official reply until canonical detail arrives, even if the list has a recent last_message_at", () => {
    io.detailPending = true;
    mount();
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
    expect(io.send).not.toHaveBeenCalled();
  });

  it("does not trust a cached detail while its canonical refresh is pending", () => {
    io.detailPending = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["conversation-detail", id], io.detail);
    mount(client);
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
  });

  it("blocks official reply when detail or authorized channel snapshot fails", async () => {
    io.detailError = true;
    mount();
    await screen.findByText("Não foi possível carregar as mensagens.");
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
  });

  it("keeps the composer closed when the channel snapshot fails", async () => {
    io.snapshotError = true;
    mount();
    await screen.findByText("Oi");
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
  });

  it("closes Meta composer on a stale customer message and allows UazAPI regardless of Datafy preference", async () => {
    io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }] };
    mount();
    await screen.findByText(/A janela de 24 horas da Meta terminou/);
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
  });

  it("allows an unofficial binding with old inbound and disables on snapshot failure", async () => {
    io.mode = "unofficial";
    io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }] };
    mount();
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).not.toBeDisabled());
  });

  it("refreshes the operational binding on focus after a Datafy to UazAPI cutover without remount", async () => {
    io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }] };
    mount();
    await screen.findByText(/A janela de 24 horas da Meta terminou/);
    io.mode = "unofficial";
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).not.toBeDisabled());
    io.mode = "official";
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled());
  });

  it("skips background channel polling and refreshes when the tab becomes visible", async () => {
    io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }] };
    mount();
    await screen.findByText(/A janela de 24 horas da Meta terminou/);
    io.hidden = true;
    io.mode = "unofficial";
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    expect(io.channelRefetch).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled();
    io.hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).not.toBeDisabled());
    expect(io.channelRefetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks the clock without Realtime", async () => {
    io.detail = { ...list, messages: [{ role: "user", content: "Oi", timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000 + 600).toISOString() }] };
    mount();
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).not.toBeDisabled());
    await waitFor(() => expect(screen.getByPlaceholderText(/Digite a mensagem/)).toBeDisabled(), { timeout: 2_500 });
  });
});

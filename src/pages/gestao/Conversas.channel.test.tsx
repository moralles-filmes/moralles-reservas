// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Conversas from "./Conversas";

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({
  list: [] as Record<string, unknown>[],
  detail: null as null | Record<string, unknown>,
  moduleActive: true,
  connection: { state: "success", data: { status: "connected" } } as {
    state: "success" | "error" | "loading";
    data?: { status: string } | null;
  },
  waMode: "unavailable" as "official" | "unofficial" | "unavailable",
  send: vi.fn(),
  sendError: null as null | Error,
}));
const unitId = "aaaaaaaa-0000-0000-0000-000000000001";
const recent = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const old = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const base = { unit_id: unitId, last_message_at: "2026-10-16T14:00:00.000Z", updated_at: "2026-10-16T14:00:00.000Z" };
const wa = (id: string, status: string, name: string): Row => ({
  ...base, id, status, channel: "whatsapp", customer_id: "c-" + id, contact_name: name, customer: { phone: "11999999999" },
});
const ig = (id: string, status: string, name: string, extra: Row = {}): Row => ({
  ...base, id, status, channel: "instagram", customer_id: null, instagram_contact_id: "ic-" + id,
  contact_name: name, customer: null, ...extra,
});

vi.mock("@/hooks/useCurrentUnit", () => ({
  useCurrentUnit: () => ({ unit_id: unitId, organization_id: "org", unit_slug: "loja" }),
}));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({ data: io.list, isLoading: false, isError: false, refetch: vi.fn() }),
  useConversationActions: () => ({
    assumeConversation: { isPending: false }, releaseToAI: { isPending: false }, markResolved: { isPending: false },
  }),
}));
vi.mock("@/hooks/useInstagram", () => ({
  useInstagramModule: () => ({ isSuccess: true, data: { instagram: { active: io.moduleActive, granted_at: null } } }),
  useInstagramConnection: () => ({
    isSuccess: io.connection.state === "success",
    isError: io.connection.state === "error",
    isLoading: io.connection.state === "loading",
    data: io.connection.data,
  }),
}));
vi.mock("@/hooks/useSendManualMessage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSendManualMessage")>()),
  useSendManualMessage: () => ({
  isPending: false,
  mutate: (vars: unknown, opts: { onError?: (e: Error) => void }) => {
    io.send(vars, opts);
    if (io.sendError) opts.onError?.(io.sendError);
  },
}) }));
vi.mock("@/hooks/useDebounce", () => ({ useDebounce: (v: string) => v }));
vi.mock("@/hooks/useWhatsappTemplates", () => ({
  useWhatsappTemplates: () => ({
    query: {
      isSuccess: true, isError: false, isFetching: false, refetch: vi.fn(async () => {}),
      data: { mode: io.waMode, channelId: io.waMode === "unavailable" ? null : "channel" },
    },
  }),
}));
vi.mock("@/components/billing/WhatsappServiceBanner", () => ({ WhatsappServiceBanner: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const q = { select: () => q, eq: () => q, single: async () => ({ data: io.detail, error: null }) };
      return q;
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><MemoryRouter><Conversas /></MemoryRouter></QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  io.moduleActive = true;
  io.connection = { state: "success", data: { status: "connected" } };
  io.waMode = "unavailable";
  io.send.mockReset();
  io.sendError = null;
  io.list = [
    wa("w1", "human_active", "Ana WA"), wa("w2", "awaiting_human", "Bia WA"),
    ig("i1", "human_active", "Caio IG"), ig("i2", "ai_active", "Dani IG"),
  ];
  io.detail = null;
});
afterEach(() => { vi.restoreAllMocks(); });

const chip = (c: string) => screen.getByTestId(`channel-chip-${c}`);

describe("Conversas por canal: filtro e contagens", () => {
  it("título é Conversas e os chips mostram contagem por canal", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Conversas" })).toBeTruthy();
    expect(chip("all").textContent).toContain("Ambos");
    expect(chip("all").textContent).toContain("4");
    expect(chip("whatsapp").textContent).toContain("2");
    expect(chip("instagram").textContent).toContain("2");
  });

  it("chip Instagram filtra a lista e combina com o chip de status", () => {
    mount();
    fireEvent.click(chip("instagram"));
    expect(screen.queryByText("Ana WA")).toBeNull();
    expect(screen.getByText("Caio IG")).toBeTruthy();
    expect(screen.getByText("Dani IG")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Em atendimento/ }));
    expect(screen.getByText("Caio IG")).toBeTruthy();
    expect(screen.queryByText("Dani IG")).toBeNull();
    expect(localStorage.getItem("conversas-channel-filter")).toBe("instagram");
  });

  it("chip WhatsApp + status Aguardando mostra só a interseção", () => {
    mount();
    fireEvent.click(chip("whatsapp"));
    fireEvent.click(screen.getByRole("button", { name: /^Aguardando/ }));
    expect(screen.getByText("Bia WA")).toBeTruthy();
    expect(screen.queryByText("Ana WA")).toBeNull();
    expect(screen.queryByText("Caio IG")).toBeNull();
  });

  it("lista vazia pela combinação mostra o vazio, não branco", () => {
    mount();
    fireEvent.click(chip("instagram"));
    fireEvent.click(screen.getByRole("button", { name: /^Aguardando/ }));
    expect(screen.getByText("Nenhuma conversa nessa categoria.")).toBeTruthy();
  });

  it("lê o filtro salvo e ignora valor inválido", () => {
    localStorage.setItem("conversas-channel-filter", "instagram");
    const { unmount } = mount();
    expect(screen.queryByText("Ana WA")).toBeNull();
    unmount();
    localStorage.setItem("conversas-channel-filter", "lixo");
    mount();
    expect(screen.getByText("Ana WA")).toBeTruthy();
  });

  it("localStorage que lança não quebra a tela", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount();
    fireEvent.click(chip("instagram"));
    expect(screen.getByText("Caio IG")).toBeTruthy();
    expect(screen.queryByText("Ana WA")).toBeNull();
  });

  it("chips ficam ocultos sem módulo e sem conversa IG; aparecem se existir conversa IG", () => {
    io.moduleActive = false;
    io.list = [wa("w1", "human_active", "Ana WA")];
    const { unmount } = mount();
    expect(screen.queryByTestId("channel-chip-all")).toBeNull();
    unmount();
    io.list = [wa("w1", "human_active", "Ana WA"), ig("i1", "human_active", "Caio IG")];
    mount();
    expect(screen.getByTestId("channel-chip-instagram")).toBeTruthy();
  });

  it("filtro salvo não filtra às cegas quando os chips estão ocultos", () => {
    localStorage.setItem("conversas-channel-filter", "instagram");
    io.moduleActive = false;
    io.list = [wa("w1", "human_active", "Ana WA")];
    mount();
    expect(screen.getByText("Ana WA")).toBeTruthy();
  });
});

describe("Conversa do Instagram: envio, copy e identidade", () => {
  const composer = () => screen.getByPlaceholderText(/Digite a mensagem/) as HTMLTextAreaElement;
  const inbound = (ts: string) => [{ role: "user", content: "Oi", timestamp: ts }];
  function openIg(messages: Row[], extra: Row = {}, label = "Caio IG") {
    const row = ig("i1", "human_active", "Caio IG", extra);
    io.list = [row];
    io.detail = { ...row, messages };
    mount();
    fireEvent.click(screen.getByText(label));
  }

  it("permite enviar sem canal WhatsApp na unidade", async () => {
    io.waMode = "unavailable";
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    await waitFor(() => expect(composer().disabled).toBe(false));
    fireEvent.change(composer(), { target: { value: "resposta" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));
    expect(io.send).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "i1", message: "resposta", channel: "instagram" }),
      expect.anything(),
    );
  });

  it("depois de PARTIAL_SEND o composer fica vazio (não reenvia as partes)", async () => {
    io.sendError = Object.assign(new Error("Enviadas 1 de 2 partes da mensagem."), { code: "PARTIAL_SEND", httpStatus: 502 });
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    await waitFor(() => expect(composer().disabled).toBe(false));
    fireEvent.change(composer(), { target: { value: "mensagem longa" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));
    expect(io.send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(composer().value).toBe(""));
  });

  it("outro erro mantém o texto para nova tentativa", async () => {
    io.sendError = Object.assign(new Error("falhou"), { httpStatus: 503 });
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    await waitFor(() => expect(composer().disabled).toBe(false));
    fireEvent.change(composer(), { target: { value: "mensagem" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));
    expect(composer().value).toBe("mensagem");
  });

  it("janela vencida bloqueia com a copy do Instagram", async () => {
    openIg(inbound(old()));
    await screen.findByText(/janela de 24h do Instagram/);
    expect(composer().disabled).toBe(true);
  });

  it("conta com reautenticação pendente bloqueia o envio", async () => {
    io.connection = { state: "success", data: { status: "reauth_required" } };
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    expect(composer().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Peça a um gerente para reconectar/);
  });

  it("sem conta ativa (null) bloqueia com a copy de não conectada", async () => {
    io.connection = { state: "success", data: null };
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    expect(composer().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/não está conectada.*Peça a um gerente/);
  });

  it("leitura da conexão com erro não bloqueia (o servidor é o portão)", async () => {
    io.connection = { state: "error" };
    openIg(inbound(recent()));
    await screen.findByText("Oi");
    await waitFor(() => expect(composer().disabled).toBe(false));
  });

  it("telefone do cliente ligado aparece como declarado e não há link para a ficha", async () => {
    openIg(inbound(recent()), { customer_id: "cust", customer: { name: "Maria", phone: "11988887777" } }, "Maria");
    await screen.findByText("Oi");
    const phones = screen.getAllByText(/\(11\) 98888-7777/);
    expect(phones.length).toBeGreaterThan(0);
    for (const el of phones) expect(el.textContent).toMatch(/declarado/i);
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("a[href*='cliente']")).toBeNull();
  });

  it("conversa WhatsApp não ganha o rótulo declarado", () => {
    io.list = [wa("w1", "human_active", "Ana WA")];
    mount();
    expect(screen.getByText("(11) 99999-9999")).toBeTruthy();
    expect(screen.queryByText(/declarado/i)).toBeNull();
  });

  it("rótulo de canal no item da lista", () => {
    mount();
    expect(within(screen.getByText("Caio IG").closest("button")!).getByLabelText("Instagram")).toBeTruthy();
    expect(within(screen.getByText("Ana WA").closest("button")!).getByLabelText("WhatsApp")).toBeTruthy();
  });
});

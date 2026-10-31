// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_SERVICE_WINDOW_MESSAGE, useSendManualMessage } from "./useSendManualMessage";

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "caller" } }) }));

beforeEach(() => { io.invoke.mockReset(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useSendManualMessage("unit"), { wrapper });
  return { result, invalidate };
}

async function fail(status: number, body: Record<string, unknown>, channel: "whatsapp" | "instagram" = "instagram") {
  io.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify(body), { status })) });
  const { result, invalidate } = setup();
  let error: (Error & { httpStatus?: number }) | null = null;
  await act(async () => {
    try { await result.current.mutateAsync({ conversationId: "c1", message: "oi", channel }); }
    catch (e) { error = e as Error; }
  });
  return { error: error as unknown as Error & { httpStatus?: number }, invalidate };
}

describe("send-manual-message: mensagem por código (Instagram)", () => {
  it("409 INSTAGRAM_NOT_CONNECTED", async () => {
    const { error } = await fail(409, { error: "INSTAGRAM_NOT_CONNECTED" });
    expect(error.message).toMatch(/Instagram não está conectada.*Peça a um gerente/);
  });
  it("409 INSTAGRAM_MODULE_DISABLED", async () => {
    const { error } = await fail(409, { error: "INSTAGRAM_MODULE_DISABLED" });
    expect(error.message).toMatch(/módulo do Instagram.*não está liberado/i);
  });
  it("409 INSTAGRAM_REAUTH_REQUIRED", async () => {
    const { error } = await fail(409, { error: "INSTAGRAM_REAUTH_REQUIRED" });
    expect(error.message).toMatch(/Peça a um gerente para reconectar/);
  });
  it("409 INSTAGRAM_ACCOUNT_RECONNECTED", async () => {
    const { error } = await fail(409, { error: "INSTAGRAM_ACCOUNT_RECONNECTED" });
    expect(error.message).toMatch(/reconectada.*tente enviar de novo/i);
  });
  it("409 OUTSIDE_SERVICE_WINDOW usa a copy do canal", async () => {
    const ig = await fail(409, { error: "OUTSIDE_SERVICE_WINDOW" }, "instagram");
    expect(ig.error.message).toMatch(/janela de 24h do Instagram/);
    const wa = await fail(409, { error: "OUTSIDE_SERVICE_WINDOW" }, "whatsapp");
    expect(wa.error.message).toBe(OUTSIDE_SERVICE_WINDOW_MESSAGE);
  });
  it("502 PARTIAL_SEND informa X de Y partes", async () => {
    const { error } = await fail(502, { error: "PARTIAL_SEND", code: "PARTIAL_SEND", sent: 1, total: 3, outcome_unknown: false });
    expect(error.message).toContain("Enviadas 1 de 3 partes");
    expect(error.message).not.toMatch(/pode ter sido entregue/);
    expect(error.httpStatus).toBe(502);
  });
  it("502 PARTIAL_SEND com outcome_unknown avisa para não reenviar", async () => {
    const { error } = await fail(502, { error: "PARTIAL_SEND", code: "PARTIAL_SEND", sent: 1, total: 3, outcome_unknown: true });
    expect(error.message).toContain("Enviadas 1 de 3 partes");
    expect(error.message).toMatch(/pode ter sido entregue/);
    expect(error.message).toMatch(/não reenvie/i);
  });
  it("503 genérico continua com o texto bruto", async () => {
    const { error } = await fail(503, { error: "Serviço indisponível" });
    expect(error.message).toBe("Serviço indisponível");
  });
});

describe("conexão relida e corpos atípicos", () => {
  it.each(["INSTAGRAM_NOT_CONNECTED", "INSTAGRAM_REAUTH_REQUIRED", "INSTAGRAM_ACCOUNT_RECONNECTED"])("409 %s invalida a conexão", async (code) => {
    const { invalidate } = await fail(409, { error: code });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["instagram-connection", "unit"] });
  });
  it("409 OUTSIDE_SERVICE_WINDOW não invalida a conexão", async () => {
    const { invalidate } = await fail(409, { error: "OUTSIDE_SERVICE_WINDOW" });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["instagram-connection", "unit"] });
  });
  it("PARTIAL_SEND com sent/total não numéricos usa texto genérico", async () => {
    const { error } = await fail(502, { error: "PARTIAL_SEND", code: "PARTIAL_SEND", sent: "1", total: null });
    expect(error.message).toContain("Só parte da mensagem foi enviada.");
    expect(error.message).not.toContain("undefined");
  });
  it("502 que não é JSON cai em HTTP 502", async () => {
    io.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response("<html>bad gateway</html>", { status: 502 })) });
    const { result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ conversationId: "c1", message: "oi", channel: "instagram" })).rejects.toThrow("HTTP 502");
    });
  });
  it("reason herdada do protótipo não vira mensagem", async () => {
    const { error } = await fail(409, { error: "constructor" });
    expect(error.message).toBe("constructor");
  });
});

describe("502 PARTIAL_SEND recarrega a conversa", () => {
  it("invalida o detalhe e a lista de conversas", async () => {
    const { invalidate } = await fail(502, { error: "PARTIAL_SEND", code: "PARTIAL_SEND", sent: 1, total: 2, outcome_unknown: false });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation-detail", "c1"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations", "unit"] });
    });
  });
  it("sem channel informado, WhatsApp segue igual (409 janela)", async () => {
    io.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ error: "OUTSIDE_SERVICE_WINDOW" }), { status: 409 })) });
    const { result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ conversationId: "c1", message: "oi" })).rejects.toThrow(OUTSIDE_SERVICE_WINDOW_MESSAGE);
    });
  });
});

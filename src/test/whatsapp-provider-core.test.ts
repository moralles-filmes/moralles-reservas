import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  buildZApiTextRequest,
  createWhatsAppProviderRegistry,
  mapUazApiConnectionStatus,
  parseWahaConnectionStatus,
  parseUazApiInbound,
  parseUazApiStatus,
  parseZApiInbound,
  parseZApiConnectionCallback,
  parseZApiConnectionStatus,
  parseZApiStatus,
  peekUazApiMedia,
  sendUazApiText,
  type WhatsAppProviderAdapter,
  type WhatsAppProviderName,
} from "../../supabase/functions/_shared/whatsapp-provider-core";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubAdapter(name: WhatsAppProviderName): WhatsAppProviderAdapter {
  return {
    name,
    label: name,
    capabilities: PROVIDER_CAPABILITIES[name],
    parseInbound: () => null,
    peekInboundMedia: () => null,
    parseStatusCallback: () => null,
    sendText: async () => ({ ok: true }),
  };
}

describe("registry WhatsApp", () => {
  it("registra os quatro providers e serializa capabilities para a UI", () => {
    const registry = createWhatsAppProviderRegistry([
      stubAdapter("zapi"),
      stubAdapter("waha"),
      stubAdapter("official"),
      stubAdapter("uazapi"),
    ]);

    expect(registry.list().map((adapter) => adapter.name)).toEqual([
      "zapi",
      "waha",
      "official",
      "uazapi",
    ]);
    expect(registry.get("uazapi").capabilities).toMatchObject({
      automaticProvisioning: true,
      qrConnection: true,
      automaticWebhook: true,
      deliveryReceipts: true,
    });
    expect(registry.metadata()[0]).not.toBe(registry.list()[0]);
  });

  it("falha fechado para provider desconhecido e duplicado", () => {
    const registry = createWhatsAppProviderRegistry([stubAdapter("zapi")]);
    expect(registry.tryGet("nao-existe")).toBeNull();
    expect(() => registry.get("nao-existe")).toThrow("unknown_whatsapp_provider:nao-existe");
    expect(() => createWhatsAppProviderRegistry([stubAdapter("zapi"), stubAdapter("zapi")]))
      .toThrow("duplicate_whatsapp_provider:zapi");
  });
});

describe("caracterização WAHA", () => {
  it("considera apenas WORKING como conectado", () => {
    expect(parseWahaConnectionStatus(200, {
      status: "WORKING",
      me: { id: "5511987654321@c.us" },
    })).toEqual({
      status: "connected",
      nativeStatus: "WORKING",
      connected: true,
      qrRequired: false,
      displayPhone: "11987654321",
    });
    expect(parseWahaConnectionStatus(200, { status: "STOPPED" })).toEqual({
      status: "disconnected",
      nativeStatus: "STOPPED",
      connected: false,
      qrRequired: false,
    });
  });

  it("mapeia estados intermediários e falha fechado para payload inválido", () => {
    expect(parseWahaConnectionStatus(200, { status: "STARTING" }).status).toBe("connecting");
    expect(parseWahaConnectionStatus(200, { status: "SCAN_QR_CODE" })).toMatchObject({
      status: "waiting_qr",
      connected: false,
      qrRequired: true,
    });
    expect(parseWahaConnectionStatus(200, { status: "FAILED" }).status).toBe("error");
    expect(parseWahaConnectionStatus(200, {}).status).toBe("provider_error");
    expect(parseWahaConnectionStatus(503, { status: "WORKING" }).status).toBe("provider_error");
  });
});

describe("caracterização Z-API", () => {
  it("preserva payload inbound, normalização de telefone e bloqueio de eco", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    const payload = {
      messageId: "zapi-message-1",
      phone: "5511987654321",
      senderName: "  Maria  ",
      text: { message: "  Quero reservar  " },
      fromMe: false,
    };

    expect(parseZApiInbound(payload)).toMatchObject({
      providerMessageId: "zapi-message-1",
      fromPhone: "11987654321",
      text: "Quero reservar",
      timestamp: 1_786_968_000_000,
      contactName: "Maria",
    });
    expect(parseZApiInbound({ ...payload, fromMe: true })).toBeNull();
    expect(parseZApiInbound({ ...payload, fromMe: false, isFromMe: true })).toBeNull();
  });

  it("preserva callback de entrega e ignora READ_BY_ME", () => {
    expect(parseZApiStatus({
      type: "MessageStatusCallback",
      status: "RECEIVED",
      ids: ["one", "two"],
    })).toEqual([
      { providerMessageId: "one", status: "delivered" },
      { providerMessageId: "two", status: "delivered" },
    ]);
    expect(parseZApiStatus({
      type: "MessageStatusCallback",
      status: "READ_BY_ME",
      ids: ["one"],
    })).toBeNull();
  });

  it("usa o booleano connected como autoridade no snapshot HTTP", () => {
    expect(parseZApiConnectionStatus(200, { connected: true })).toEqual({
      status: "connected",
      nativeStatus: "connected",
      connected: true,
      qrRequired: false,
    });
    expect(parseZApiConnectionStatus(200, { connected: false })).toEqual({
      status: "disconnected",
      nativeStatus: "disconnected",
      connected: false,
      qrRequired: false,
    });
  });

  it("falha fechado para HTTP não-2xx e payload de status inválido", () => {
    expect(parseZApiConnectionStatus(401, { connected: true })).toEqual({
      status: "provider_error",
      nativeStatus: "http_401",
      connected: false,
      qrRequired: false,
    });
    expect(parseZApiConnectionStatus(200, {})).toEqual({
      status: "provider_error",
      nativeStatus: "invalid_payload",
      connected: false,
      qrRequired: false,
    });
  });

  it("normaliza callbacks documentados de conexão e desconexão", () => {
    expect(parseZApiConnectionCallback({
      type: "ConnectedCallback",
      connected: true,
      phone: "5511987654321",
    })).toEqual({
      status: "connected",
      nativeStatus: "ConnectedCallback",
      connected: true,
      qrRequired: false,
      displayPhone: "11987654321",
    });
    expect(parseZApiConnectionCallback({
      type: "DisconnectedCallback",
      disconnected: true,
    })).toEqual({
      status: "disconnected",
      nativeStatus: "DisconnectedCallback",
      connected: false,
      qrRequired: false,
      displayPhone: null,
    });
  });

  it("ignora callbacks alheios ou com indicador incoerente", () => {
    expect(parseZApiConnectionCallback({
      type: "MessageStatusCallback",
      connected: true,
    })).toBeNull();
    expect(parseZApiConnectionCallback({
      type: "ConnectedCallback",
      connected: false,
    })).toBeNull();
    expect(parseZApiConnectionCallback({
      type: "DisconnectedCallback",
      disconnected: false,
    })).toBeNull();
  });

  it("preserva exatamente endpoint, header e body do envio manual", () => {
    const request = buildZApiTextRequest(
      { instance_id: "instance-1", token: "instance-token", client_token: "client-token" },
      { toPhone: "(11) 98765-4321", text: "Olá" },
    );
    expect(request).toEqual({
      ok: true,
      url: "https://api.z-api.io/instances/instance-1/token/instance-token/send-text",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "Client-Token": "client-token" },
        body: JSON.stringify({ phone: "5511987654321", message: "Olá" }),
      },
    });
    expect(buildZApiTextRequest({ instance_id: "instance-1" }, { toPhone: "11", text: "x" }))
      .toEqual({ ok: false, missingCreds: ["token"] });
  });
});

describe("UazAPI v2.1.1", () => {
  const textPayload = {
    EventType: "messages",
    token: "payload-token-not-used-by-parser",
    messageid: "uaz-message-1",
    sender: "5511987654321@s.whatsapp.net",
    senderName: "Cliente Uaz",
    fromMe: false,
    isGroup: false,
    messageType: "Conversation",
    messageTimestamp: 1_776_597_600_000,
    text: "Mesa para duas pessoas",
  };

  it("normaliza texto apenas quando o evento traz ID e timestamp oficiais", () => {
    expect(parseUazApiInbound(textPayload)).toMatchObject({
      providerMessageId: "uaz-message-1",
      fromPhone: "11987654321",
      text: "Mesa para duas pessoas",
      timestamp: 1_776_597_600_000,
      contactName: "Cliente Uaz",
    });
    expect(parseUazApiInbound({ ...textPayload, messageid: undefined })).toBeNull();
    expect(parseUazApiInbound({ ...textPayload, messageTimestamp: undefined })).toBeNull();
    expect(parseUazApiInbound({ ...textPayload, EventType: "connection" })).toBeNull();
    expect(parseUazApiInbound({ ...textPayload, fromMe: true })).toBeNull();
    expect(parseUazApiInbound({ EventType: "messages", message: textPayload })).toMatchObject({
      providerMessageId: "uaz-message-1",
      fromPhone: "11987654321",
    });
    expect(parseUazApiInbound({ ...textPayload, sender: "5511987654321@lid" })).toBeNull();
    expect(parseUazApiInbound({
      ...textPayload,
      sender: "5511987654321@lid",
      chatid: "5511976543210@s.whatsapp.net",
    })).toMatchObject({ fromPhone: "11976543210" });
  });

  it("detecta mídia sem inventar ID e não a converte em texto", () => {
    const media = { ...textPayload, text: "", messageType: "audio" };
    expect(parseUazApiInbound(media)).toBeNull();
    expect(peekUazApiMedia(media)).toEqual({
      providerMessageId: "uaz-message-1",
      fromPhone: "11987654321",
      mediaKind: "audio",
      contactName: "Cliente Uaz",
    });
    expect(peekUazApiMedia({ ...media, messageid: "" })).toBeNull();
  });

  it("normaliza delivery status e estado de conexão", () => {
    expect(parseUazApiStatus({
      EventType: "messages_update",
      messageid: "uaz-message-1",
      status: "Delivered",
    })).toEqual([{ providerMessageId: "uaz-message-1", status: "delivered" }]);
    expect(parseUazApiStatus({
      EventType: "messages",
      messageid: "uaz-message-1",
      status: "Delivered",
    })).toBeNull();
    expect(parseUazApiStatus({
      EventType: "messages_update",
      data: { messageid: "uaz-message-2", status: "Read" },
    })).toEqual([{ providerMessageId: "uaz-message-2", status: "read" }]);
    expect(mapUazApiConnectionStatus({ status: "connecting", qrcode: "data:image/png;base64,abc" }))
      .toEqual({
        status: "waiting_qr",
        nativeStatus: "connecting",
        connected: false,
        qrRequired: true,
        displayPhone: null,
      });
    expect(mapUazApiConnectionStatus({ status: "hibernated" }).status).toBe("suspended");
    expect(mapUazApiConnectionStatus({ status: "connected" }).status).toBe("connected");
  });

  it("envia texto uma única vez no endpoint oficial e captura messageid", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ messageid: "uaz-outbound-1", status: "Sent" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const result = await sendUazApiText(
      { base_url: "https://tenant.uazapi.example/", instance_token: "instance-token" },
      { toPhone: "(11) 98765-4321", text: "Confirmação" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, status: 200, providerMessageId: "uaz-outbound-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://tenant.uazapi.example/send/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", token: "instance-token" },
      body: JSON.stringify({ number: "5511987654321", text: "Confirmação" }),
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    [401, "AUTH_ERROR", "uazapi_auth_error"],
    [429, "RATE_LIMITED", "uazapi_rate_limited"],
  ] as const)("normaliza HTTP %i sem retry", async (status, errorCode, error) => {
    const fetchImpl = vi.fn(async () => new Response("provider detail must not leak", { status }));
    const result = await sendUazApiText(
      { base_url: "https://tenant.uazapi.example", instance_token: "instance-token" },
      { toPhone: "11987654321", text: "Teste" },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: false, status, error, errorCode });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  it("aborta por timeout sem repetir POST mutante", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = sendUazApiText(
      { base_url: "https://tenant.uazapi.example", instance_token: "instance-token" },
      { toPhone: "11987654321", text: "Teste" },
      { fetchImpl, timeoutMs: 25 },
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ ok: false, error: "uazapi_timeout", errorCode: "TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

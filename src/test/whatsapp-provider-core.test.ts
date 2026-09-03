import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  MAX_WAHA_QR_RAW_LENGTH,
  buildWahaSessionActionRequest,
  buildWahaStatusRequest,
  buildWahaQrRequest,
  buildZApiQrRequest,
  buildZApiTextRequest,
  createWhatsAppProviderRegistry,
  decideWahaQrFlow,
  isSafeWahaBaseUrl,
  mapUazApiConnectionStatus,
  parseWahaConnectionStatus,
  parseWahaQrCode,
  parseUazApiInbound,
  parseUazApiStatus,
  parseZApiInbound,
  parseZApiConnectionCallback,
  parseZApiConnectionStatus,
  parseZApiQrCode,
  parseZApiStatus,
  peekUazApiMedia,
  sendUazApiText,
  wahaSessionPreparationAction,
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
    expect(registry.get("zapi").capabilities).toMatchObject({
      qrConnection: true,
      restart: false,
      disconnect: false,
    });
    expect(registry.get("waha").capabilities.qrConnection).toBe(true);
    expect(registry.get("official").capabilities.qrConnection).toBe(false);
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
  it("aceita somente o value do QR raw em resposta 2xx", () => {
    expect(parseWahaQrCode(200, { value: "raw-qr-value" }))
      .toEqual({ qrCode: "raw-qr-value" });
    expect(parseWahaQrCode(200, { data: "base64-fora-do-contrato" }))
      .toEqual({ qrCode: null });
    expect(parseWahaQrCode(503, { value: "nao-pode-renderizar" }))
      .toEqual({ qrCode: null });
    expect(parseWahaQrCode(200, { value: "x".repeat(MAX_WAHA_QR_RAW_LENGTH + 1) }))
      .toEqual({ qrCode: null });
  });

  it("monta o GET de QR raw com sessão codificada e Accept JSON", () => {
    expect(buildWahaQrRequest({
      base_url: "https://waha.example/",
      api_key: "api-key",
      session_name: "sessão principal",
    })).toEqual({
      ok: true,
      url: "https://waha.example/api/sess%C3%A3o%20principal/auth/qr?format=raw",
      headers: { Accept: "application/json", "X-Api-Key": "api-key" },
    });
    expect(buildWahaQrRequest({})).toEqual({ ok: false, missingCreds: ["base_url"] });
  });

  it("monta status/start/restart sem retry implícito e codifica a sessão", () => {
    const credentials = {
      base_url: "https://waha.example/",
      api_key: "api-key",
      session_name: "sessão principal",
    };
    expect(buildWahaStatusRequest(credentials)).toMatchObject({
      url: "https://waha.example/api/sessions/sess%C3%A3o%20principal",
    });
    expect(buildWahaSessionActionRequest(credentials, "start")).toEqual({
      ok: true,
      url: "https://waha.example/api/sessions/sess%C3%A3o%20principal/start",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": "api-key",
      },
    });
    expect(buildWahaSessionActionRequest(credentials, "restart")).toMatchObject({
      url: "https://waha.example/api/sessions/sess%C3%A3o%20principal/restart",
      method: "POST",
    });
    expect(wahaSessionPreparationAction("STOPPED")).toBe("start");
    expect(wahaSessionPreparationAction("FAILED")).toBe("restart");
    expect(wahaSessionPreparationAction("SCAN_QR_CODE")).toBeNull();
    expect(wahaSessionPreparationAction("PASSKEY_REQUIRED")).toBeNull();
    expect(decideWahaQrFlow("SCAN_QR_CODE")).toBe("ready");
    expect(decideWahaQrFlow("STARTING")).toBe("wait");
    expect(decideWahaQrFlow("WORKING")).toBe("connected");
    expect(decideWahaQrFlow("PASSKEY_REQUIRED")).toBe("unsupported");
    expect(decideWahaQrFlow("UNKNOWN")).toBe("terminal");
  });

  it("recusa base WAHA insegura antes do fetch", () => {
    expect(isSafeWahaBaseUrl("https://waha.example")).toBe(true);
    for (const value of [
      "http://waha.example",
      "https://user:password@waha.example",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://10.0.0.8",
      "https://169.254.169.254",
      "https://192.168.1.8",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[fe80::1]",
    ]) {
      expect(isSafeWahaBaseUrl(value), value).toBe(false);
      expect(buildWahaQrRequest({ base_url: value })).toEqual({
        ok: false,
        missingCreds: ["base_url"],
      });
    }
  });

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
    expect(parseWahaConnectionStatus(200, { status: "PASSKEY_REQUIRED" })).toMatchObject({
      status: "provider_error",
      qrRequired: false,
    });
    expect(parseWahaConnectionStatus(200, { status: "PASSKEY_CONFIRMATION_REQUIRED" })).toMatchObject({
      status: "provider_error",
      qrRequired: false,
    });
    expect(parseWahaConnectionStatus(200, {}).status).toBe("provider_error");
    expect(parseWahaConnectionStatus(503, { status: "WORKING" }).status).toBe("provider_error");
  });
});

describe("caracterização Z-API", () => {
  it("aceita somente o value do QR em resposta 2xx", () => {
    const value = "data:image/png;base64,iVBORw0KGgoAAA";
    expect(parseZApiQrCode(200, { value })).toEqual({ qrCode: value });
    expect(parseZApiQrCode(200, { value: "conteudo-fora-do-contrato" }))
      .toEqual({ qrCode: null });
    expect(parseZApiQrCode(200, { value: "   " })).toEqual({ qrCode: null });
    expect(parseZApiQrCode(401, { value })).toEqual({ qrCode: null });
  });

  it("monta o endpoint de QR com as credenciais legadas e Client-Token", () => {
    expect(buildZApiQrRequest({
      instance_id: "instance-1",
      token: "instance-token",
      client_token: "client-token",
    })).toEqual({
      ok: true,
      url: "https://api.z-api.io/instances/instance-1/token/instance-token/qr-code",
      headers: { "Client-Token": "client-token" },
    });
    expect(buildZApiQrRequest({ instance_id: "instance-1" }))
      .toEqual({ ok: false, missingCreds: ["token"] });
  });

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

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
  parseWahaInbound,
  parseWahaOwnMessageEcho,
  parseWahaQrCode,
  parseUazApiInbound,
  parseUazApiOwnMessageEcho,
  parseUazApiStatus,
  parseZApiInbound,
  parseZApiOwnMessageEcho,
  parseOfficialOwnMessageEcho,
  parseOfficialOwnMessageEchoes,
  parseOfficialInbound,
  parseOfficialStatus,
  parseZApiConnectionCallback,
  parseZApiConnectionStatus,
  parseZApiQrCode,
  parseZApiStatus,
  peekOfficialMedia,
  peekUazApiMedia,
  peekWahaMedia,
  peekZApiMedia,
  sendUazApiText,
  wahaSessionPreparationAction,
  type WhatsAppProviderAdapter,
  type WhatsAppProviderName,
} from "../../supabase/functions/_shared/whatsapp-provider-core";
import { splitMetaWebhookPayloadCore } from "../../supabase/functions/_shared/whatsapp-meta-batch-core";

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
    parseOwnMessageEchoes: () => [],
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
      manualDeviceEcho: "supported",
    });
    expect(registry.get("zapi").capabilities).toMatchObject({
      qrConnection: true,
      restart: false,
      disconnect: false,
    });
    expect(registry.get("waha").capabilities.qrConnection).toBe(true);
    expect(registry.get("official").capabilities.qrConnection).toBe(false);
    expect(registry.get("official").capabilities.manualDeviceEcho).toBe("conditional");
    expect(registry.metadata()[0]).not.toBe(registry.list()[0]);
  });

  it("serializa as seis capabilities de Cloud API sem habilitar novas operações nos quatro providers legados", () => {
    // Os quatro legados de propósito: datafy liga rawCloudApiProxy e adReferral,
    // então incluí-lo aqui faria o teste falhar. Cobertura do datafy vive em
    // whatsapp-capability-guard.test.ts e datafy-adapter-coupling-guard.test.ts.
    const LEGACY_NAMES = ["zapi", "waha", "official", "uazapi"] as const;
    const registry = createWhatsAppProviderRegistry(LEGACY_NAMES.map(stubAdapter));

    for (const metadata of registry.metadata()) {
      expect(metadata.capabilities).toMatchObject({
        templateMessages: false,
        mediaMessages: false,
        inboundMediaDownload: false,
        interactiveMessages: false,
        adReferral: metadata.name === "official",
        rawCloudApiProxy: false,
      });
      expect(metadata.capabilities).not.toBe(registry.get(metadata.name).capabilities);
      expect(registry.get(metadata.name).cloudApiRequest).toBeUndefined();
    }
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
  it("aceita somente formatos seguros de QR no value de resposta 2xx", () => {
    const value = "data:image/png;base64,iVBORw0KGgoAAA";
    expect(parseZApiQrCode(200, { value })).toEqual({ qrCode: value });
    const pairingUrl = "https://wa.me/device-pairing,opaque@example:payload";
    expect(parseZApiQrCode(200, { value: pairingUrl })).toEqual({ qrCode: pairingUrl });
    expect(parseZApiQrCode(200, { value: "conteudo-fora-do-contrato" }))
      .toEqual({ qrCode: null });
    expect(parseZApiQrCode(200, { value: "https://evil.example/qr" }))
      .toEqual({ qrCode: null });
    expect(parseZApiQrCode(200, { value: "https://wa.me.evil.example/qr" }))
      .toEqual({ qrCode: null });
    expect(parseZApiQrCode(200, { value: "https://user@wa.me/qr" }))
      .toEqual({ qrCode: null });
    expect(parseZApiQrCode(200, { value: `https://wa.me/${"a".repeat(2_100)}` }))
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
      momment: 1_700_000_000_123,
    };

    expect(parseZApiInbound(payload)).toMatchObject({
      providerMessageId: "zapi-message-1",
      fromPhone: "11987654321",
      text: "Quero reservar",
      timestamp: 1_700_000_000_123,
      contactName: "Maria",
    });
    expect(parseZApiInbound({ ...payload, fromMe: true })).toBeNull();
    expect(parseZApiInbound({ ...payload, fromMe: false, isFromMe: true })).toBeNull();
    expect(parseZApiInbound({ ...payload, momment: undefined })).toBeNull();
    expect(parseZApiInbound({ ...payload, messageId: undefined })).toBeNull();
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

describe("ecos de mensagens próprias", () => {
  it("normaliza Z-API raiz ou aninhada e distingue aparelho de API", () => {
    const payload = {
      fromMe: true,
      fromApi: false,
      messageId: "zapi-own-1",
      phone: "5511987654321",
      connectedPhone: "5511999999999",
      chatLid: "12345678901234@lid",
      chatName: "Maria",
      momment: 1_700_000_000_123,
      text: { message: "  Já confirmei sua reserva  " },
    };

    expect(parseZApiOwnMessageEcho(payload)).toMatchObject({
      providerMessageId: "zapi-own-1",
      peerPhone: "11987654321",
      peerChatId: "12345678901234@lid",
      peerLid: "12345678901234@lid",
      text: "Já confirmei sua reserva",
      source: "manual_device",
      timestamp: 1_700_000_000_123,
      contactName: "Maria",
    });
    expect(parseZApiOwnMessageEcho({ payload: { ...payload, fromApi: true } })?.source)
      .toBe("provider_api");
    expect(parseZApiOwnMessageEcho({ ...payload, fromMe: false, fromApi: false })).toBeNull();
    expect(parseZApiOwnMessageEcho({ ...payload, fromApi: undefined })).toBeNull();
    expect(parseZApiOwnMessageEcho({ ...payload, messageId: undefined })).toBeNull();
  });

  it("normaliza WAHA payload/message.any usando source app|api", () => {
    const payload = {
      event: "message.any",
      payload: {
        id: "true_5511987654321@c.us_ABC",
        timestamp: 1_700_000_000,
        from: "5511987654321@c.us",
        to: "5511987654321@c.us",
        fromMe: true,
        source: "app",
        body: "Posso ajudar em algo mais?",
      },
    };

    expect(parseWahaOwnMessageEcho(payload)).toMatchObject({
      providerMessageId: "true_5511987654321@c.us_ABC",
      peerPhone: "11987654321",
      peerChatId: "5511987654321@c.us",
      text: "Posso ajudar em algo mais?",
      source: "manual_device",
      timestamp: 1_700_000_000_000,
    });
    expect(parseWahaOwnMessageEcho({
      ...payload,
      payload: { ...payload.payload, source: "api" },
    })?.source).toBe("provider_api");
    expect(parseWahaOwnMessageEcho({
      ...payload,
      payload: { ...payload.payload, source: undefined },
    })).toBeNull();
    expect(parseWahaOwnMessageEcho({ ...payload, event: "message.ack" })).toBeNull();
  });

  it("normaliza UazAPI em message/data, prioriza chatid e distingue wasSentByApi", () => {
    const message = {
      messageid: "uaz-own-1",
      chatid: "5511976543210@s.whatsapp.net",
      sender: "5511999999999@s.whatsapp.net",
      senderName: "Loja",
      fromMe: true,
      wasSentByApi: false,
      isGroup: false,
      messageType: "Conversation",
      messageTimestamp: 1_700_000_000_456,
      text: "Sua mesa está confirmada",
    };

    expect(parseUazApiOwnMessageEcho({ EventType: "messages", message })).toMatchObject({
      providerMessageId: "uaz-own-1",
      peerPhone: "11976543210",
      peerChatId: "5511976543210@s.whatsapp.net",
      text: "Sua mesa está confirmada",
      source: "manual_device",
      timestamp: 1_700_000_000_456,
    });
    expect(parseUazApiOwnMessageEcho({
      EventType: "messages",
      data: { ...message, wasSentByApi: true },
    })?.source).toBe("provider_api");
    expect(parseUazApiOwnMessageEcho({ EventType: "messages", message: { ...message, fromMe: false } }))
      .toBeNull();
    expect(parseUazApiOwnMessageEcho({ EventType: "messages", message: { ...message, wasSentByApi: undefined } }))
      .toBeNull();
  });

  it("normaliza somente o smb_message_echoes da Meta Coexistence", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "smb_message_echoes",
          value: {
            metadata: { display_phone_number: "5511999999999", phone_number_id: "123" },
            contacts: [{ wa_id: "5511987654321", profile: { name: "Maria" } }],
            message_echoes: [{
              from: "5511999999999",
              to: "5511987654321",
              id: "wamid.own-1",
              timestamp: "1700000000",
              type: "text",
              text: { body: "Mensagem pelo WhatsApp Business" },
            }],
          },
        }],
      }],
    };

    expect(parseOfficialOwnMessageEcho(payload)).toMatchObject({
      providerMessageId: "wamid.own-1",
      peerPhone: "11987654321",
      peerChatId: "5511987654321",
      text: "Mensagem pelo WhatsApp Business",
      source: "manual_device",
      timestamp: 1_700_000_000_000,
      contactName: "Maria",
    });
    const ordinary = structuredClone(payload);
    ordinary.entry[0].changes[0].field = "messages";
    expect(parseOfficialOwnMessageEcho(ordinary)).toBeNull();

    const batched = structuredClone(payload);
    batched.entry[0].changes[0].value.message_echoes.push({
      from: "5511999999999",
      to: "5511976543210",
      id: "wamid.own-2",
      timestamp: "1700000001",
      type: "text",
      text: { body: "Segunda mensagem" },
    });
    expect(parseOfficialOwnMessageEchoes(batched).map((echo) => echo.providerMessageId))
      .toEqual(["wamid.own-1", "wamid.own-2"]);
  });

  it("normaliza todos os status de todos os changes do lote Meta", () => {
    expect(parseOfficialStatus({
      entry: [
        { changes: [{ value: { statuses: [{ id: "wamid.1", status: "sent" }] } }] },
        { changes: [
          { value: { statuses: [{ id: "wamid.2", status: "delivered" }] } },
          { value: { statuses: [{ id: "wamid.3", status: "read" }] } },
        ] },
      ],
    })).toEqual([
      { providerMessageId: "wamid.1", status: "sent" },
      { providerMessageId: "wamid.2", status: "delivered" },
      { providerMessageId: "wamid.3", status: "read" },
    ]);
  });

  it("separa lote Meta e mantém apenas o contato do remetente de cada mensagem", () => {
    const parts = splitMetaWebhookPayloadCore({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "123" },
        contacts: [
          { wa_id: "5511987654321", profile: { name: "Maria" } },
          { wa_id: "5511976543210", profile: { name: "João" } },
        ],
        messages: [
          { id: "m1", from: "5511987654321", timestamp: "1700000000", type: "text", text: { body: "A" } },
          { id: "m2", from: "5511976543210", timestamp: "1700000001", type: "text", text: { body: "B" } },
        ],
      } }] }],
    });
    expect(parts).toHaveLength(2);
    expect(parts).toMatchObject([
      { entry: [{ changes: [{ value: { contacts: [{ profile: { name: "Maria" } }] } }] }] },
      { entry: [{ changes: [{ value: { contacts: [{ profile: { name: "João" } }] } }] }] },
    ]);
  });

  it("rejeita timestamp impossível ou muito futuro", () => {
    const base = {
      fromMe: true,
      fromApi: false,
      messageId: "zapi-time",
      phone: "5511987654321",
      connectedPhone: "5511999999999",
      text: { message: "teste" },
    };
    expect(parseZApiOwnMessageEcho({ ...base, momment: 253402300800000 })).toBeNull();
    expect(parseZApiOwnMessageEcho({ ...base, momment: Date.now() + 11 * 60_000 })).toBeNull();
  });

  it("usa timestamp Z-API válido quando momment veio inválido", () => {
    expect(parseZApiOwnMessageEcho({
      fromMe: true,
      fromApi: false,
      messageId: "zapi-time-fallback",
      phone: "5511987654321",
      connectedPhone: "5511999999999",
      text: { message: "teste" },
      momment: "bad",
      timestamp: 1_700_000_000_789,
    })?.timestamp).toBe(1_700_000_000_789);
  });

  it("falha fechado sem ID ou timestamp nativo nos inbounds legados", () => {
    expect(parseWahaInbound({
      event: "message.any",
      payload: { id: "w1", from: "5511987654321@c.us", body: "oi" },
    })).toBeNull();
    expect(parseWahaInbound({
      event: "message.any",
      payload: { from: "5511987654321@c.us", body: "oi", timestamp: 1_700_000_000 },
    })).toBeNull();
    const metaWithoutId = { entry: [{ changes: [{ value: { messages: [{
      from: "5511987654321", type: "text", text: { body: "oi" }, timestamp: "1700000000",
    }] } }] }] };
    expect(parseOfficialInbound(metaWithoutId)).toBeNull();
    expect(parseOfficialInbound({ entry: [{ changes: [{ value: { messages: [{
      id: "m1", from: "5511987654321", type: "text", text: { body: "oi" }, timestamp: "bad",
    }] } }] }] })).toBeNull();
  });
});

describe("timestamp de mídia inbound", () => {
  it("normaliza o timestamp nativo dos quatro providers para epoch ms", () => {
    expect(peekZApiMedia({
      messageId: "z-media",
      phone: "5511987654321",
      momment: 1_700_000_000_111,
      image: {},
    })?.timestamp).toBe(1_700_000_000_111);

    expect(peekWahaMedia({
      event: "message",
      payload: {
        id: "w-media",
        from: "5511987654321@c.us",
        timestamp: 1_700_000_000,
        type: "image",
        hasMedia: true,
      },
    })?.timestamp).toBe(1_700_000_000_000);

    expect(peekOfficialMedia({
      entry: [{ changes: [{ value: { messages: [{
        id: "m-media",
        from: "5511987654321",
        timestamp: "1700000000",
        type: "image",
      }] } }] }],
    })?.timestamp).toBe(1_700_000_000_000);
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
      timestamp: 1_776_597_600_000,
      contactName: "Cliente Uaz",
    });
    expect(peekUazApiMedia({ ...media, messageid: "" })).toBeNull();
    expect(peekUazApiMedia({ ...media, messageTimestamp: undefined })).toBeNull();
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

  // Envelope MEDIDO em produção (19/09/2026), não deduzido da documentação: o recibo
  // chega em `event`, e `event.Type` usa vocabulário PascalCase próprio da UazAPI — não
  // o enum do whatsmeow (""/delivery/read/played). Os casos acima, que põem
  // `messageid`/`status` na raiz, descrevem uma forma que a UazAPI nunca enviou: ficaram
  // verdes por 14 dias enquanto o painel Entregas estava 100% cego.
  const receiptEnvelope = (event: Record<string, unknown>) => ({
    EventType: "messages_update",
    type: "ReadReceipt",
    token: "instance-token-nao-usado-pelo-parser",
    BaseUrl: "https://tenant.uazapi.example",
    instanceName: "ren-sushi",
    owner: "5514999998888",
    state: "open",
    event,
  });

  const baseReceipt = {
    Chat: "5514999997777@s.whatsapp.net",
    Sender: "5514999997777@s.whatsapp.net",
    IsFromMe: false,
    IsGroup: false,
    Timestamp: 1_789_000_000,
    chatid: "5514999997777@s.whatsapp.net",
    chatlid: "123456789012345@lid",
    sender_pn: "5514999997777@s.whatsapp.net",
    sender_lid: "123456789012345@lid",
  };

  it("lê o recibo de entrega do envelope `event` medido em produção", () => {
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Delivered",
      MessageIDs: ["3EB0A1B2C3D4E5F60718"],
    }))).toEqual([{ providerMessageId: "3EB0A1B2C3D4E5F60718", status: "delivered" }]);

    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Read",
      MessageIDs: ["3EB0A1B2C3D4E5F60718"],
    }))).toEqual([{ providerMessageId: "3EB0A1B2C3D4E5F60718", status: "read" }]);

    // Áudio ouvido. Não observado em produção até 19/09/2026, mapeado por simetria
    // com os outros providers (WAHA e Meta já tratam played como read).
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Played",
      MessageIDs: ["3EB0A1B2C3D4E5F60718"],
    }))).toEqual([{ providerMessageId: "3EB0A1B2C3D4E5F60718", status: "read" }]);
  });

  it("devolve um StatusUpdate por entrada de MessageIDs", () => {
    // Recibo é plural por natureza: o `Read` observado em produção carregou 6 ids.
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Delivered",
      MessageIDs: ["3EB0AAAA1111", "3EB0BBBB2222", "3EB0CCCC3333"],
    }))).toEqual([
      { providerMessageId: "3EB0AAAA1111", status: "delivered" },
      { providerMessageId: "3EB0BBBB2222", status: "delivered" },
      { providerMessageId: "3EB0CCCC3333", status: "delivered" },
    ]);
    // Entrada vazia/não-string é descartada sem derrubar as demais.
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Delivered",
      MessageIDs: ["3EB0AAAA1111", "", null, 42, "3EB0BBBB2222"],
    }))).toEqual([
      { providerMessageId: "3EB0AAAA1111", status: "delivered" },
      { providerMessageId: "3EB0BBBB2222", status: "delivered" },
    ]);
  });

  it("limita a rajada de ids para não amplificar escrita no webhook síncrono", () => {
    // applyDeliveryStatus faz UPDATE sequencial por id dentro da resposta do webhook:
    // um MessageIDs enorme estoura o timeout, o provider reentrega o mesmo payload e a
    // fila daquele canal trava. O teto é folga de duas ordens sobre o máximo medido (6).
    const ids = Array.from({ length: 900 }, (_, i) => `3EB0${String(i).padStart(16, "0")}`);
    const parsed = parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Delivered",
      MessageIDs: ids,
    }));
    expect(parsed).toHaveLength(500);
    expect(parsed?.[0]).toEqual({ providerMessageId: ids[0], status: "delivered" });
    expect(parsed?.[499]).toEqual({ providerMessageId: ids[499], status: "delivered" });
  });

  it("descarta recibo com IsFromMe: a loja lendo as mensagens DO CLIENTE", () => {
    // Medido: 7 recibos `Read` com IsFromMe true, carregando 6 ids de uma vez — o
    // atendente abrindo a conversa no aparelho e zerando as não-lidas do cliente. Os
    // ids ali são das mensagens que o cliente enviou, não das nossas; aplicá-los diria
    // ao operador que a nossa mensagem foi lida.
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      IsFromMe: true,
      Type: "Read",
      MessageIDs: ["3EB0AAAA1111", "3EB0BBBB2222"],
    }))).toBeNull();
  });

  it("não adivinha status desconhecido nem recibo sem id", () => {
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Inventado",
      MessageIDs: ["3EB0AAAA1111"],
    }))).toBeNull();
    expect(parseUazApiStatus(receiptEnvelope({
      ...baseReceipt,
      Type: "Delivered",
      MessageIDs: [],
    }))).toBeNull();
    expect(parseUazApiStatus(receiptEnvelope({ ...baseReceipt, Type: "Delivered" }))).toBeNull();
    // A guarda de EventType continua sendo o portão único.
    expect(parseUazApiStatus({
      ...receiptEnvelope({ ...baseReceipt, Type: "Delivered", MessageIDs: ["3EB0AAAA1111"] }),
      EventType: "messages",
    })).toBeNull();
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

describe("datafy: identidade e lote (Review Focus 3 e 4)", () => {
  const evento = (phoneNumberId: string, field: string, value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5511988887777", phone_number_id: phoneNumberId }, ...value } }] }],
  });

  it("inbound de outro phone_number_id do mesmo cliente não casa o canal", () => {
    const payload = evento("999", "messages", {
      contacts: [{ wa_id: "5511999999999", profile: { name: "Ana" } }],
      messages: [{ from: "5511999999999", id: "wamid.1", timestamp: "1790000000", type: "text", text: { body: "oi" } }],
    });
    // O payload é válido e parseável — é exatamente por isso que a guarda de
    // identidade precisa existir: o HMAC prova QUEM enviou, não PARA QUAL canal.
    expect(parseOfficialInbound(payload)?.providerMessageId).toBe("wamid.1");
    expect(payload.entry[0].changes[0].value.metadata.phone_number_id).toBe("999");
  });

  // NÃO cobre o caminho do webhook: um evento WABA sem `metadata.phone_number_id`
  // (message_template_status_update) faz metaPayloadMatchesChannel recusar por lista
  // vazia → 401 no filho → 500 no lote. Dormente nas Fases A–D (o referral da CTWA
  // chega dentro de messages[], que tem metadata) e bloqueante para a Fase F.
  // Decisão registrada na spec, seção "Pendência bloqueante para a Fase F".
  it("parseOfficialInbound devolve null para lote misto e a parte isolada de messages segue parseável", () => {
    const lote = {
      object: "whatsapp_business_account",
      entry: [
        { id: "w", changes: [{ field: "message_template_status_update", value: { event: "APPROVED" } }] },
        { id: "w", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5511988887777", phone_number_id: "123" }, contacts: [{ wa_id: "5511999999999", profile: { name: "Ana" } }], messages: [{ from: "5511999999999", id: "wamid.2", timestamp: "1790000000", type: "text", text: { body: "oi" } }] } }] },
      ],
    };
    const inbound = parseOfficialInbound(lote);
    // O parser lê entry[0] e devolve null para o template — é o split do webhook
    // que separa os itens. O que este teste fixa é que o evento desconhecido
    // não lança: perder o lote inteiro seria a regressão.
    expect(() => parseOfficialInbound(lote)).not.toThrow();
    expect(inbound).toBeNull();
    const soMensagem = { object: lote.object, entry: [lote.entry[1]] };
    expect(parseOfficialInbound(soMensagem)?.providerMessageId).toBe("wamid.2");
  });
});

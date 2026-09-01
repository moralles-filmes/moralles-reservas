// Fachada compatível e registry dos providers WhatsApp.

import { fetchWithRetry } from "./retry.ts";
import { jsonLog, sanitizePhone } from "./security.ts";
import { createUazApiClientFromEnv } from "./uazapi-client.ts";
import {
  PROVIDER_CAPABILITIES,
  buildZApiTextRequest,
  createWhatsAppProviderRegistry,
  parseOfficialInbound,
  parseOfficialStatus,
  parseUazApiInbound,
  parseUazApiStatus,
  parseWahaInbound,
  parseWahaStatus,
  parseZApiConnectionCallback,
  parseZApiConnectionStatus,
  parseZApiInbound,
  parseZApiStatus,
  mapUazApiConnectionStatus,
  peekOfficialMedia,
  peekUazApiMedia,
  peekWahaMedia,
  peekZApiMedia,
  pickProviderMessageId,
  sendUazApiText,
  type ChannelCredentials,
  type InboundMediaPeek,
  type InboundMessage,
  type OutboundMessage,
  type ProviderConnectionSnapshot,
  type SendResult,
  type WhatsAppProviderAdapter,
  type WhatsAppProviderMetadata,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";

async function fetchConnectionStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = await response.clone().json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProviderWithTimeout(
  url: string,
  init: RequestInit,
  retries: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetchWithRetry(
      url,
      { ...init, signal: controller.signal },
      { retries, baseDelayMs: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function getZApiConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  const { instance_id, token, client_token } = credentials;
  if (!instance_id || !token) throw new Error("missing_credentials");
  const { response, body } = await fetchConnectionStatus(
    `https://api.z-api.io/instances/${instance_id}/token/${token}/status`,
    client_token ? { "Client-Token": client_token } : {},
  );
  return parseZApiConnectionStatus(response.status, body);
}

async function getWahaConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  const { base_url, api_key, session_name = "default" } = credentials;
  if (!base_url) throw new Error("missing_credentials");
  const { response } = await fetchConnectionStatus(
    `${base_url.replace(/\/$/, "")}/api/sessions/${session_name}`,
    api_key ? { "X-Api-Key": api_key } : {},
  );
  return {
    status: response.ok ? "connected" : "provider_error",
    nativeStatus: response.ok ? "http_ok" : `http_${response.status}`,
    connected: response.ok,
    qrRequired: false,
  };
}

async function getOfficialConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  const { phone_number_id, access_token } = credentials;
  if (!phone_number_id || !access_token) throw new Error("missing_credentials");
  const { response, body } = await fetchConnectionStatus(
    `https://graph.facebook.com/v19.0/${phone_number_id}?fields=id,display_phone_number`,
    { Authorization: `Bearer ${access_token}` },
  );
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    status: response.ok ? "connected" : "provider_error",
    nativeStatus: response.ok ? "http_ok" : `http_${response.status}`,
    connected: response.ok,
    qrRequired: false,
    displayPhone: typeof record.display_phone_number === "string"
      ? record.display_phone_number
      : null,
  };
}

async function getUazApiConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  if (!credentials.base_url || !credentials.instance_token) throw new Error("missing_credentials");
  const { response, body } = await fetchConnectionStatus(
    `${credentials.base_url.replace(/\/$/, "")}/instance/status`,
    { token: credentials.instance_token },
  );
  if (!response.ok) {
    return {
      status: "provider_error",
      nativeStatus: `http_${response.status}`,
      connected: false,
      qrRequired: false,
    };
  }
  return mapUazApiConnectionStatus(body);
}

export type WhatsAppProvider = WhatsAppProviderName;
export type {
  ChannelCredentials,
  InboundMediaKind,
  InboundMediaPeek,
  InboundMessage,
  OutboundMessage,
  ProviderConnectionSnapshot,
  SendResult,
  StatusUpdate,
  WhatsAppOperationalStatus,
  WhatsAppProviderAdapter,
  WhatsAppProviderCapabilities,
  WhatsAppProviderErrorCode,
  WhatsAppProviderMetadata,
  WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";

async function sendZApi(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult> {
  const request = buildZApiTextRequest(credentials, message);
  if (!request.ok) {
    jsonLog("error", { evt: "send_zapi_missing_creds", missing: request.missingCreds, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: request.missingCreds, error: "missing_credentials" };
  }

  const response = await fetchProviderWithTimeout(
    request.url,
    request.init,
    3,
  );
  if (response.ok) {
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, providerMessageId: pickProviderMessageId(body) };
  }
  jsonLog("error", {
    evt: "send_zapi_failed",
    status: response.status,
    phone: sanitizePhone(message.toPhone),
  });
  return { ok: false, status: response.status, error: `zapi_http_${response.status}` };
}

async function sendWaha(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult> {
  const { base_url, api_key, session_name = "default" } = credentials;
  if (!base_url) {
    jsonLog("error", { evt: "send_waha_missing_creds", missing: ["base_url"], phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: ["base_url"], error: "missing_credentials" };
  }

  const digits = message.toPhone.replace(/\D/g, "");
  const chatId = (digits.startsWith("55") ? digits : `55${digits}`) + "@c.us";
  const url = `${base_url.replace(/\/$/, "")}/api/sendText`;
  const response = await fetchProviderWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(api_key ? { "X-Api-Key": api_key } : {}) },
      body: JSON.stringify({ session: session_name, chatId, text: message.text }),
    },
    3,
  );
  if (response.ok) {
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, providerMessageId: pickProviderMessageId(body) };
  }
  jsonLog("error", {
    evt: "send_waha_failed",
    status: response.status,
    phone: sanitizePhone(message.toPhone),
  });
  return { ok: false, status: response.status, error: `waha_http_${response.status}` };
}

async function sendOfficial(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult> {
  const { phone_number_id, access_token } = credentials;
  const missing: string[] = [];
  if (!phone_number_id) missing.push("phone_number_id");
  if (!access_token) missing.push("access_token");
  if (missing.length) {
    jsonLog("error", { evt: "send_official_missing_creds", missing, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials" };
  }

  const digits = message.toPhone.replace(/\D/g, "");
  const to = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://graph.facebook.com/v19.0/${phone_number_id}/messages`;
  const response = await fetchProviderWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${access_token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message.text } }),
    },
    3,
  );
  if (response.ok) {
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, providerMessageId: pickProviderMessageId(body) };
  }
  jsonLog("error", {
    evt: "send_official_failed",
    status: response.status,
    phone: sanitizePhone(message.toPhone),
  });
  return { ok: false, status: response.status, error: `official_http_${response.status}` };
}

async function sendUazApi(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult> {
  const configuredBaseUrl = credentials.base_url
    || (typeof Deno !== "undefined" ? Deno.env.get("UAZAPI_BASE_URL") : undefined);
  return sendUazApiText({ ...credentials, base_url: configuredBaseUrl }, message);
}

const adapters: readonly WhatsAppProviderAdapter[] = [
  {
    name: "zapi",
    label: "Z-API",
    capabilities: PROVIDER_CAPABILITIES.zapi,
    parseInbound: parseZApiInbound,
    peekInboundMedia: peekZApiMedia,
    parseStatusCallback: parseZApiStatus,
    parseConnectionCallback: parseZApiConnectionCallback,
    sendText: sendZApi,
    getConnectionStatus: getZApiConnectionStatus,
  },
  {
    name: "waha",
    label: "WAHA",
    capabilities: PROVIDER_CAPABILITIES.waha,
    parseInbound: parseWahaInbound,
    peekInboundMedia: peekWahaMedia,
    parseStatusCallback: parseWahaStatus,
    sendText: sendWaha,
    getConnectionStatus: getWahaConnectionStatus,
  },
  {
    name: "official",
    label: "Meta Cloud API",
    capabilities: PROVIDER_CAPABILITIES.official,
    parseInbound: parseOfficialInbound,
    peekInboundMedia: peekOfficialMedia,
    parseStatusCallback: parseOfficialStatus,
    sendText: sendOfficial,
    getConnectionStatus: getOfficialConnectionStatus,
  },
  {
    name: "uazapi",
    label: "UazAPI",
    capabilities: PROVIDER_CAPABILITIES.uazapi,
    parseInbound: parseUazApiInbound,
    peekInboundMedia: peekUazApiMedia,
    parseStatusCallback: parseUazApiStatus,
    parseConnectionCallback: (payload) => payload?.EventType === "connection"
      ? mapUazApiConnectionStatus(payload)
      : null,
    sendText: sendUazApi,
    getConnectionStatus: getUazApiConnectionStatus,
    lifecycle: {
      listInstances: () => createUazApiClientFromEnv().listInstances(),
      provision: (input) => createUazApiClientFromEnv().createInstance(input),
      configureWebhook: (token, input) => createUazApiClientFromEnv().configureWebhook(token, input),
      connect: (token) => createUazApiClientFromEnv().connect(token),
      status: (token) => createUazApiClientFromEnv().getStatus(token),
      disconnect: (token) => createUazApiClientFromEnv().disconnect(token),
      restart: (token) => createUazApiClientFromEnv().reset(token),
    },
  },
];

const providerRegistry = createWhatsAppProviderRegistry(adapters);

/** Resolve fail-closed para lifecycle/UI; nome inválido lança erro sanitizado. */
export function getWhatsAppProvider(name: string): WhatsAppProviderAdapter {
  return providerRegistry.get(name);
}

/** Resolve sem exception para fachadas de webhook que precisam ignorar provider desconhecido. */
export function tryGetWhatsAppProvider(name: string): WhatsAppProviderAdapter | null {
  return providerRegistry.tryGet(name);
}

export function listWhatsAppProviderMetadata(): WhatsAppProviderMetadata[] {
  return providerRegistry.metadata();
}

// ─── Fachadas públicas legadas ──────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseInbound(provider: WhatsAppProvider, payload: any): InboundMessage | null {
  try {
    return providerRegistry.tryGet(provider)?.parseInbound(payload) ?? null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
export function peekInboundMedia(provider: WhatsAppProvider, payload: any): InboundMediaPeek | null {
  try {
    return providerRegistry.tryGet(provider)?.peekInboundMedia(payload) ?? null;
  } catch {
    return null;
  }
}

export async function sendOutbound(
  provider: WhatsAppProvider,
  credentials: ChannelCredentials,
  message: OutboundMessage,
): Promise<SendResult> {
  const adapter = providerRegistry.tryGet(provider);
  if (!adapter) return { ok: false, error: `unknown_provider:${provider}` };
  try {
    return await adapter.sendText(credentials, message);
  } catch (error) {
    jsonLog("error", {
      evt: "send_outbound_error",
      provider,
      code: error instanceof DOMException && error.name === "AbortError"
        ? "TIMEOUT"
        : "PROVIDER_TRANSPORT_ERROR",
      phone: sanitizePhone(message.toPhone),
    });
    return {
      ok: false,
      error: error instanceof DOMException && error.name === "AbortError"
        ? "provider_timeout"
        : "provider_transport_error",
    };
  }
}

// ─── Validação de webhook ───────────────────────────────────────────────────

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validateProviderToken(actualToken: string, expectedToken: string): boolean {
  if (!actualToken || !expectedToken) return false;
  return constantTimeEquals(actualToken, expectedToken);
}

export function validateChannelSecret(req: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return false;
  const headerSecret = req.headers.get("x-webhook-secret") ?? "";
  if (headerSecret && constantTimeEquals(headerSecret, expectedSecret)) return true;
  try {
    const querySecret = new URL(req.url).searchParams.get("secret") ?? "";
    if (querySecret && constantTimeEquals(querySecret, expectedSecret)) return true;
  } catch {
    // URL inválida não autentica.
  }
  return false;
}

export async function validateMetaSignature(
  req: Request,
  bodyText: string,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret) return false;
  const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
  if (!sigHeader.startsWith("sha256=")) return false;
  const expectedHex = sigHeader.slice("sha256=".length).toLowerCase();
  if (expectedHex.length !== 64 || !/^[0-9a-f]+$/.test(expectedHex)) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(bodyText));
    const computedHex = Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEquals(expectedHex, computedHex);
  } catch {
    return false;
  }
}

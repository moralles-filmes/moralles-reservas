// Fachada compatível e registry dos providers WhatsApp.

import { fetchWithRetry } from "./retry.ts";
import { toE164BrPhone } from "./phone.ts";
import { jsonLog, sanitizePhone } from "./security.ts";
import { createUazApiClientFromEnv } from "./uazapi-client.ts";
import {
  META_SHAPED_PROVIDERS,
  PROVIDER_CAPABILITIES,
  WEBHOOK_SIGNATURE_SCHEME,
  buildWahaSessionActionRequest,
  buildWahaStatusRequest,
  buildWahaQrRequest,
  buildZApiQrRequest,
  buildZApiTextRequest,
  createWhatsAppProviderRegistry,
  decideWahaQrFlow,
  isMetaShapedProvider,
  isSafeWahaBaseUrl,
  parseOfficialAdReferral,
  parseOfficialInbound,
  parseOfficialOwnMessageEchoes,
  parseOfficialStatus,
  parseUazApiInbound,
  parseUazApiOwnMessageEcho,
  parseUazApiStatus,
  parseWahaConnectionStatus,
  parseWahaQrCode,
  parseWahaInbound,
  parseWahaOwnMessageEcho,
  parseWahaStatus,
  parseZApiConnectionCallback,
  parseZApiConnectionStatus,
  parseZApiQrCode,
  parseZApiInbound,
  parseZApiOwnMessageEcho,
  parseZApiStatus,
  mapUazApiConnectionStatus,
  peekOfficialMedia,
  peekUazApiMedia,
  peekWahaMedia,
  peekZApiMedia,
  pickProviderMessageId,
  sendUazApiText,
  wahaSessionPreparationAction,
  type AdReferral,
  type ChannelCredentials,
  type CloudApiRequest,
  type CloudApiResponse,
  type InboundMediaPeek,
  type InboundMessage,
  type OwnMessageEcho,
  type OutboundMessage,
  type ProviderConnectionSnapshot,
  type ProviderQrSnapshot,
  type SendResult,
  type SendTextOptions,
  type WhatsAppProviderAdapter,
  type WhatsAppProviderMetadata,
  type WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";
import { redactProviderFetchError } from "./provider-error-redaction-core.ts";
import {
  DATAFY_SIGNATURE_HEADER,
  DATAFY_TIMESTAMP_HEADER,
  buildDatafySignedPayload,
  decideDatafySignaturePreconditions,
} from "./datafy-signature-core.ts";
import {
  buildDatafyRequest,
  classifyDatafyStatus,
  createDatafyTemplateTransport,
  parseDatafyAccount,
  pickDatafyMessageId,
} from "./datafy-client.ts";

/**
 * A Z-API carrega `instance_id` e `token` NO PATH da URL
 * (`/instances/<id>/token/<token>/status`) — é o único provider assim; WAHA,
 * UazAPI e Meta usam header. Quando o `fetch` do Deno falha, a mensagem do
 * `TypeError` inclui a URL completa: "error sending request for url (https://
 * api.z-api.io/instances/<ID>/token/<TOKEN>/status)". Qualquer caller que
 * registre `String(error)` publica a credencial no log.
 *
 * Por isso a redação é AQUI, e não em cada call site: são quatro caminhos que
 * montam essa URL (status, QR, e os dois consumidores novos — a guarda de
 * envio e o worker de health, este último rodando 288x/dia por canal), e um
 * call site novo que esqueça de redigir volta a vazar sem ninguém notar.
 *
 * O erro relançado preserva o que serve para diagnóstico (é timeout? é rede?)
 * e descarta o que identifica a conta.
 */
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
  } catch (error) {
    throw redactProviderFetchError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSafeWahaQrJson(
  url: string,
  headers: Record<string, string>,
  init: Pick<RequestInit, "method"> = {},
  maxBodyBytes = 128 * 1024,
  timeoutMs = 10_000,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { response, body: null };
    }
    const reader = response.body?.getReader();
    if (!reader) return { response, body: null };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return { response, body: null };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
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
  const session = encodeURIComponent(session_name);
  const { response, body } = await fetchConnectionStatus(
    `${base_url.replace(/\/$/, "")}/api/sessions/${session}`,
    api_key ? { "X-Api-Key": api_key } : {},
  );
  return parseWahaConnectionStatus(response.status, body);
}

async function getZApiQrCode(
  credentials: ChannelCredentials,
): Promise<ProviderQrSnapshot> {
  const request = buildZApiQrRequest(credentials);
  if (!request.ok) throw new Error("missing_credentials");
  const { response, body } = await fetchConnectionStatus(request.url, request.headers);
  return parseZApiQrCode(response.status, body);
}

async function getWahaQrCode(
  credentials: ChannelCredentials,
): Promise<ProviderQrSnapshot> {
  if (!isSafeWahaBaseUrl(credentials.base_url)) throw new Error("missing_credentials");
  const deadline = Date.now() + 8_000;
  const statusRequest = buildWahaStatusRequest(credentials);
  if (!statusRequest.ok) throw new Error("missing_credentials");
  const readStatus = async (): Promise<ProviderConnectionSnapshot> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        status: "provider_error",
        nativeStatus: "qr_preparation_timeout",
        connected: false,
        qrRequired: false,
      };
    }
    const result = await fetchSafeWahaQrJson(
      statusRequest.url,
      statusRequest.headers,
      {},
      128 * 1024,
      Math.min(2_000, remaining),
    );
    return parseWahaConnectionStatus(result.response.status, result.body);
  };

  let status = await readStatus();
  let decision = decideWahaQrFlow(status.nativeStatus);
  const preparationAction = wahaSessionPreparationAction(status.nativeStatus);
  if (preparationAction) {
    const actionRequest = buildWahaSessionActionRequest(
      credentials,
      preparationAction,
    );
    if (!actionRequest.ok) throw new Error("missing_credentials");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { qrCode: null };
    const actionResult = await fetchSafeWahaQrJson(
      actionRequest.url,
      actionRequest.headers,
      { method: actionRequest.method },
      128 * 1024,
      Math.min(2_000, remaining),
    );
    if (!actionResult.response.ok) return { qrCode: null };
    decision = "wait";
  }

  while (decision !== "ready") {
    if (["connected", "unsupported", "terminal", "start", "restart"].includes(decision)) {
      return { qrCode: null };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 350) return { qrCode: null };
    await new Promise((resolve) => setTimeout(resolve, 350));
    status = await readStatus();
    decision = decideWahaQrFlow(status.nativeStatus);
  }
  const request = buildWahaQrRequest(credentials);
  if (!request.ok) throw new Error("missing_credentials");
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { qrCode: null };
  const { response, body } = await fetchSafeWahaQrJson(
    request.url,
    request.headers,
    {},
    64 * 1024,
    Math.min(2_000, remaining),
  );
  return parseWahaQrCode(response.status, body);
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
  AdReferral,
  ChannelCredentials,
  CloudApiRequest,
  CloudApiResponse,
  InboundMediaKind,
  InboundMediaPeek,
  InboundMessage,
  OwnMessageEcho,
  OwnMessageEchoSource,
  OutboundMessage,
  ProviderConnectionSnapshot,
  ProviderQrSnapshot,
  SendResult,
  SendTextOptions,
  StatusUpdate,
  WebhookSignatureScheme,
  WhatsAppOperationalStatus,
  WhatsAppProviderAdapter,
  WhatsAppProviderCapabilities,
  WhatsAppProviderErrorCode,
  WhatsAppProviderMetadata,
  WhatsAppProviderName,
} from "./whatsapp-provider-core.ts";
export { META_SHAPED_PROVIDERS, WEBHOOK_SIGNATURE_SCHEME, isMetaShapedProvider };

async function sendZApi(credentials: ChannelCredentials, message: OutboundMessage, options?: SendTextOptions): Promise<SendResult> {
  const request = buildZApiTextRequest(credentials, message);
  if (!request.ok) {
    jsonLog("error", { evt: "send_zapi_missing_creds", missing: request.missingCreds, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: request.missingCreds, error: "missing_credentials" };
  }

  const response = await fetchProviderWithTimeout(
    request.url,
    request.init,
    options?.retryPolicy === "none" ? 0 : 3,
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

async function sendWaha(credentials: ChannelCredentials, message: OutboundMessage, options?: SendTextOptions): Promise<SendResult> {
  const { base_url, api_key, session_name = "default" } = credentials;
  if (!base_url) {
    jsonLog("error", { evt: "send_waha_missing_creds", missing: ["base_url"], phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: ["base_url"], error: "missing_credentials" };
  }

  const chatId = toE164BrPhone(message.toPhone) + "@c.us";
  const url = `${base_url.replace(/\/$/, "")}/api/sendText`;
  const response = await fetchProviderWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(api_key ? { "X-Api-Key": api_key } : {}) },
      body: JSON.stringify({ session: session_name, chatId, text: message.text }),
    },
    options?.retryPolicy === "none" ? 0 : 3,
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

async function sendOfficial(credentials: ChannelCredentials, message: OutboundMessage, options?: SendTextOptions): Promise<SendResult> {
  const { phone_number_id, access_token } = credentials;
  const missing: string[] = [];
  if (!phone_number_id) missing.push("phone_number_id");
  if (!access_token) missing.push("access_token");
  if (missing.length) {
    jsonLog("error", { evt: "send_official_missing_creds", missing, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials" };
  }

  const to = toE164BrPhone(message.toPhone);
  const url = `https://graph.facebook.com/v19.0/${phone_number_id}/messages`;
  const response = await fetchProviderWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${access_token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message.text } }),
    },
    options?.retryPolicy === "none" ? 0 : 3,
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

async function sendDatafy(
  credentials: ChannelCredentials,
  message: OutboundMessage,
  options?: SendTextOptions,
): Promise<SendResult> {
  const { phone_number_id, access_token } = credentials;
  const missing: string[] = [];
  if (!phone_number_id) missing.push("phone_number_id");
  if (!access_token) missing.push("access_token");
  if (missing.length) {
    jsonLog("error", { evt: "send_datafy_missing_creds", missing, phone: sanitizePhone(message.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials", errorCode: "INVALID_REQUEST" };
  }

  const to = toE164BrPhone(message.toPhone);
  const { url, init } = buildDatafyRequest({
    token: access_token!,
    method: "POST",
    path: `v1/${phone_number_id}/messages`,
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message.text } },
  });

  const response = await fetchProviderWithTimeout(url, init, options?.retryPolicy === "none" ? 0 : 3);
  const errorCode = classifyDatafyStatus(response.status);
  if (errorCode === null) {
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, providerMessageId: pickDatafyMessageId(body) };
  }
  jsonLog("error", {
    evt: "send_datafy_failed",
    status: response.status,
    errorCode,
    phone: sanitizePhone(message.toPhone),
  });
  return { ok: false, status: response.status, error: `datafy_http_${response.status}`, errorCode };
}

async function getDatafyConnectionStatus(
  credentials: ChannelCredentials,
): Promise<ProviderConnectionSnapshot> {
  if (!credentials.access_token) throw new Error("missing_credentials");
  const { url, init } = buildDatafyRequest({
    token: credentials.access_token, method: "GET", path: "me",
  });
  const { response, body } = await fetchConnectionStatus(url, init.headers as Record<string, string>);
  const account = response.ok ? parseDatafyAccount(body) : null;
  // Cloud API não tem sessão: "conectado" é o token resolver um número válido.
  // Não existe QR, e por isso qrRequired é sempre false.
  return {
    status: account ? "connected" : "provider_error",
    nativeStatus: response.ok ? (account ? "token_ok" : "invalid_payload") : `http_${response.status}`,
    connected: !!account,
    qrRequired: false,
    displayPhone: null,
  };
}

async function datafyCloudApiRequest(
  credentials: ChannelCredentials,
  request: CloudApiRequest,
): Promise<CloudApiResponse> {
  if (!credentials.access_token) throw new Error("missing_credentials");
  const { url, init } = buildDatafyRequest({
    token: credentials.access_token,
    method: request.method,
    path: request.path,
    body: request.body,
  });
  const response = await fetchProviderWithTimeout(url, init, 0);
  return { status: response.status, body: await response.json().catch(() => null) };
}

const adapters: readonly WhatsAppProviderAdapter[] = [
  {
    name: "zapi",
    label: "Z-API",
    capabilities: PROVIDER_CAPABILITIES.zapi,
    parseInbound: parseZApiInbound,
    parseOwnMessageEchoes: (payload) => {
      const echo = parseZApiOwnMessageEcho(payload);
      return echo ? [echo] : [];
    },
    peekInboundMedia: peekZApiMedia,
    parseStatusCallback: parseZApiStatus,
    parseConnectionCallback: parseZApiConnectionCallback,
    sendText: sendZApi,
    getConnectionStatus: getZApiConnectionStatus,
    getQrCode: getZApiQrCode,
    canRequestQr: (credentials) => !!credentials.instance_id && !!credentials.token,
  },
  {
    name: "waha",
    label: "WAHA",
    capabilities: PROVIDER_CAPABILITIES.waha,
    parseInbound: parseWahaInbound,
    parseOwnMessageEchoes: (payload) => {
      const echo = parseWahaOwnMessageEcho(payload);
      return echo ? [echo] : [];
    },
    peekInboundMedia: peekWahaMedia,
    parseStatusCallback: parseWahaStatus,
    sendText: sendWaha,
    getConnectionStatus: getWahaConnectionStatus,
    getQrCode: getWahaQrCode,
    canRequestQr: (credentials) => isSafeWahaBaseUrl(credentials.base_url),
  },
  {
    name: "official",
    label: "Meta Cloud API",
    capabilities: PROVIDER_CAPABILITIES.official,
    parseInbound: parseOfficialInbound,
    parseOwnMessageEchoes: parseOfficialOwnMessageEchoes,
    peekInboundMedia: peekOfficialMedia,
    parseAdReferral: parseOfficialAdReferral,
    parseStatusCallback: parseOfficialStatus,
    sendText: sendOfficial,
    getConnectionStatus: getOfficialConnectionStatus,
  },
  {
    name: "uazapi",
    label: "UazAPI",
    capabilities: PROVIDER_CAPABILITIES.uazapi,
    parseInbound: parseUazApiInbound,
    parseOwnMessageEchoes: (payload) => {
      const echo = parseUazApiOwnMessageEcho(payload);
      return echo ? [echo] : [];
    },
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
  {
    name: "datafy",
    label: "Datafy (API Oficial)",
    capabilities: PROVIDER_CAPABILITIES.datafy,
    // Mesmas funções do adapter official, por referência: a Datafy encaminha o
    // payload da Meta sem modificar. Copiá-las criaria duas verdades.
    parseInbound: parseOfficialInbound,
    parseOwnMessageEchoes: parseOfficialOwnMessageEchoes,
    peekInboundMedia: peekOfficialMedia,
    parseAdReferral: parseOfficialAdReferral,
    parseStatusCallback: parseOfficialStatus,
    sendText: sendDatafy,
    getConnectionStatus: getDatafyConnectionStatus,
    cloudApiRequest: datafyCloudApiRequest,
    ...createDatafyTemplateTransport(),
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
export function parseOwnMessageEchoes(provider: WhatsAppProvider, payload: any): OwnMessageEcho[] {
  try {
    return providerRegistry.tryGet(provider)?.parseOwnMessageEchoes(payload) ?? [];
  } catch {
    return [];
  }
}

/** Compatibilidade para callers que só aceitam um evento por request. */
export function parseOwnMessageEcho(provider: WhatsAppProvider, payload: any): OwnMessageEcho | null {
  return parseOwnMessageEchoes(provider, payload)[0] ?? null;
}

// deno-lint-ignore no-explicit-any
export function peekInboundMedia(provider: WhatsAppProvider, payload: any): InboundMediaPeek | null {
  try {
    return providerRegistry.tryGet(provider)?.peekInboundMedia(payload) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fase D. `null` para todo provider sem o método — Z-API, WAHA e UazAPI não
 * declaram `adReferral` e não fazem nada aqui. Nunca lança: referral ilegível
 * não pode derrubar o inbound.
 */
// deno-lint-ignore no-explicit-any
export function parseAdReferral(provider: WhatsAppProvider, payload: any): AdReferral | null {
  try {
    return providerRegistry.tryGet(provider)?.parseAdReferral?.(payload) ?? null;
  } catch {
    return null;
  }
}

/** Se o provider captura referral CTWA. Método ⇔ capability, pelo guard. */
export function hasAdReferralCapture(provider: WhatsAppProvider): boolean {
  return typeof providerRegistry.tryGet(provider)?.parseAdReferral === "function";
}

export async function sendOutbound(
  provider: WhatsAppProvider,
  credentials: ChannelCredentials,
  message: OutboundMessage,
  options?: SendTextOptions,
): Promise<SendResult> {
  const adapter = providerRegistry.tryGet(provider);
  if (!adapter) return { ok: false, error: `unknown_provider:${provider}` };
  try {
    return options
      ? await adapter.sendText(credentials, message, options)
      : await adapter.sendText(credentials, message);
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

export async function verifyDatafySignature(
  req: Request,
  bodyText: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const verdict = decideDatafySignaturePreconditions({
    secret,
    signatureHeader: req.headers.get(DATAFY_SIGNATURE_HEADER),
    timestampHeader: req.headers.get(DATAFY_TIMESTAMP_HEADER),
    nowMs,
  });
  if (verdict.ok === false) {
    jsonLog("warn", { evt: "datafy_signature_refused", reason: verdict.reason });
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC", key, encoder.encode(buildDatafySignedPayload(verdict.signedPayloadPrefix, bodyText)),
    );
    const computedHex = Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEquals(verdict.expectedHex, computedHex);
  } catch {
    return false;
  }
}

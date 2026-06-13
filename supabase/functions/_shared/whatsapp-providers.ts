// Abstraction layer for WhatsApp providers: Z-API, WAHA, Official (Meta Cloud API).

import { fetchWithRetry } from "./retry.ts";
import { jsonLog, sanitizePhone } from "./security.ts";
import { canonicalBrPhone } from "./phone.ts";

export type WhatsAppProvider = "zapi" | "waha" | "official";

export interface InboundMessage {
  providerMessageId: string;
  fromPhone: string;   // digits only, no country code prefix
  text: string;
  isFromMe: boolean;
  timestamp: number;   // unix ms
  contactName?: string; // push_name / profile name (sanitized)
  // deno-lint-ignore no-explicit-any
  raw: any;
}

function sanitizeContactName(raw: unknown, phone: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (digitsOnly && digitsOnly === phone) return undefined;
  return trimmed.slice(0, 100);
}

export interface OutboundMessage {
  toPhone: string;
  text: string;
}

export interface ChannelCredentials {
  // Z-API
  instance_id?: string;
  token?: string;
  client_token?: string;
  // WAHA
  base_url?: string;
  api_key?: string;
  session_name?: string;
  // Official (Meta Cloud API)
  phone_number_id?: string;
  business_account_id?: string;
  access_token?: string;
  app_secret?: string;
}

// Resultado estruturado do envio. Antes era apenas `boolean` — qualquer falha
// ficava silenciosa. Agora os callers conseguem propagar status/error pra
// telemetria (notifications_sent.error, webhook_executions.error).
export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  bodySnippet?: string;
  missingCreds?: string[];
  // ID da mensagem devolvido pelo provedor no sucesso. Persistido em
  // notifications_sent.provider_message_id pra correlacionar o callback de
  // status (entregue/lido). Pode faltar se o provedor não devolver / body não
  // parsear — nesse caso a entrega fica não-rastreável (degrada pra só "enviado").
  providerMessageId?: string;
}

// Extrai o id da mensagem da resposta do provedor de forma tolerante. Nunca
// lança — captura é best-effort (sucesso do envio não depende disso).
// deno-lint-ignore no-explicit-any
function pickMessageId(body: any): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const candidates = [
    body.messageId,
    body.id,
    body.zaapId,
    body.messages?.[0]?.id, // Meta Cloud API
    body.key?.id, // WAHA (Baileys-style)
    body._data?.id?._serialized,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

// ─── Inbound parsing ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseInbound(provider: WhatsAppProvider, payload: any): InboundMessage | null {
  try {
    if (provider === "zapi") return parseZApi(payload);
    if (provider === "waha") return parseWaha(payload);
    if (provider === "official") return parseOfficial(payload);
    return null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
function parseZApi(p: any): InboundMessage | null {
  if (!p.text?.message || p.isFromMe) return null;
  const digits = canonicalBrPhone(String(p.phone ?? ""));
  const id = p.messageId ?? p.message?.id ?? p.id ?? `${digits}:${Date.now()}`;
  const contactName = sanitizeContactName(
    p.senderName ?? p.chatName ?? p.notifyName ?? p.contactName,
    digits,
  );
  return {
    providerMessageId: id,
    fromPhone: digits,
    text: p.text.message.trim(),
    isFromMe: false,
    timestamp: Date.now(),
    contactName,
    raw: p,
  };
}

// deno-lint-ignore no-explicit-any
function parseWaha(p: any): InboundMessage | null {
  // WAHA sends events like { event: "message", payload: { ... } }
  const msg = p.payload ?? p;
  if (msg.fromMe) return null;
  const textBody = msg.body ?? msg.text?.body;
  if (!textBody) return null;
  const rawFrom = canonicalBrPhone(String(msg.from ?? "").replace("@c.us", ""));
  const contactName = sanitizeContactName(
    msg._data?.notifyName ?? msg.notifyName ?? msg.pushName ?? msg._data?.pushName ?? p.payload?._data?.notifyName,
    rawFrom,
  );
  return {
    providerMessageId: msg.id ?? `${rawFrom}:${Date.now()}`,
    fromPhone: rawFrom,
    text: String(textBody).trim(),
    isFromMe: false,
    timestamp: (msg.timestamp ?? 0) * 1000 || Date.now(),
    contactName,
    raw: p,
  };
}

// deno-lint-ignore no-explicit-any
function parseOfficial(p: any): InboundMessage | null {
  // Meta Cloud API sends { object: "whatsapp_business_account", entry: [...] }
  const entry = p.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msgObj = value?.messages?.[0];
  if (!msgObj) return null;
  if (msgObj.type !== "text") return null;
  const digits = canonicalBrPhone(String(msgObj.from ?? ""));
  const contactName = sanitizeContactName(
    value?.contacts?.[0]?.profile?.name,
    digits,
  );
  return {
    providerMessageId: msgObj.id ?? `${digits}:${Date.now()}`,
    fromPhone: digits,
    text: (msgObj.text?.body ?? "").trim(),
    isFromMe: false,
    timestamp: Number(msgObj.timestamp ?? 0) * 1000 || Date.now(),
    contactName,
    raw: p,
  };
}

// ─── Media inbound (não-texto): peek sem exigir text ─────────────────────────
//
// `parseInbound` retorna null pra qualquer mensagem que não é texto. Antes o
// webhook silenciava — cliente mandava áudio/foto/sticker e não recebia nada.
// Esse peek detecta o tipo de mídia e devolve metadata mínimo (phone + kind),
// pra o webhook responder uma mensagem amigável e seguir.

export type InboundMediaKind =
  | "audio"
  | "image"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "other";

export interface InboundMediaPeek {
  providerMessageId: string;
  fromPhone: string;
  mediaKind: InboundMediaKind;
  contactName?: string;
}

// deno-lint-ignore no-explicit-any
export function peekInboundMedia(provider: WhatsAppProvider, payload: any): InboundMediaPeek | null {
  try {
    if (provider === "zapi") return peekZApiMedia(payload);
    if (provider === "waha") return peekWahaMedia(payload);
    if (provider === "official") return peekOfficialMedia(payload);
    return null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
function peekZApiMedia(p: any): InboundMediaPeek | null {
  if (p.isFromMe) return null;
  if (p.text?.message) return null; // é texto, deixa parseInbound cuidar
  let kind: InboundMediaKind | null = null;
  if (p.audio || p.ptt) kind = "audio";
  else if (p.image) kind = "image";
  else if (p.video) kind = "video";
  else if (p.document) kind = "document";
  else if (p.sticker) kind = "sticker";
  else if (p.location) kind = "location";
  else if (p.contact || p.contacts) kind = "contacts";
  if (!kind) return null;
  const digits = canonicalBrPhone(String(p.phone ?? ""));
  if (!digits) return null;
  const id = p.messageId ?? p.message?.id ?? p.id ?? `${digits}:${Date.now()}`;
  const contactName = sanitizeContactName(
    p.senderName ?? p.chatName ?? p.notifyName ?? p.contactName,
    digits,
  );
  return { providerMessageId: id, fromPhone: digits, mediaKind: kind, contactName };
}

// deno-lint-ignore no-explicit-any
function peekWahaMedia(p: any): InboundMediaPeek | null {
  const msg = p.payload ?? p;
  if (msg.fromMe) return null;
  const textBody = msg.body ?? msg.text?.body;
  // WAHA às vezes manda body com legenda — só consideramos mídia se hasMedia ou type indica mídia
  const wahaType = String(msg.type ?? "").toLowerCase();
  const mediaTypes: Record<string, InboundMediaKind> = {
    image: "image",
    audio: "audio",
    voice: "audio",
    ptt: "audio",
    video: "video",
    document: "document",
    sticker: "sticker",
    location: "location",
    vcard: "contacts",
    contacts: "contacts",
    contact_card: "contacts",
  };
  let kind: InboundMediaKind | null = mediaTypes[wahaType] ?? null;
  if (!kind && msg.hasMedia && !textBody) kind = "other";
  if (!kind) return null;
  const rawFrom = canonicalBrPhone(String(msg.from ?? "").replace("@c.us", ""));
  if (!rawFrom) return null;
  const contactName = sanitizeContactName(
    msg._data?.notifyName ?? msg.notifyName ?? msg.pushName ?? msg._data?.pushName ?? p.payload?._data?.notifyName,
    rawFrom,
  );
  return {
    providerMessageId: msg.id ?? `${rawFrom}:${Date.now()}`,
    fromPhone: rawFrom,
    mediaKind: kind,
    contactName,
  };
}

// deno-lint-ignore no-explicit-any
function peekOfficialMedia(p: any): InboundMediaPeek | null {
  const entry = p.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msgObj = value?.messages?.[0];
  if (!msgObj) return null;
  const t = String(msgObj.type ?? "");
  if (t === "text") return null;
  const map: Record<string, InboundMediaKind> = {
    audio: "audio",
    voice: "audio",
    image: "image",
    video: "video",
    document: "document",
    sticker: "sticker",
    location: "location",
    contacts: "contacts",
  };
  const kind: InboundMediaKind = map[t] ?? "other";
  const digits = canonicalBrPhone(String(msgObj.from ?? ""));
  if (!digits) return null;
  const contactName = sanitizeContactName(
    value?.contacts?.[0]?.profile?.name,
    digits,
  );
  return {
    providerMessageId: msgObj.id ?? `${digits}:${Date.now()}`,
    fromPhone: digits,
    mediaKind: kind,
    contactName,
  };
}

// ─── Outbound sending ─────────────────────────────────────────────────────────

export async function sendOutbound(
  provider: WhatsAppProvider,
  credentials: ChannelCredentials,
  msg: OutboundMessage
): Promise<SendResult> {
  try {
    if (provider === "zapi") return await sendZApi(credentials, msg);
    if (provider === "waha") return await sendWaha(credentials, msg);
    if (provider === "official") return await sendOfficial(credentials, msg);
    return { ok: false, error: `unknown_provider:${provider}` };
  } catch (err) {
    const error = String(err);
    jsonLog("error", { evt: "send_outbound_error", provider, err: error, phone: sanitizePhone(msg.toPhone) });
    return { ok: false, error };
  }
}

async function sendZApi(creds: ChannelCredentials, msg: OutboundMessage): Promise<SendResult> {
  const { instance_id, token, client_token } = creds;
  const missing: string[] = [];
  if (!instance_id) missing.push("instance_id");
  if (!token) missing.push("token");
  if (missing.length) {
    jsonLog("error", { evt: "send_zapi_missing_creds", missing, phone: sanitizePhone(msg.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials" };
  }

  const digits = msg.toPhone.replace(/\D/g, "");
  const formatted = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://api.z-api.io/instances/${instance_id}/token/${token}/send-text`;

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(client_token ? { "Client-Token": client_token } : {}) },
      body: JSON.stringify({ phone: formatted, message: msg.text }),
    },
    { retries: 3, baseDelayMs: 500 }
  );
  if (res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: true, status: res.status, providerMessageId: pickMessageId(body) };
  }
  const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
  jsonLog("error", { evt: "send_zapi_failed", status: res.status, bodySnippet, phone: sanitizePhone(msg.toPhone) });
  return { ok: false, status: res.status, bodySnippet, error: `zapi_http_${res.status}` };
}

async function sendWaha(creds: ChannelCredentials, msg: OutboundMessage): Promise<SendResult> {
  const { base_url, api_key, session_name = "default" } = creds;
  if (!base_url) {
    jsonLog("error", { evt: "send_waha_missing_creds", missing: ["base_url"], phone: sanitizePhone(msg.toPhone) });
    return { ok: false, missingCreds: ["base_url"], error: "missing_credentials" };
  }

  const digits = msg.toPhone.replace(/\D/g, "");
  const chatId = (digits.startsWith("55") ? digits : `55${digits}`) + "@c.us";
  const url = `${base_url.replace(/\/$/, "")}/api/sendText`;

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(api_key ? { "X-Api-Key": api_key } : {}) },
      body: JSON.stringify({ session: session_name, chatId, text: msg.text }),
    },
    { retries: 3, baseDelayMs: 500 }
  );
  if (res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: true, status: res.status, providerMessageId: pickMessageId(body) };
  }
  const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
  jsonLog("error", { evt: "send_waha_failed", status: res.status, bodySnippet, phone: sanitizePhone(msg.toPhone) });
  return { ok: false, status: res.status, bodySnippet, error: `waha_http_${res.status}` };
}

async function sendOfficial(creds: ChannelCredentials, msg: OutboundMessage): Promise<SendResult> {
  const { phone_number_id, access_token } = creds;
  const missing: string[] = [];
  if (!phone_number_id) missing.push("phone_number_id");
  if (!access_token) missing.push("access_token");
  if (missing.length) {
    jsonLog("error", { evt: "send_official_missing_creds", missing, phone: sanitizePhone(msg.toPhone) });
    return { ok: false, missingCreds: missing, error: "missing_credentials" };
  }

  const digits = msg.toPhone.replace(/\D/g, "");
  const to = digits.startsWith("55") ? digits : `55${digits}`;
  const url = `https://graph.facebook.com/v19.0/${phone_number_id}/messages`;

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${access_token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: msg.text } }),
    },
    { retries: 3, baseDelayMs: 500 }
  );
  if (res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: true, status: res.status, providerMessageId: pickMessageId(body) };
  }
  const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
  jsonLog("error", { evt: "send_official_failed", status: res.status, bodySnippet, phone: sanitizePhone(msg.toPhone) });
  return { ok: false, status: res.status, bodySnippet, error: `official_http_${res.status}` };
}

// ─── Webhook secret validation (per-channel) ─────────────────────────────────

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function validateChannelSecret(req: Request, expectedSecret: string): boolean {
  if (!expectedSecret) return false;

  // Header path (WAHA, providers que aceitam header customizado)
  const headerSecret = req.headers.get("x-webhook-secret") ?? "";
  if (headerSecret && constantTimeEquals(headerSecret, expectedSecret)) return true;

  // Query string fallback — necessário para Z-API, que não permite
  // configurar headers customizados no webhook.
  try {
    const url = new URL(req.url);
    const querySecret = url.searchParams.get("secret") ?? "";
    if (querySecret && constantTimeEquals(querySecret, expectedSecret)) return true;
  } catch {
    // ignore URL parse errors
  }

  return false;
}

// Validação específica do Meta Cloud API: HMAC-SHA256 do body cru com app_secret,
// comparado contra o header `x-hub-signature-256: sha256=<hex>`.
// Tem que receber o body como TEXT (não JSON parseado) — o JSON.stringify
// recria o body com whitespace/ordering diferentes e quebra a assinatura.
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
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(appSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
    const computedHex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return constantTimeEquals(expectedHex, computedHex);
  } catch {
    return false;
  }
}

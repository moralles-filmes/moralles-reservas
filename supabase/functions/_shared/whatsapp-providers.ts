// Abstraction layer for WhatsApp providers: Z-API, WAHA, Official (Meta Cloud API).

import { fetchWithRetry } from "./retry.ts";
import { jsonLog } from "./security.ts";

export type WhatsAppProvider = "zapi" | "waha" | "official";

export interface InboundMessage {
  providerMessageId: string;
  fromPhone: string;   // digits only, no country code prefix
  text: string;
  isFromMe: boolean;
  timestamp: number;   // unix ms
  // deno-lint-ignore no-explicit-any
  raw: any;
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
  const digits = String(p.phone ?? "").replace(/\D/g, "").replace(/^55/, "");
  const id = p.messageId ?? p.message?.id ?? p.id ?? `${digits}:${Date.now()}`;
  return {
    providerMessageId: id,
    fromPhone: digits,
    text: p.text.message.trim(),
    isFromMe: false,
    timestamp: Date.now(),
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
  const rawFrom = String(msg.from ?? "").replace("@c.us", "").replace(/\D/g, "").replace(/^55/, "");
  return {
    providerMessageId: msg.id ?? `${rawFrom}:${Date.now()}`,
    fromPhone: rawFrom,
    text: String(textBody).trim(),
    isFromMe: false,
    timestamp: (msg.timestamp ?? 0) * 1000 || Date.now(),
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
  const digits = String(msgObj.from ?? "").replace(/^55/, "").replace(/\D/g, "");
  return {
    providerMessageId: msgObj.id ?? `${digits}:${Date.now()}`,
    fromPhone: digits,
    text: (msgObj.text?.body ?? "").trim(),
    isFromMe: false,
    timestamp: Number(msgObj.timestamp ?? 0) * 1000 || Date.now(),
    raw: p,
  };
}

// ─── Outbound sending ─────────────────────────────────────────────────────────

export async function sendOutbound(
  provider: WhatsAppProvider,
  credentials: ChannelCredentials,
  msg: OutboundMessage
): Promise<boolean> {
  try {
    if (provider === "zapi") return await sendZApi(credentials, msg);
    if (provider === "waha") return await sendWaha(credentials, msg);
    if (provider === "official") return await sendOfficial(credentials, msg);
    return false;
  } catch (err) {
    jsonLog("error", { evt: "send_outbound_error", provider, err: String(err) });
    return false;
  }
}

async function sendZApi(creds: ChannelCredentials, msg: OutboundMessage): Promise<boolean> {
  const { instance_id, token, client_token } = creds;
  if (!instance_id || !token) return false;

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
  return res.ok;
}

async function sendWaha(creds: ChannelCredentials, msg: OutboundMessage): Promise<boolean> {
  const { base_url, api_key, session_name = "default" } = creds;
  if (!base_url) return false;

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
  return res.ok;
}

async function sendOfficial(creds: ChannelCredentials, msg: OutboundMessage): Promise<boolean> {
  const { phone_number_id, access_token } = creds;
  if (!phone_number_id || !access_token) return false;

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
  return res.ok;
}

// ─── Webhook secret validation (per-channel) ─────────────────────────────────

export function validateChannelSecret(req: Request, expectedSecret: string): boolean {
  // Different providers use different headers
  const got =
    req.headers.get("x-webhook-secret") ??
    req.headers.get("x-hub-signature-256") ?? // Meta uses this for signature
    "";
  if (!got || !expectedSecret) return false;
  // Simple constant-time compare for the stored secret value
  if (got.length !== expectedSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
  }
  return diff === 0;
}

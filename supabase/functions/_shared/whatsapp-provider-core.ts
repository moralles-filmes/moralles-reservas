import { canonicalBrPhone, toE164BrPhone } from "./phone.ts";

export const WHATSAPP_PROVIDER_NAMES = ["zapi", "waha", "official", "uazapi", "datafy"] as const;

export type WhatsAppProviderName = typeof WHATSAPP_PROVIDER_NAMES[number];

export interface WhatsAppProviderCapabilities {
  manualCredentials: boolean;
  automaticProvisioning: boolean;
  qrConnection: boolean;
  pairCode: boolean;
  automaticWebhook: boolean;
  disconnect: boolean;
  restart: boolean;
  deliveryReceipts: boolean;
  /** Envio de templates aprovados pela Meta. */
  templateMessages: boolean;
  /** Envio de imagem, áudio, vídeo, documento ou sticker. */
  mediaMessages: boolean;
  /** Download da mídia recebida do cliente. */
  inboundMediaDownload: boolean;
  /** Botões, listas e demais formatos interativos. */
  interactiveMessages: boolean;
  /** Entrega o objeto referral de anúncio Click-to-WhatsApp no payload. */
  adReferral: boolean;
  /** Requisição de baixo nível a endpoints da Cloud API. */
  rawCloudApiProxy: boolean;
  /**
   * Se o provider consegue ecoar mensagens digitadas no aparelho da loja.
   * `conditional` exige um modo específico, como Meta Cloud API Coexistence.
   */
  manualDeviceEcho: "supported" | "conditional" | "unsupported";
}

export interface CloudApiRequest {
  method: "GET" | "POST" | "DELETE";
  /** Caminho relativo à base do provider, sem barra inicial. */
  path: string;
  body?: unknown;
}

export interface CloudApiResponse {
  status: number;
  body: unknown;
}

/**
 * Capability → método exigido pelo guard de acoplamento, nas DUAS direções:
 * capability `true` exige o método, e método presente exige capability `true`.
 * Capability de payload também exige método: `adReferral` declarada sem
 * `parseAdReferral` foi a Fase A afirmando uma captura que ninguém fazia, e a
 * frase antiga deste comentário ("capabilities de payload não exigem chamada
 * própria") era o que deixava essa mentira passar.
 * Acrescentar o método ao contrato exige mapear sua capability aqui.
 */
export const CAPABILITY_REQUIRED_METHOD = {
  rawCloudApiProxy: "cloudApiRequest",
  adReferral: "parseAdReferral",
} as const satisfies Readonly<Partial<Record<keyof WhatsAppProviderCapabilities, keyof WhatsAppProviderAdapter>>>;

export type WhatsAppOperationalStatus =
  | "not_configured"
  | "provisioning"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "suspended"
  | "provider_error"
  | "switching_provider"
  | "error";

export type WhatsAppProviderErrorCode =
  | "AUTH_ERROR"
  | "INSTANCE_NOT_FOUND"
  | "NOT_CONNECTED"
  | "QR_REQUIRED"
  | "CAPACITY_EXCEEDED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "UNKNOWN_PROVIDER_ERROR";

export interface InboundMessage {
  providerMessageId: string;
  fromPhone: string;
  text: string;
  isFromMe: boolean;
  timestamp: number;
  contactName?: string;
  // deno-lint-ignore no-explicit-any
  raw: any;
}

export type OwnMessageEchoSource = "manual_device" | "provider_api";

/**
 * Mensagem que saiu do número da loja e retornou pelo webhook do provider.
 * `peer*` sempre identifica o outro lado da conversa, nunca o número da loja.
 */
export interface OwnMessageEcho {
  providerMessageId: string;
  peerPhone: string | null;
  peerChatId: string | null;
  peerLid: string | null;
  text: string;
  source: OwnMessageEchoSource;
  /** Epoch Unix em milissegundos, normalizado do timestamp do provider. */
  timestamp: number;
  contactName?: string;
  // deno-lint-ignore no-explicit-any
  raw: any;
}

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
  /** Epoch Unix em milissegundos, normalizado do timestamp do provider. */
  timestamp: number;
  contactName?: string;
}

/**
 * `referral` de anúncio Click-to-WhatsApp (Fase D). Existe só em provider que
 * declara `adReferral`. Campos tipados só quando o valor é `string`; `raw` é a
 * subárvore EXATAMENTE como chegou — o envelope não foi medido, e se o
 * identificador vier sob outro nome é na `raw` que ele sobrevive.
 */
export interface AdReferral {
  /** Id da mensagem que carregou o referral — conferido contra o do inbound. */
  providerMessageId: string;
  /** `messages[0].type` como veio, sem normalizar. */
  messageType: string | null;
  ctwaClid: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Subárvore `referral` CRUA. Nunca redigitada. */
  raw: unknown;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface StatusUpdate {
  providerMessageId: string;
  status: DeliveryStatus;
}

export interface OutboundMessage {
  toPhone: string;
  text: string;
}

export interface ChannelCredentials {
  // Z-API (legado; estes nomes e seu significado não podem mudar)
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
  // UazAPI. Resolvido efemeramente do Vault; nunca persistido em credentials.
  instance_token?: string;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  errorCode?: WhatsAppProviderErrorCode;
  bodySnippet?: string;
  missingCreds?: string[];
  providerMessageId?: string;
  provider?: WhatsAppProviderName;
  channelId?: string;
}

export interface ProviderConnectionSnapshot {
  status: WhatsAppOperationalStatus;
  nativeStatus: string | null;
  connected: boolean;
  qrRequired: boolean;
  displayPhone?: string | null;
}

/** QR efêmero obtido do provider. Nunca deve ser persistido ou logado. */
export interface ProviderQrSnapshot {
  qrCode: string | null;
}

export type ProviderQrRequest =
  | { ok: true; url: string; headers: Record<string, string>; method?: "GET" | "POST" }
  | { ok: false; missingCreds: string[] };

export const MAX_WAHA_QR_RAW_LENGTH = 16_384;
export const MAX_ZAPI_QR_PAIRING_URL_LENGTH = 2_048;

export type WahaQrFlowDecision =
  | "ready"
  | "start"
  | "restart"
  | "wait"
  | "connected"
  | "unsupported"
  | "terminal";

export interface ManagedProviderInstanceSnapshot {
  id: string;
  name: string | null;
  token: string | null;
  adminField01: string | null;
  adminField02: string | null;
  status: string | null;
  connected: boolean;
  loggedIn: boolean;
  jid: string | null;
  qrCode: string | null;
  pairCode: string | null;
}

export interface ManagedProviderLifecycleAdapter {
  listInstances(): Promise<ManagedProviderInstanceSnapshot[]>;
  provision(input: { name: string; adminField01: string; adminField02?: string }): Promise<ManagedProviderInstanceSnapshot>;
  configureWebhook(token: string, input: { url: string; events?: string[] }): Promise<void>;
  connect(token: string): Promise<ManagedProviderInstanceSnapshot>;
  status(token: string): Promise<ManagedProviderInstanceSnapshot>;
  disconnect(token: string): Promise<void>;
  restart(token: string): Promise<void>;
}

export interface WhatsAppProviderAdapter {
  name: WhatsAppProviderName;
  label: string;
  capabilities: WhatsAppProviderCapabilities;
  // deno-lint-ignore no-explicit-any
  parseInbound(payload: any): InboundMessage | null;
  // deno-lint-ignore no-explicit-any
  parseOwnMessageEchoes(payload: any): OwnMessageEcho[];
  // deno-lint-ignore no-explicit-any
  peekInboundMedia(payload: any): InboundMediaPeek | null;
  /**
   * Referral CTWA da mensagem do payload (Fase D). Só em adapter que declara
   * `adReferral` — o guard de capability confere as duas direções. Lê QUALQUER
   * `type` (texto e mídia) sobre o payload de UMA mensagem: o lote Meta já foi
   * dividido a montante.
   */
  // deno-lint-ignore no-explicit-any
  parseAdReferral?(payload: any): AdReferral | null;
  // deno-lint-ignore no-explicit-any
  parseStatusCallback(payload: any): StatusUpdate[] | null;
  // deno-lint-ignore no-explicit-any
  parseConnectionCallback?(payload: any): ProviderConnectionSnapshot | null;
  sendText(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult>;
  getConnectionStatus?(credentials: ChannelCredentials): Promise<ProviderConnectionSnapshot>;
  getQrCode?(credentials: ChannelCredentials): Promise<ProviderQrSnapshot>;
  canRequestQr?(credentials: ChannelCredentials): boolean;
  /** Uso exclusivo de Edge Functions que já resolveram tenant e credenciais. */
  cloudApiRequest?(credentials: ChannelCredentials, request: CloudApiRequest): Promise<CloudApiResponse>;
  lifecycle?: ManagedProviderLifecycleAdapter;
}

export interface WhatsAppProviderMetadata {
  name: WhatsAppProviderName;
  label: string;
  capabilities: WhatsAppProviderCapabilities;
}

export interface WhatsAppProviderRegistry {
  get(name: string): WhatsAppProviderAdapter;
  tryGet(name: string): WhatsAppProviderAdapter | null;
  list(): WhatsAppProviderAdapter[];
  metadata(): WhatsAppProviderMetadata[];
}

export function createWhatsAppProviderRegistry(
  adapters: readonly WhatsAppProviderAdapter[],
): WhatsAppProviderRegistry {
  const byName = new Map<string, WhatsAppProviderAdapter>();
  for (const adapter of adapters) {
    if (byName.has(adapter.name)) {
      throw new Error(`duplicate_whatsapp_provider:${adapter.name}`);
    }
    byName.set(adapter.name, adapter);
  }

  return {
    get(name: string) {
      const adapter = byName.get(name);
      if (!adapter) throw new Error(`unknown_whatsapp_provider:${name}`);
      return adapter;
    },
    tryGet(name: string) {
      return byName.get(name) ?? null;
    },
    list() {
      return Array.from(byName.values());
    },
    metadata() {
      return Array.from(byName.values(), ({ name, label, capabilities }) => ({
        name,
        label,
        capabilities: { ...capabilities },
      }));
    },
  };
}

export const PROVIDER_CAPABILITIES: Readonly<Record<WhatsAppProviderName, WhatsAppProviderCapabilities>> = {
  zapi: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: true,
    pairCode: false,
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "supported",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: false,
    rawCloudApiProxy: false,
  },
  waha: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: true,
    pairCode: false,
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "supported",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: false,
    rawCloudApiProxy: false,
  },
  official: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: false,
    pairCode: false,
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "conditional",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: true,
    rawCloudApiProxy: false,
  },
  uazapi: {
    manualCredentials: false,
    automaticProvisioning: true,
    qrConnection: true,
    pairCode: false,
    automaticWebhook: true,
    disconnect: true,
    restart: true,
    deliveryReceipts: true,
    manualDeviceEcho: "supported",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: false,
    rawCloudApiProxy: false,
  },
  datafy: {
    manualCredentials: true,
    automaticProvisioning: false,
    qrConnection: false,
    pairCode: false,
    // A Datafy responde 403 a webhook_configuration: a URL é colada à mão no painel.
    automaticWebhook: false,
    disconnect: false,
    restart: false,
    deliveryReceipts: true,
    manualDeviceEcho: "conditional",
    templateMessages: false,
    mediaMessages: false,
    inboundMediaDownload: false,
    interactiveMessages: false,
    adReferral: true,
    rawCloudApiProxy: true,
  },
};

/**
 * Providers cujo payload de webhook é o envelope da Meta
 * (`object`/`entry[]`/`changes[]`/`value`). A Datafy encaminha o payload da Meta
 * sem modificar, então tudo que decide FORMA de payload pergunta a este conjunto.
 *
 * Existe como conjunto, e não como `provider === "official"` espalhado, porque a
 * omissão de um único call site não produz erro: o evento simplesmente não casa
 * nenhum parser e some como `ignored_non_text`.
 */
export const META_SHAPED_PROVIDERS: ReadonlySet<WhatsAppProviderName> = new Set([
  "official",
  "datafy",
]);

export function isMetaShapedProvider(provider: string): boolean {
  return META_SHAPED_PROVIDERS.has(provider as WhatsAppProviderName);
}

/**
 * Esquema de autenticação do webhook, por provider. É uma pergunta DIFERENTE de
 * `META_SHAPED_PROVIDERS`: `official` e `datafy` têm o mesmo formato de payload
 * e esquemas de assinatura distintos — a Meta assina o corpo com o app_secret,
 * a Datafy assina `{timestamp}.{corpo}` com o whsec_ do canal.
 *
 * Existe como mapa para que o webhook não volte a discriminar por string: um
 * `provider === "official"` no ramo de assinatura é indistinguível, à leitura,
 * de um que decide forma de payload — e é assim que o próximo provider
 * Meta-shaped entra sem ninguém notar.
 */
export type WebhookSignatureScheme = "meta_app_secret" | "datafy_whsec" | "channel_secret";

export const WEBHOOK_SIGNATURE_SCHEME: Readonly<Record<WhatsAppProviderName, WebhookSignatureScheme>> = {
  zapi: "channel_secret",
  waha: "channel_secret",
  uazapi: "channel_secret",
  official: "meta_app_secret",
  datafy: "datafy_whsec",
};

function sanitizeContactName(raw: unknown, phone: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (digitsOnly && digitsOnly === phone) return undefined;
  return trimmed.slice(0, 100);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function epochMs(value: unknown, unit: "seconds" | "milliseconds"): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const milliseconds = unit === "seconds" ? parsed * 1000 : parsed;
  const earliestAccepted = Date.UTC(2000, 0, 1);
  const latestAccepted = Date.now() + 10 * 60_000;
  return Number.isFinite(milliseconds)
      && milliseconds >= earliestAccepted
      && milliseconds <= latestAccepted
      && Number.isFinite(new Date(milliseconds).getTime())
    ? milliseconds
    : null;
}

function peerIdentityFromJid(value: unknown): {
  phone: string | null;
  chatId: string | null;
  lid: string | null;
} {
  const chatId = nonEmptyString(value);
  if (!chatId) return { phone: null, chatId: null, lid: null };
  const lower = chatId.toLowerCase();
  const lid = lower.endsWith("@lid") ? chatId : null;
  const phone = lid ? null : (phoneFromJid(chatId) || null);
  return { phone, chatId, lid };
}

function plausiblePeerPhone(value: unknown, connectedPhone?: unknown): string | null {
  const phone = canonicalBrPhone(String(value ?? ""));
  const connected = canonicalBrPhone(String(connectedPhone ?? ""));
  if (!phone || phone === connected || phone.length < 10 || phone.length > 13) return null;
  return phone;
}

function phoneFromJid(value: unknown): string {
  const jid = String(value ?? "").trim().toLowerCase();
  if (!jid || jid.endsWith("@lid")) return "";
  if (jid.includes("@") && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us")) return "";
  const raw = jid.split("@")[0].split(":")[0];
  return canonicalBrPhone(raw);
}

function phoneFromUazMessage(message: Record<string, unknown>): string {
  return phoneFromJid(message.sender) || phoneFromJid(message.chatid);
}

// O webhook usa EventType/token no envelope e pode colocar o schema Message em
// `message`/`data` conforme o modo de entrega. Só esses envelopes documentados
// são aceitos; não fazemos busca recursiva em payload arbitrário.
// deno-lint-ignore no-explicit-any
function uazApiMessageFromEnvelope(payload: any): any {
  if (payload?.message && typeof payload.message === "object" && !Array.isArray(payload.message)) {
    return payload.message;
  }
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

// ─── Parsers inbound ────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseZApiInbound(p: any): InboundMessage | null {
  if (!p.text?.message || p.fromMe || p.isFromMe) return null;
  const digits = canonicalBrPhone(String(p.phone ?? ""));
  const id = nonEmptyString(p.messageId ?? p.message?.id ?? p.id);
  const timestamp = epochMs(p.momment, "milliseconds")
    ?? epochMs(p.timestamp, "milliseconds");
  if (!digits || !id || !timestamp) return null;
  const contactName = sanitizeContactName(
    p.senderName ?? p.chatName ?? p.notifyName ?? p.contactName,
    digits,
  );
  return {
    providerMessageId: id,
    fromPhone: digits,
    text: p.text.message.trim(),
    isFromMe: false,
    timestamp,
    contactName,
    raw: p,
  };
}

// deno-lint-ignore no-explicit-any
export function parseWahaInbound(p: any): InboundMessage | null {
  const msg = p.payload ?? p;
  if (msg.fromMe) return null;
  const textBody = msg.body ?? msg.text?.body;
  if (!textBody) return null;
  const rawFrom = canonicalBrPhone(String(msg.from ?? "").replace("@c.us", ""));
  const id = nonEmptyString(msg.id?._serialized ?? msg.id);
  const timestamp = epochMs(msg.timestamp, "seconds");
  if (!rawFrom || !id || !timestamp) return null;
  const contactName = sanitizeContactName(
    msg._data?.notifyName ?? msg.notifyName ?? msg.pushName ?? msg._data?.pushName ?? p.payload?._data?.notifyName,
    rawFrom,
  );
  return {
    providerMessageId: id,
    fromPhone: rawFrom,
    text: String(textBody).trim(),
    isFromMe: false,
    timestamp,
    contactName,
    raw: p,
  };
}

// deno-lint-ignore no-explicit-any
export function parseOfficialInbound(p: any): InboundMessage | null {
  const value = p.entry?.[0]?.changes?.[0]?.value;
  const msgObj = value?.messages?.[0];
  if (!msgObj || msgObj.type !== "text") return null;
  const digits = canonicalBrPhone(String(msgObj.from ?? ""));
  const id = nonEmptyString(msgObj.id);
  const timestamp = epochMs(msgObj.timestamp, "seconds");
  if (!digits || !id || !timestamp) return null;
  const contactName = sanitizeContactName(value?.contacts?.[0]?.profile?.name, digits);
  return {
    providerMessageId: id,
    fromPhone: digits,
    text: (msgObj.text?.body ?? "").trim(),
    isFromMe: false,
    timestamp,
    contactName,
    raw: p,
  };
}

// UazAPI v2.1.1 envia o schema Message no envelope do evento. Diferente dos
// providers legados, ID e timestamp não ganham fallbacks locais: sem os campos
// oficiais o evento é inválido e não pode chegar ao dedupe/IA.
// deno-lint-ignore no-explicit-any
export function parseUazApiInbound(p: any): InboundMessage | null {
  if (p?.EventType !== "messages") return null;
  const message = uazApiMessageFromEnvelope(p);
  if (message?.fromMe || message?.wasSentByApi || message?.isGroup) return null;
  const id = nonEmptyString(message?.messageid);
  const text = nonEmptyString(message?.text);
  const timestamp = epochMs(message?.messageTimestamp, "milliseconds");
  const phone = phoneFromUazMessage(message ?? {});
  if (!id || !text || !timestamp || !phone) return null;

  const type = String(message?.messageType ?? "").toLowerCase();
  if (UAZAPI_MEDIA_TYPE[type]) return null;

  return {
    providerMessageId: id,
    fromPhone: phone,
    text,
    isFromMe: false,
    timestamp,
    contactName: sanitizeContactName(message?.senderName, phone),
    raw: p,
  };
}

// ─── Ecos de mensagens enviadas pela loja ───────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseZApiOwnMessageEcho(payload: any): OwnMessageEcho | null {
  const p = payload?.payload && typeof payload.payload === "object" ? payload.payload : payload;
  if (!p || typeof p !== "object") return null;
  if (p.fromMe !== true && p.isFromMe !== true && p.sentByMe !== true) return null;
  // Sem o discriminador booleano não há como distinguir aparelho de API com
  // segurança. Falha fechado para não duplicar resposta automática como humana.
  if (typeof p.fromApi !== "boolean") return null;
  if (p.isGroup === true || p.isNewsletter === true || p.broadcast === true) return null;

  const providerMessageId = nonEmptyString(p.messageId ?? p.message?.id ?? p.id);
  const text = nonEmptyString(p.text?.message);
  const timestamp = epochMs(p.momment, "milliseconds")
    ?? epochMs(p.timestamp, "milliseconds");
  if (!providerMessageId || !text || !timestamp) return null;

  const chatIdentity = peerIdentityFromJid(p.chatLid ?? p.chatId);
  const peerPhone = plausiblePeerPhone(p.phone, p.connectedPhone) ?? chatIdentity.phone;
  const peerLid = chatIdentity.lid ?? (!peerPhone ? nonEmptyString(p.chatLid) : null);
  if (!peerPhone && !peerLid) return null;

  return {
    providerMessageId,
    peerPhone,
    peerChatId: chatIdentity.chatId,
    peerLid,
    text,
    source: p.fromApi === true ? "provider_api" : "manual_device",
    timestamp,
    contactName: sanitizeContactName(p.chatName ?? p.senderName, peerPhone ?? ""),
    raw: payload,
  };
}

// WAHA exige assinatura em `message.any` para observar todas as mensagens
// próprias. `source` é o discriminador documentado entre aparelho e API.
// deno-lint-ignore no-explicit-any
export function parseWahaOwnMessageEcho(payload: any): OwnMessageEcho | null {
  const p = payload?.payload && typeof payload.payload === "object" ? payload.payload : payload;
  const event = nonEmptyString(payload?.event);
  if (!p || typeof p !== "object" || p.fromMe !== true) return null;
  if (event && event !== "message" && event !== "message.any") return null;
  if (p.source !== "app" && p.source !== "api") return null;

  const providerMessageId = nonEmptyString(p.id);
  const text = nonEmptyString(p.body ?? p.text?.body);
  const timestamp = epochMs(p.timestamp, "seconds");
  if (!providerMessageId || !text || !timestamp) return null;

  const candidates = [p.to, p.chatId, p.from];
  let identity = { phone: null, chatId: null, lid: null } as ReturnType<typeof peerIdentityFromJid>;
  for (const candidate of candidates) {
    const parsed = peerIdentityFromJid(candidate);
    if (parsed.phone || parsed.lid) {
      identity = parsed;
      break;
    }
  }
  if (!identity.phone && !identity.lid) return null;

  return {
    providerMessageId,
    peerPhone: identity.phone,
    peerChatId: identity.chatId,
    peerLid: identity.lid,
    text,
    source: p.source === "api" ? "provider_api" : "manual_device",
    timestamp,
    contactName: sanitizeContactName(
      p._data?.notifyName ?? p.notifyName ?? p.pushName ?? p._data?.pushName,
      identity.phone ?? "",
    ),
    raw: payload,
  };
}

// deno-lint-ignore no-explicit-any
export function parseUazApiOwnMessageEcho(payload: any): OwnMessageEcho | null {
  if (payload?.EventType !== "messages") return null;
  const p = uazApiMessageFromEnvelope(payload);
  if (!p || typeof p !== "object" || p.fromMe !== true || p.isGroup === true) return null;
  if (typeof p.wasSentByApi !== "boolean") return null;

  const providerMessageId = nonEmptyString(p.messageid);
  const text = nonEmptyString(p.text);
  const timestamp = epochMs(p.messageTimestamp, "milliseconds");
  if (!providerMessageId || !text || !timestamp) return null;

  // Em outbound, `sender` pode ser a própria loja; `chatid` é o peer.
  const chatIdentity = peerIdentityFromJid(p.chatid ?? p.chatId ?? p.chatLid);
  const senderIdentity = peerIdentityFromJid(p.sender);
  const identity = chatIdentity.phone || chatIdentity.lid ? chatIdentity : senderIdentity;
  if (!identity.phone && !identity.lid) return null;

  return {
    providerMessageId,
    peerPhone: identity.phone,
    peerChatId: identity.chatId,
    peerLid: identity.lid,
    text,
    source: p.wasSentByApi === true ? "provider_api" : "manual_device",
    timestamp,
    contactName: sanitizeContactName(p.senderName, identity.phone ?? ""),
    raw: payload,
  };
}

// Meta só oferece eco do aparelho no modo Cloud API Coexistence, pelo campo
// `smb_message_echoes`. Esse evento representa exclusivamente app/linked device.
// deno-lint-ignore no-explicit-any
export function parseOfficialOwnMessageEcho(payload: any): OwnMessageEcho | null {
  return parseOfficialOwnMessageEchoes(payload)[0] ?? null;
}

// O webhook da Meta pode agrupar vários entries/changes/echoes na mesma
// entrega. Todos são normalizados; descartar os demais criaria buracos na
// timeline e poderia deixar a IA ativa após uma resposta humana.
// deno-lint-ignore no-explicit-any
export function parseOfficialOwnMessageEchoes(payload: any): OwnMessageEcho[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const echoes: OwnMessageEcho[] = [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "smb_message_echoes" || !change?.value) continue;
      const value = change.value;
      const messages = Array.isArray(value?.message_echoes) ? value.message_echoes : [];
      for (const message of messages) {
        if (!message || message.type !== "text") continue;

        const providerMessageId = nonEmptyString(message.id);
        const text = nonEmptyString(message.text?.body);
        const timestamp = epochMs(message.timestamp, "seconds");
        const peerPhone = plausiblePeerPhone(message.to, value?.metadata?.display_phone_number);
        if (!providerMessageId || !text || !timestamp || !peerPhone) continue;

        const matchingContact = Array.isArray(value?.contacts)
          ? value.contacts.find((contact: any) => canonicalBrPhone(String(contact?.wa_id ?? "")) === peerPhone)
          : null;
        echoes.push({
          providerMessageId,
          peerPhone,
          peerChatId: nonEmptyString(message.to),
          peerLid: null,
          text,
          source: "manual_device",
          timestamp,
          contactName: sanitizeContactName(matchingContact?.profile?.name ?? matchingContact?.name, peerPhone),
          raw: payload,
        });
      }
    }
  }
  return echoes;
}

// ─── Peek de mídia ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function peekZApiMedia(p: any): InboundMediaPeek | null {
  if (p.fromMe || p.isFromMe || p.text?.message) return null;
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
  const id = nonEmptyString(p.messageId ?? p.message?.id ?? p.id);
  const timestamp = epochMs(p.momment, "milliseconds")
    ?? epochMs(p.timestamp, "milliseconds");
  if (!digits || !id || !timestamp) return null;
  const contactName = sanitizeContactName(
    p.senderName ?? p.chatName ?? p.notifyName ?? p.contactName,
    digits,
  );
  return { providerMessageId: id, fromPhone: digits, mediaKind: kind, timestamp, contactName };
}

// deno-lint-ignore no-explicit-any
export function peekWahaMedia(p: any): InboundMediaPeek | null {
  const msg = p.payload ?? p;
  if (msg.fromMe) return null;
  const textBody = msg.body ?? msg.text?.body;
  const wahaType = String(msg.type ?? "").toLowerCase();
  const mediaTypes: Record<string, InboundMediaKind> = {
    image: "image", audio: "audio", voice: "audio", ptt: "audio",
    video: "video", document: "document", sticker: "sticker",
    location: "location", vcard: "contacts", contacts: "contacts",
    contact_card: "contacts",
  };
  let kind: InboundMediaKind | null = mediaTypes[wahaType] ?? null;
  if (!kind && msg.hasMedia && !textBody) kind = "other";
  if (!kind) return null;
  const rawFrom = canonicalBrPhone(String(msg.from ?? "").replace("@c.us", ""));
  const id = nonEmptyString(msg.id?._serialized ?? msg.id);
  const timestamp = epochMs(msg.timestamp, "seconds");
  if (!rawFrom || !id || !timestamp) return null;
  const contactName = sanitizeContactName(
    msg._data?.notifyName ?? msg.notifyName ?? msg.pushName ?? msg._data?.pushName ?? p.payload?._data?.notifyName,
    rawFrom,
  );
  return {
    providerMessageId: id,
    fromPhone: rawFrom,
    mediaKind: kind,
    timestamp,
    contactName,
  };
}

// deno-lint-ignore no-explicit-any
export function peekOfficialMedia(p: any): InboundMediaPeek | null {
  const value = p.entry?.[0]?.changes?.[0]?.value;
  const msgObj = value?.messages?.[0];
  if (!msgObj || msgObj.type === "text") return null;
  const map: Record<string, InboundMediaKind> = {
    audio: "audio", voice: "audio", image: "image", video: "video",
    document: "document", sticker: "sticker", location: "location",
    contacts: "contacts",
  };
  const digits = canonicalBrPhone(String(msgObj.from ?? ""));
  const id = nonEmptyString(msgObj.id);
  const timestamp = epochMs(msgObj.timestamp, "seconds");
  if (!digits || !id || !timestamp) return null;
  return {
    providerMessageId: id,
    fromPhone: digits,
    mediaKind: map[String(msgObj.type ?? "")] ?? "other",
    timestamp,
    contactName: sanitizeContactName(value?.contacts?.[0]?.profile?.name, digits),
  };
}

// Fase D. Lê `messages[0].referral` para QUALQUER `type`: o clique de anúncio
// pode chegar como texto ou como mídia, e `parseOfficialInbound` só vê texto.
// Campo tipado só entra se for `string` — `String({})` viraria
// "[object Object]" e passaria como identificador. `raw` é a subárvore como
// chegou, nunca redigitada.
// deno-lint-ignore no-explicit-any
export function parseOfficialAdReferral(p: any): AdReferral | null {
  const msgObj = p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msgObj || typeof msgObj !== "object") return null;
  const referral = msgObj.referral;
  if (referral === undefined || referral === null) return null;
  const id = nonEmptyString(msgObj.id);
  if (!id) return null;
  const fields: Record<string, unknown> =
    typeof referral === "object" && !Array.isArray(referral) ? referral : {};
  return {
    providerMessageId: id,
    messageType: typeof msgObj.type === "string" ? msgObj.type : null,
    ctwaClid: typeof fields.ctwa_clid === "string" ? fields.ctwa_clid : null,
    sourceType: typeof fields.source_type === "string" ? fields.source_type : null,
    sourceId: typeof fields.source_id === "string" ? fields.source_id : null,
    raw: referral,
  };
}

const UAZAPI_MEDIA_TYPE: Readonly<Record<string, InboundMediaKind>> = {
  audio: "audio",
  audiomessage: "audio",
  voice: "audio",
  ptt: "audio",
  image: "image",
  imagemessage: "image",
  video: "video",
  videomessage: "video",
  document: "document",
  documentmessage: "document",
  sticker: "sticker",
  stickermessage: "sticker",
  location: "location",
  locationmessage: "location",
  contact: "contacts",
  contacts: "contacts",
  contactmessage: "contacts",
  contactsarraymessage: "contacts",
  vcard: "contacts",
};

// deno-lint-ignore no-explicit-any
export function peekUazApiMedia(p: any): InboundMediaPeek | null {
  if (p?.EventType !== "messages") return null;
  const message = uazApiMessageFromEnvelope(p);
  if (message?.fromMe || message?.wasSentByApi || message?.isGroup) return null;
  const id = nonEmptyString(message?.messageid);
  const phone = phoneFromUazMessage(message ?? {});
  const kind = UAZAPI_MEDIA_TYPE[String(message?.messageType ?? "").toLowerCase()];
  const timestamp = epochMs(message?.messageTimestamp, "milliseconds");
  if (!id || !phone || !kind || !timestamp) return null;
  return {
    providerMessageId: id,
    fromPhone: phone,
    mediaKind: kind,
    timestamp,
    contactName: sanitizeContactName(message?.senderName, phone),
  };
}

// ─── Callbacks de entrega ───────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseZApiStatus(p: any): StatusUpdate[] | null {
  const type = String(p?.type ?? "");
  if (type !== "MessageStatusCallback" && type !== "DeliveryCallback") return null;
  const status = mapZApiStatus(String(p?.status ?? ""));
  if (!status) return null;
  const ids: string[] = Array.isArray(p?.ids)
    ? p.ids.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : typeof p?.messageId === "string" && p.messageId ? [p.messageId] : [];
  return ids.length ? ids.map((id) => ({ providerMessageId: id, status })) : null;
}

function mapZApiStatus(value: string): DeliveryStatus | null {
  const status = value.toUpperCase();
  if (status === "RECEIVED") return "delivered";
  if (status === "READ" || status === "PLAYED") return "read";
  if (status === "SENT") return "sent";
  if (status.includes("FAIL") || status.includes("ERROR")) return "failed";
  return null;
}

// deno-lint-ignore no-explicit-any
export function parseWahaStatus(p: any): StatusUpdate[] | null {
  if (!String(p?.event ?? "").includes("ack")) return null;
  const payload = p?.payload ?? {};
  const rawId = payload?.id?._serialized ?? payload?.id;
  if (typeof rawId !== "string" || !rawId) return null;
  const status = mapWahaAck(
    typeof payload?.ack === "number" ? payload.ack : null,
    String(payload?.ackName ?? ""),
  );
  return status ? [{ providerMessageId: rawId, status }] : null;
}

function mapWahaAck(ack: number | null, ackName: string): DeliveryStatus | null {
  const name = ackName.toUpperCase();
  if (name === "ERROR") return "failed";
  if (name === "READ" || name === "PLAYED") return "read";
  if (name === "DEVICE") return "delivered";
  if (name === "SERVER") return "sent";
  if (ack === -1) return "failed";
  if (ack === 3 || ack === 4) return "read";
  if (ack === 2) return "delivered";
  if (ack === 1) return "sent";
  return null;
}

// deno-lint-ignore no-explicit-any
export function parseOfficialStatus(p: any): StatusUpdate[] | null {
  const out: StatusUpdate[] = [];
  const entries = Array.isArray(p?.entry) ? p.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const statuses = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
      for (const item of statuses) {
        const id = item?.id;
        const status = mapOfficialStatus(String(item?.status ?? ""));
        if (typeof id === "string" && id && status) out.push({ providerMessageId: id, status });
      }
    }
  }
  return out.length ? out : null;
}

function mapOfficialStatus(value: string): DeliveryStatus | null {
  const status = value.toLowerCase();
  if (status === "sent" || status === "delivered" || status === "read" || status === "failed") {
    return status;
  }
  return null;
}

// Vocabulário de recibo da UazAPI, MEDIDO em produção (19/09/2026), não deduzido da
// documentação: é PascalCase próprio do provider, NÃO o enum do whatsmeow
// (""/"delivery"/"read"/"played"). Escrever o mapa a partir da doc do whatsmeow
// produziria um parser que não casa com nada, com testes verdes sobre enum inventado.
// "Played" (áudio ouvido) ainda não foi observado; mapeado por simetria com WAHA/Meta.
const MAX_UAZAPI_RECEIPT_IDS = 500;

function mapUazApiReceiptType(value: string): DeliveryStatus | null {
  const type = value.trim().toLowerCase();
  if (type === "delivered") return "delivered";
  if (type === "read" || type === "played") return "read";
  return null;
}

// Duas famílias de envelope convivem sob `EventType: "messages_update"`:
//
//  • RECIBO (a única observada em produção): payload em `event`, com `Type` no
//    vocabulário acima e `MessageIDs: string[]` — plural por natureza, um recibo
//    `Read` medido carregava 6 ids de uma vez.
//  • MENSAGEM (documentada, nunca observada): schema Message em `message`/`data`/raiz,
//    com `messageid` + `status`. Preservada: removê-la seria regressão não forçada.
//
// `event.IsFromMe` diz quem EMITIU o recibo, não de quem é a mensagem confirmada:
// `true` é a própria loja zerando pelo aparelho as não-lidas DO CLIENTE, e os ids ali
// são das mensagens que o cliente enviou. Aplicá-los afirmaria ao operador que a NOSSA
// mensagem foi lida.
//
// O que impede recibo alheio de contaminar o painel NÃO é esse filtro: é a correlação
// por (unit_id, whatsapp_provider, whatsapp_channel_id, provider_message_id) em
// `applyDeliveryStatus`, que simplesmente não casa linha nenhuma. O filtro é correção
// semântica e defesa em profundidade.
// deno-lint-ignore no-explicit-any
export function parseUazApiStatus(p: any): StatusUpdate[] | null {
  if (p?.EventType !== "messages_update") return null;

  const receipt = p?.event;
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
    if (receipt.IsFromMe === true) return null;
    const receiptStatus = mapUazApiReceiptType(String(receipt.Type ?? ""));
    if (!receiptStatus) return null;
    // Teto defensivo: `applyDeliveryStatus` faz UPDATE sequencial por id (dois quando
    // `read`) dentro da resposta síncrona do webhook, então um `MessageIDs` enorme vira
    // amplificação de escrita — a function estoura o timeout, o provider reentrega o
    // MESMO payload e a fila daquele canal trava nele. `MessageIDs` agrupa só recibos do
    // mesmo chat/remetente/instante, logo é limitado pelo que enviamos a UM cliente:
    // o máximo medido é 6, e o batch grande de verdade (loja zerando não-lidas) já sai
    // pelo filtro de `IsFromMe` acima. 500 é folga de duas ordens de grandeza.
    const ids = Array.isArray(receipt.MessageIDs)
      ? receipt.MessageIDs.slice(0, MAX_UAZAPI_RECEIPT_IDS)
      : [];
    const updates: StatusUpdate[] = [];
    for (const rawId of ids) {
      const messageId = nonEmptyString(rawId);
      if (messageId) updates.push({ providerMessageId: messageId, status: receiptStatus });
    }
    return updates.length ? updates : null;
  }

  const message = uazApiMessageFromEnvelope(p);
  const id = nonEmptyString(message?.messageid);
  const nativeStatus = String(message?.status ?? "").toLowerCase();
  let status: DeliveryStatus | null = null;
  if (nativeStatus === "sent" || nativeStatus === "queued") status = "sent";
  else if (nativeStatus === "delivered") status = "delivered";
  else if (nativeStatus === "read" || nativeStatus === "played") status = "read";
  else if (nativeStatus === "failed" || nativeStatus === "canceled" || nativeStatus === "cancelled") status = "failed";
  return id && status ? [{ providerMessageId: id, status }] : null;
}

// ─── Snapshots de conexão ──────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export function parseWahaConnectionStatus(
  httpStatus: number,
  payload: any,
): ProviderConnectionSnapshot {
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      status: "provider_error",
      nativeStatus: `http_${httpStatus}`,
      connected: false,
      qrRequired: false,
    };
  }

  const nativeStatus = nonEmptyString(payload?.status)?.toUpperCase() ?? null;
  const displayPhone = canonicalBrPhone(String(payload?.me?.id ?? "")) || null;
  if (nativeStatus === "WORKING") {
    return { status: "connected", nativeStatus, connected: true, qrRequired: false, displayPhone };
  }
  if (nativeStatus === "STOPPED") {
    return { status: "disconnected", nativeStatus, connected: false, qrRequired: false };
  }
  if (nativeStatus === "STARTING") {
    return { status: "connecting", nativeStatus, connected: false, qrRequired: false };
  }
  if (nativeStatus === "SCAN_QR_CODE") {
    return { status: "waiting_qr", nativeStatus, connected: false, qrRequired: true };
  }
  if (["PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"].includes(nativeStatus ?? "")) {
    return { status: "provider_error", nativeStatus, connected: false, qrRequired: false };
  }
  if (nativeStatus === "FAILED") {
    return { status: "error", nativeStatus, connected: false, qrRequired: false };
  }
  return {
    status: "provider_error",
    nativeStatus: nativeStatus ?? "invalid_payload",
    connected: false,
    qrRequired: false,
  };
}

// deno-lint-ignore no-explicit-any
export function parseZApiConnectionStatus(
  httpStatus: number,
  payload: any,
): ProviderConnectionSnapshot {
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      status: "provider_error",
      nativeStatus: `http_${httpStatus}`,
      connected: false,
      qrRequired: false,
    };
  }
  if (!payload || typeof payload !== "object" || typeof payload.connected !== "boolean") {
    return {
      status: "provider_error",
      nativeStatus: "invalid_payload",
      connected: false,
      qrRequired: false,
    };
  }
  return {
    status: payload.connected ? "connected" : "disconnected",
    nativeStatus: payload.connected ? "connected" : "disconnected",
    connected: payload.connected,
    qrRequired: false,
  };
}

function isSafeZApiQrPairingUrl(value: string): boolean {
  if (value.length > MAX_ZAPI_QR_PAIRING_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://wa.me"
      && !url.username
      && !url.password
      && url.pathname !== "/";
  } catch {
    return false;
  }
}

// A Z-API pode devolver tanto a imagem inline documentada quanto o payload
// de pareamento em https://wa.me. O segundo formato é codificado em canvas
// pelo frontend; URLs fora desse host nunca atravessam a fronteira client-safe.
// deno-lint-ignore no-explicit-any
export function parseZApiQrCode(httpStatus: number, payload: any): ProviderQrSnapshot {
  if (httpStatus < 200 || httpStatus >= 300) return { qrCode: null };
  const value = nonEmptyString(payload?.value);
  if (
    !value
    || (
      !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(value)
      && !isSafeZApiQrPairingUrl(value)
    )
  ) {
    return { qrCode: null };
  }
  return { qrCode: value };
}

// WAHA com `format=raw` e `Accept: application/json` devolve `{ value }`.
// deno-lint-ignore no-explicit-any
export function parseWahaQrCode(httpStatus: number, payload: any): ProviderQrSnapshot {
  if (httpStatus < 200 || httpStatus >= 300) return { qrCode: null };
  const value = nonEmptyString(payload?.value);
  return { qrCode: value && value.length <= MAX_WAHA_QR_RAW_LENGTH ? value : null };
}

export function buildZApiQrRequest(credentials: ChannelCredentials): ProviderQrRequest {
  const missingCreds: string[] = [];
  if (!credentials.instance_id) missingCreds.push("instance_id");
  if (!credentials.token) missingCreds.push("token");
  if (missingCreds.length) return { ok: false, missingCreds };
  return {
    ok: true,
    url: `https://api.z-api.io/instances/${credentials.instance_id}/token/${credentials.token}/qr-code`,
    headers: credentials.client_token ? { "Client-Token": credentials.client_token } : {},
  };
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (!host.includes(".") && !host.includes(":")) return true;
  if (
    host === "::"
    || host === "::1"
    || host.startsWith("::ffff:")
    || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function isSafeWahaBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function buildWahaRequest(
  credentials: ChannelCredentials,
  path: string,
  method?: "GET" | "POST",
): ProviderQrRequest {
  if (!credentials.base_url || !isSafeWahaBaseUrl(credentials.base_url)) {
    return { ok: false, missingCreds: ["base_url"] };
  }
  const baseUrl = credentials.base_url.trim().replace(/\/$/, "");
  return {
    ok: true,
    url: `${baseUrl}${path}`,
    headers: {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...(credentials.api_key ? { "X-Api-Key": credentials.api_key } : {}),
    },
    ...(method ? { method } : {}),
  };
}

export function buildWahaStatusRequest(credentials: ChannelCredentials): ProviderQrRequest {
  const session = encodeURIComponent(credentials.session_name || "default");
  return buildWahaRequest(credentials, `/api/sessions/${session}`);
}

export function buildWahaSessionActionRequest(
  credentials: ChannelCredentials,
  action: "start" | "restart",
): ProviderQrRequest {
  const session = encodeURIComponent(credentials.session_name || "default");
  return buildWahaRequest(credentials, `/api/sessions/${session}/${action}`, "POST");
}

export function wahaSessionPreparationAction(
  nativeStatus: string | null | undefined,
): "start" | "restart" | null {
  const decision = decideWahaQrFlow(nativeStatus);
  return decision === "start" || decision === "restart" ? decision : null;
}

export function decideWahaQrFlow(
  nativeStatus: string | null | undefined,
): WahaQrFlowDecision {
  const normalized = nativeStatus?.toUpperCase();
  if (normalized === "SCAN_QR_CODE") return "ready";
  if (normalized === "STOPPED") return "start";
  if (normalized === "FAILED") return "restart";
  if (normalized === "STARTING") return "wait";
  if (normalized === "WORKING") return "connected";
  if (normalized === "PASSKEY_REQUIRED" || normalized === "PASSKEY_CONFIRMATION_REQUIRED") {
    return "unsupported";
  }
  return "terminal";
}

export function buildWahaQrRequest(credentials: ChannelCredentials): ProviderQrRequest {
  const session = encodeURIComponent(credentials.session_name || "default");
  return buildWahaRequest(credentials, `/api/${session}/auth/qr?format=raw`);
}

// deno-lint-ignore no-explicit-any
export function parseZApiConnectionCallback(payload: any): ProviderConnectionSnapshot | null {
  const type = String(payload?.type ?? "");
  if (type === "ConnectedCallback" && payload?.connected !== true) return null;
  if (type === "DisconnectedCallback" && payload?.disconnected !== true) return null;
  if (type !== "ConnectedCallback" && type !== "DisconnectedCallback") return null;
  const connected = type === "ConnectedCallback";
  return {
    status: connected ? "connected" : "disconnected",
    nativeStatus: type,
    connected,
    qrRequired: false,
    displayPhone: connected ? canonicalBrPhone(String(payload?.phone ?? "")) || null : null,
  };
}

// deno-lint-ignore no-explicit-any
export function mapUazApiConnectionStatus(payload: any): ProviderConnectionSnapshot {
  const instance = payload?.instance ?? payload;
  const statusEnvelope = instance?.status && typeof instance.status === "object"
    ? instance.status
    : payload?.status && typeof payload.status === "object"
      ? payload.status
      : {};
  const nativeStatus = nonEmptyString(
    typeof instance?.status === "string" ? instance.status : statusEnvelope?.status,
  );
  const hasQr = !!nonEmptyString(
    instance?.qrcode ?? instance?.qrCode ?? instance?.qr ?? payload?.qrcode ?? payload?.qrCode ?? payload?.qr,
  );
  const connected = payload?.connected === true
    || instance?.connected === true
    || statusEnvelope?.connected === true
    || nativeStatus === "connected";
  const rawJid = statusEnvelope?.jid ?? instance?.jid ?? payload?.jid;
  const displayPhone = typeof rawJid === "string"
    ? phoneFromJid(rawJid)
    : rawJid && typeof rawJid === "object"
      ? canonicalBrPhone(String(rawJid.user ?? ""))
      : null;
  let status: WhatsAppOperationalStatus;
  if (connected) status = "connected";
  else if (nativeStatus === "hibernated") status = "suspended";
  else if (nativeStatus === "connecting" && hasQr) status = "waiting_qr";
  else if (nativeStatus === "connecting") status = "connecting";
  else if (nativeStatus === "disconnected") status = "disconnected";
  else status = "provider_error";
  return { status, nativeStatus, connected, qrRequired: hasQr && !connected, displayPhone };
}

// ─── Envio UazAPI ───────────────────────────────────────────────────────────

export interface UazApiSendDependencies {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ZApiTextRequest =
  | { ok: true; url: string; init: RequestInit }
  | { ok: false; missingCreds: string[] };

/** Constrói o request legado sem alterar URL, headers ou payload da Z-API. */
export function buildZApiTextRequest(
  credentials: ChannelCredentials,
  message: OutboundMessage,
): ZApiTextRequest {
  const { instance_id, token, client_token } = credentials;
  const missingCreds: string[] = [];
  if (!instance_id) missingCreds.push("instance_id");
  if (!token) missingCreds.push("token");
  if (missingCreds.length) return { ok: false, missingCreds };

  const phone = toE164BrPhone(message.toPhone);
  return {
    ok: true,
    url: `https://api.z-api.io/instances/${instance_id}/token/${token}/send-text`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(client_token ? { "Client-Token": client_token } : {}),
      },
      body: JSON.stringify({ phone, message: message.text }),
    },
  };
}

export async function sendUazApiText(
  credentials: ChannelCredentials,
  message: OutboundMessage,
  dependencies: UazApiSendDependencies = {},
): Promise<SendResult> {
  const baseUrl = credentials.base_url?.trim().replace(/\/+$/, "");
  const instanceToken = credentials.instance_token?.trim();
  const missing: string[] = [];
  if (!baseUrl) missing.push("base_url");
  if (!instanceToken) missing.push("instance_token");
  if (missing.length) {
    return { ok: false, missingCreds: missing, error: "missing_credentials", errorCode: "INVALID_REQUEST" };
  }
  if (!/^https?:\/\//i.test(baseUrl!)) {
    return { ok: false, error: "uazapi_invalid_base_url", errorCode: "INVALID_REQUEST" };
  }

  const number = toE164BrPhone(message.toPhone);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 12_000);
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(`${baseUrl}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken! },
      body: JSON.stringify({ number, text: message.text }),
      signal: controller.signal,
    });

    if (!response.ok) return uazApiSendError(response.status);
    const body = await response.json().catch(() => null);
    return {
      ok: true,
      status: response.status,
      providerMessageId: pickProviderMessageId(body),
    };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
    if (controller.signal.aborted || name === "AbortError") {
      return { ok: false, error: "uazapi_timeout", errorCode: "TIMEOUT" };
    }
    return { ok: false, error: "uazapi_unavailable", errorCode: "PROVIDER_UNAVAILABLE" };
  } finally {
    clearTimeout(timeout);
  }
}

function uazApiSendError(status: number): SendResult {
  if (status === 401 || status === 403) {
    return { ok: false, status, error: "uazapi_auth_error", errorCode: "AUTH_ERROR" };
  }
  if (status === 404) {
    return { ok: false, status, error: "uazapi_instance_not_found", errorCode: "INSTANCE_NOT_FOUND" };
  }
  if (status === 409) {
    return { ok: false, status, error: "uazapi_not_connected", errorCode: "NOT_CONNECTED" };
  }
  if (status === 429) {
    return { ok: false, status, error: "uazapi_rate_limited", errorCode: "RATE_LIMITED" };
  }
  if (status === 400 || status === 422) {
    return { ok: false, status, error: "uazapi_invalid_request", errorCode: "INVALID_REQUEST" };
  }
  if (status >= 500) {
    return { ok: false, status, error: "uazapi_unavailable", errorCode: "PROVIDER_UNAVAILABLE" };
  }
  return { ok: false, status, error: "uazapi_unknown_error", errorCode: "UNKNOWN_PROVIDER_ERROR" };
}

// deno-lint-ignore no-explicit-any
export function pickProviderMessageId(body: any): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const candidates = [
    body.messageId,
    body.messageid,
    body.id,
    body.zaapId,
    body.messages?.[0]?.id,
    body.key?.id,
    body._data?.id?._serialized,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Cliente da API de ADMINISTRAÇÃO da Datafy: a conta de parceiro da plataforma,
 * autenticada pelo token de conta (`sk_acct_`), que alcança TODOS os canais da
 * conta. Separado de `datafy-client.ts`, que fala com a API de mensagens pelo
 * token de CANAL (`sk_live_`); a base URL continua vindo de lá.
 *
 * As formas aceitas são as medidas ao vivo na Fase 0
 * (docs/superpowers/specs/2026-10-13-datafy-parceiro-validacao-fase0.md §2).
 * Regras que este arquivo sustenta:
 *
 * - Classificação SÓ por status HTTP. O envelope de erro da Datafy é
 *   `{message, statusCode}` sem `code`, e as variantes de um mesmo status só
 *   diferem pelo texto — que pode carregar dado. O texto nunca decide nem sai
 *   daqui. O 409 é ambíguo por natureza: quem chama decide pelo GET.
 * - Erro carrega só `kind`, `httpStatus` e um `code` FIXO, porque o `code` vai
 *   para `last_error` do onboarding. Nunca `String(error)`: a exceção do `fetch`
 *   pode embutir URL, header e corpo da requisição.
 * - 2xx fora da forma medida vira `unrecognized`, e `onUnrecognized` recebe a
 *   FORMA (`shapeOf`, com nome de chave fora do vocabulário trocado por `<key>`),
 *   nunca o corpo.
 * - Mutação que termina em `transport`, `server_error` ou `unrecognized` PODE ter
 *   acontecido (`datafyMutationMayHaveApplied`): quem chama trata como incerta e
 *   resolve por GET. Nenhum retry aqui.
 *
 * Roda em Deno (Edge Functions) e em Node (vitest): nada de API exclusiva do Deno.
 */

import { DATAFY_BASE_URL } from "./datafy-client.ts";
import { shapeOf } from "./webhook-payload-shape-core.ts";

export const DATAFY_ADMIN_TIMEOUT_MS = 10_000;

/**
 * Teto de `timeoutMs`, cobrindo a resposta INTEIRA (cabeçalho e corpo). O piso do
 * TTL do claim do onboarding é 30 s. O adapter revalida fence e orçamento
 * imediatamente antes de mutar. Timeout não desfaz POST já aceito, nem cria
 * exactly-once distribuído: resposta ambígua continua exigindo reconciliação.
 */
export const DATAFY_ADMIN_MAX_TIMEOUT_MS = 20_000;

/** Corpo maior que isto (declarado ou lido) vira `unrecognized` sem ser parseado. */
export const DATAFY_ADMIN_MAX_BODY_BYTES = 1024 * 1024;

/** Único host aceito no link de conexão: ele é aberto no navegador do lojista. */
export const DATAFY_CONNECT_LINK_HOST = "app.datafyapi.com.br";

const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Mesmo formato que `datafy-account-config-core.ts` exige do `sk_acct_`: ASCII
// visível, sem espaço nem quebra de linha, porque o valor vai num header.
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export type DatafyAdminErrorKind =
  | "unauthorized" | "account_inactive" | "not_found" | "conflict" | "payment_declined"
  | "invalid" | "rate_limited" | "server_error" | "transport" | "unrecognized";

export type DatafyAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: DatafyAdminErrorKind; httpStatus: number | null; code: string };

export interface DatafyWebhook { id: string; url: string; events: string[]; enabled: boolean }
export interface DatafyChannelCreated { id: string; token: string; webhookSecret: string; subscribed: boolean }
export interface DatafyChannelListItem {
  id: string; name: string; subscribed: boolean; onTrial: boolean; trialEndsAt: string | null; paused: boolean;
  phoneNumberId: string | null; wabaId: string | null; businessId: string | null;
}
export interface DatafyChannelSnapshot extends DatafyChannelListItem {
  displayPhone: string | null;
  token: string | null; webhookSecret: string | null;   // nullable: a Fase 0 não registrou os dois no GET de forma explícita
  webhooks: DatafyWebhook[];                             // ausente no corpo → []; presente e não-array → unrecognized
}

export interface DatafyAdminClientDeps {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * O adapter passa `jsonLog`. Recebe FORMA, nunca valor: `shape` é a forma do
   * corpo ou, quando o defeito está num item (canal da lista, `webhooks[]`),
   * `{ top, item }`. Pode ser assíncrono; falha dele nunca muda o desfecho.
   */
  onUnrecognized?: (info: { operation: string; httpStatus: number; shape: unknown }) => void;
}

// Tokens fixos no formato ^[A-Z0-9_]{1,64}$: vão para `last_error`.
const CODE_BY_KIND: Record<DatafyAdminErrorKind, string> = {
  unauthorized: "DATAFY_UNAUTHORIZED",
  payment_declined: "DATAFY_PAYMENT_DECLINED",
  account_inactive: "DATAFY_ACCOUNT_INACTIVE",
  not_found: "DATAFY_NOT_FOUND",
  conflict: "DATAFY_CONFLICT",
  invalid: "DATAFY_INVALID_REQUEST",
  rate_limited: "DATAFY_RATE_LIMITED",
  server_error: "DATAFY_SERVER_ERROR",
  transport: "DATAFY_TRANSPORT",
  unrecognized: "DATAFY_UNRECOGNIZED",
};
const INVALID_ID_CODE = "DATAFY_INVALID_ID";

/** `null` em 2xx; qualquer status fora da tabela medida é `unrecognized`. */
export function classifyDatafyAdminStatus(status: number): DatafyAdminErrorKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_declined";
  if (status === 403) return "account_inactive";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "server_error";
  return "unrecognized";
}

/**
 * Uma mutação (`createChannel`, `createWebhook`, `subscribe`) que falhou com este
 * `kind` PODE ter sido aplicada na Datafy: a resposta não chegou, chegou ilegível
 * ou veio de um servidor em erro depois de agir. O chamador trata como incerta e
 * decide pelo GET, nunca repostando às cegas. Os demais `kind` são recusas
 * comprovadas (inclusive `invalid` sem `httpStatus`, que nem chegou ao fetch).
 */
export function datafyMutationMayHaveApplied(kind: DatafyAdminErrorKind): boolean {
  return kind === "transport" || kind === "server_error" || kind === "unrecognized";
}

function failure<T>(kind: DatafyAdminErrorKind, httpStatus: number | null, code = CODE_BY_KIND[kind]): DatafyAdminResult<T> {
  return { ok: false, kind, httpStatus, code };
}

// --- Forma para telemetria ------------------------------------------------------
// `shapeOf` emite os NOMES de chave do primeiro nível. Aqui ele recebe justamente o
// corpo que não reconhecemos, e um corpo `{"sk_live_…": true}` publicaria o segredo
// como nome de chave. Só passa nome do vocabulário de protocolo (letras e `_`, sem
// dígito, sem prefixo de credencial); o resto vira `<key>`.

const SHAPE_KEY_PATTERN = /^[A-Za-z][A-Za-z_]{0,39}$/;
const SECRET_KEY_PREFIX = /^(sk_|whsec_|ct_)/i;
const REDACTED_KEY = "<key>";

function redactedShapeOf(value: unknown): unknown {
  const shape = shapeOf(value);
  if (shape === null || typeof shape !== "object") return shape;
  const out: Record<string, unknown> = {};
  const hiddenShapes = new Set<string>();
  for (const [key, inner] of Object.entries(shape as Record<string, unknown>)) {
    if (SHAPE_KEY_PATTERN.test(key) && !SECRET_KEY_PREFIX.test(key)) {
      out[key] = inner;
    } else {
      // Chaves ocultas colapsam numa só; o valor diz só quais formas havia.
      hiddenShapes.add(typeof inner === "string" ? inner : "object");
    }
  }
  if (hiddenShapes.size > 0) out[REDACTED_KEY] = [...hiddenShapes].sort().join("|");
  return out;
}

// --- Leitura de campos ---------------------------------------------------------
// Tudo por `typeof`, nunca `String(...)`: `String(["sk_live_x"])` é "sk_live_x".

const BAD = Symbol("bad");

/** Desfecho de um parser: valor, ou recusa com o primeiro sub-objeto culpado. */
type Decoded<T> = { ok: true; value: T } | { ok: false; offending?: { value: unknown } };

const REJECT: Decoded<never> = { ok: false };

function accept<T>(value: T | null): Decoded<T> {
  return value === null ? REJECT : { ok: true, value };
}

function rejectItem(value: unknown): Decoded<never> {
  return { ok: false, offending: { value } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Identidade que a Fase 0 mediu PRESENTE (`null` sem número). Ausente é forma
 * desconhecida, não "sem número": tratar ausência como `null` faria o chamador
 * emitir link para canal já conectado, e esse link troca o número do canal.
 */
function presentNullableId(record: Record<string, unknown>, key: string): string | null | typeof BAD {
  if (!has(record, key)) return BAD;
  return nullableString(record[key]);
}

/** Campo que não decide nada: ausente vale `null`. */
function optionalNullableString(record: Record<string, unknown>, key: string): string | null | typeof BAD {
  return has(record, key) ? nullableString(record[key]) : null;
}

function nullableString(value: unknown): string | null | typeof BAD {
  if (value === null) return null;
  if (typeof value !== "string") return BAD;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function channelId(value: unknown): string | null {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value) ? value : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseListItem(value: unknown): DatafyChannelListItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = channelId(record.id);
  if (!id || typeof record.name !== "string") return null;
  const { subscribed, on_trial: onTrial, paused } = record;
  if (typeof subscribed !== "boolean" || typeof onTrial !== "boolean" || typeof paused !== "boolean") return null;
  const trialEndsAt = optionalNullableString(record, "trial_ends_at");
  const phoneNumberId = presentNullableId(record, "phone_number_id");
  const wabaId = presentNullableId(record, "waba_id");
  const businessId = presentNullableId(record, "business_id");
  if (trialEndsAt === BAD || phoneNumberId === BAD || wabaId === BAD || businessId === BAD) return null;
  return { id, name: record.name, subscribed, onTrial, trialEndsAt, paused, phoneNumberId, wabaId, businessId };
}

function parseWebhook(value: unknown): DatafyWebhook | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = requiredString(record.id);
  if (!id || typeof record.url !== "string" || !isStringArray(record.events) || typeof record.enabled !== "boolean") {
    return null;
  }
  return { id, url: record.url, events: [...record.events], enabled: record.enabled };
}

function parseChannelList(value: unknown): Decoded<{ accountSubscription: string | null; channels: DatafyChannelListItem[] }> {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.channels)) return REJECT;
  const accountSubscription = optionalNullableString(record, "subscription");
  if (accountSubscription === BAD) return REJECT;
  // Um item ilegível derruba a lista inteira: a reconciliação por nome não pode
  // concluir "não existe" a partir de uma lista parcial.
  const channels: DatafyChannelListItem[] = [];
  for (const item of record.channels) {
    const parsed = parseListItem(item);
    if (!parsed) return rejectItem(item);
    channels.push(parsed);
  }
  return { ok: true, value: { accountSubscription, channels } };
}

function parseSnapshot(value: unknown): Decoded<DatafyChannelSnapshot> {
  const item = parseListItem(value);
  if (!item) return REJECT;
  const record = value as Record<string, unknown>;
  const displayPhone = optionalNullableString(record, "phone");
  const token = optionalNullableString(record, "token");
  const webhookSecret = optionalNullableString(record, "webhook_secret");
  if (displayPhone === BAD || token === BAD || webhookSecret === BAD) return REJECT;
  const webhooks: DatafyWebhook[] = [];
  if (has(record, "webhooks")) {
    if (!Array.isArray(record.webhooks)) return rejectItem(record.webhooks);
    for (const entry of record.webhooks) {
      const parsed = parseWebhook(entry);
      if (!parsed) return rejectItem(entry);
      webhooks.push(parsed);
    }
  }
  return { ok: true, value: { ...item, displayPhone, token, webhookSecret, webhooks } };
}

function parseCreated(value: unknown): DatafyChannelCreated | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = channelId(record.id);
  const token = requiredString(record.token);
  const webhookSecret = requiredString(record.webhook_secret);
  if (!id || !token || !webhookSecret || typeof record.subscribed !== "boolean") return null;
  return { id, token, webhookSecret, subscribed: record.subscribed };
}

function parseConnectLink(value: unknown): { url: string; expiresInSeconds: number } | null {
  const record = asRecord(value);
  if (!record || typeof record.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return null;
  }
  // Porta e credencial na URL também recusam: o hostname confere, mas o link
  // deixaria de ser o que a Datafy mediu.
  if (
    url.protocol !== "https:" || url.hostname !== DATAFY_CONNECT_LINK_HOST ||
    url.port !== "" || url.username !== "" || url.password !== ""
  ) {
    return null;
  }
  const expires = record.expires_in;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return null;
  // O `ct_` de `record.token` é descartado de propósito: ninguém além do
  // navegador do lojista precisa dele, e fora da URL ele só teria como vazar.
  return { url: url.href, expiresInSeconds: expires };
}

function parseSubscribed(value: unknown): { subscribed: boolean } | null {
  const record = asRecord(value);
  return record && typeof record.subscribed === "boolean" ? { subscribed: record.subscribed } : null;
}

// --- Transporte -------------------------------------------------------------------

type Body =
  | { kind: "json"; value: unknown }
  | { kind: "empty" }
  | { kind: "non_json" }
  | { kind: "oversized" };

function parseBody(text: string): Body {
  if (text.length === 0) return { kind: "empty" };
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "non_json" };
  }
}

/**
 * Lê o corpo com teto de bytes: pelo `Content-Length` quando declarado, e contando
 * o que chega quando não. Roda sob o mesmo `signal` do fetch, então o timeout
 * também corta um corpo que nunca termina (a leitura rejeita e vira `transport`).
 */
async function readBodyLimited(response: Response): Promise<Body> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > DATAFY_ADMIN_MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return { kind: "oversized" };
  }
  const stream = response.body;
  if (!stream) return { kind: "empty" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DATAFY_ADMIN_MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return { kind: "oversized" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseBody(new TextDecoder().decode(bytes));
}

/** Forma para telemetria. Corpo não-JSON vira marcador: o texto cru nunca sai. */
function bodyShape(body: Body): unknown {
  if (body.kind === "json") return redactedShapeOf(body.value);
  if (body.kind === "empty") return "empty_body";
  return body.kind === "oversized" ? "oversized_body" : "non_json_body";
}

function jsonBody<T>(parse: (value: unknown) => Decoded<T>): (body: Body) => Decoded<T> {
  return (body) => (body.kind === "json" ? parse(body.value) : REJECT);
}

type Operation =
  | "listChannels" | "createChannel" | "getChannel" | "createWebhook" | "createConnectLink"
  | "subscribe" | "cancel" | "pause" | "resume" | "deleteChannel";

export function createDatafyAdminClient(deps: DatafyAdminClientDeps) {
  // Lido na hora da chamada: o fetch global pode ser trocado depois (testes).
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = (deps.baseUrl ?? DATAFY_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(deps.timeoutMs, DATAFY_ADMIN_MAX_TIMEOUT_MS)
    : DATAFY_ADMIN_TIMEOUT_MS;
  const token = typeof deps.token === "string" && TOKEN_PATTERN.test(deps.token) ? deps.token : null;

  function report(operation: Operation, httpStatus: number, body: Body, offending?: { value: unknown }): void {
    if (!deps.onUnrecognized) return;
    const shape = offending
      ? { top: bodyShape(body), item: redactedShapeOf(offending.value) }
      : bodyShape(body);
    try {
      const returned: unknown = deps.onUnrecognized({ operation, httpStatus, shape });
      // Callback assíncrono que rejeita viraria unhandled rejection no runtime.
      if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
        (returned as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // Telemetria que falha nunca muda o desfecho de uma chamada com custo.
    }
  }

  async function exchange<T>(
    operation: Operation,
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload: unknown,
    decode: (body: Body) => Decoded<T>,
  ): Promise<DatafyAdminResult<T>> {
    if (token === null) return failure("invalid", null);

    // Accept e Content-Type sempre, como na medição da Fase 0 (o probe os mandou
    // inclusive em POST sem corpo, e foi assim que se mediu 200).
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      redirect: "error",
    };
    if (payload !== undefined) init.body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let body: Body;
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal });
      status = response.status;
      body = await readBodyLimited(response);
    } catch {
      // Sem a exceção original nem `cause`: a mensagem do fetch pode embutir URL,
      // header e corpo. Timeout cai aqui também (abort rejeita o fetch e a leitura).
      return failure("transport", null);
    } finally {
      clearTimeout(timer);
    }

    if (body.kind === "oversized") {
      report(operation, status, body);
      return failure("unrecognized", status);
    }
    const kind = classifyDatafyAdminStatus(status);
    if (kind !== null) {
      if (kind === "unrecognized") report(operation, status, body);
      return failure(kind, status);
    }
    const decoded = decode(body);
    if (decoded.ok === false) {
      report(operation, status, body, decoded.offending);
      return failure("unrecognized", status);
    }
    return { ok: true, value: decoded.value };
  }

  /** Caminho do canal, ou `null` se o id não tem o formato aceito. */
  function channelPath(id: unknown, suffix = ""): string | null {
    const valid = channelId(id);
    return valid === null ? null : `/channels/whatsapp/${encodeURIComponent(valid)}${suffix}`;
  }

  /** Operação não medida: qualquer 2xx confirma; o estado efetivo vem do GET seguinte. */
  function acknowledge(operation: "cancel" | "pause" | "resume", id: string): Promise<DatafyAdminResult<{ acknowledged: true }>> {
    const path = channelPath(id, `/${operation}`);
    if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
    return exchange(operation, "POST", path, undefined, () => ({ ok: true, value: { acknowledged: true as const } }));
  }

  return {
    listChannels(): Promise<DatafyAdminResult<{ accountSubscription: string | null; channels: DatafyChannelListItem[] }>> {
      return exchange("listChannels", "GET", "/channels/whatsapp", undefined, jsonBody(parseChannelList));
    },

    createChannel(input: { name: string; description: string }): Promise<DatafyAdminResult<DatafyChannelCreated>> {
      // POST não idempotente: entrada malformada não pode chegar a ele.
      if (!requiredString(input?.name) || typeof input?.description !== "string") {
        return Promise.resolve(failure("invalid", null));
      }
      return exchange(
        "createChannel", "POST", "/channels/whatsapp",
        { name: input.name, description: input.description },
        jsonBody((value) => accept(parseCreated(value))),
      );
    },

    getChannel(id: string): Promise<DatafyAdminResult<DatafyChannelSnapshot>> {
      const path = channelPath(id);
      if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
      return exchange("getChannel", "GET", path, undefined, jsonBody(parseSnapshot));
    },

    createWebhook(id: string, input: { url: string; events: string[] }): Promise<DatafyAdminResult<{ webhookId: string }>> {
      const path = channelPath(id, "/webhooks");
      if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
      if (typeof input?.url !== "string" || !input.url || !isStringArray(input?.events)) {
        return Promise.resolve(failure("invalid", null));
      }
      return exchange(
        "createWebhook", "POST", path, { url: input.url, events: [...input.events] },
        jsonBody((value) => {
          const webhook = parseWebhook(value);
          return accept(webhook ? { webhookId: webhook.id } : null);
        }),
      );
    },

    createConnectLink(id: string): Promise<DatafyAdminResult<{ url: string; expiresInSeconds: number }>> {
      const path = channelPath(id, "/connect-link");
      if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
      return exchange("createConnectLink", "POST", path, undefined, jsonBody((value) => accept(parseConnectLink(value))));
    },

    /**
     * Cobra na hora. Um 2xx com `subscribed: false` é `ok: true` com esse valor:
     * o cliente não interpreta, e o chamador decide pelo GET que faz em seguida.
     */
    subscribe(id: string): Promise<DatafyAdminResult<{ subscribed: boolean }>> {
      const path = channelPath(id, "/subscribe");
      if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
      return exchange("subscribe", "POST", path, undefined, jsonBody((value) => accept(parseSubscribed(value))));
    },

    cancel(id: string) {
      return acknowledge("cancel", id);
    },
    pause(id: string) {
      return acknowledge("pause", id);
    },
    resume(id: string) {
      return acknowledge("resume", id);
    },

    /** Qualquer 2xx confirma; 404 chega como `not_found` ("já não existe"). */
    deleteChannel(id: string): Promise<DatafyAdminResult<{ deleted: true }>> {
      const path = channelPath(id);
      if (path === null) return Promise.resolve(failure("invalid", null, INVALID_ID_CODE));
      return exchange("deleteChannel", "DELETE", path, undefined, () => ({ ok: true, value: { deleted: true as const } }));
    },
  };
}

export type DatafyAdminClient = ReturnType<typeof createDatafyAdminClient>;

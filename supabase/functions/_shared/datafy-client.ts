/**
 * Cliente HTTP único da Datafy. Nenhum `fetch()` da Datafy pode nascer fora
 * daqui — é o que mantém base URL, autenticação, timeout e classificação de
 * erro num lugar só quando a API evoluir.
 *
 * A Datafy é proxy da Cloud API: `/v1/...` espelha a Graph API da Meta, e os
 * endpoints próprios (`/me`, `/media/{id}`) ficam fora do `/v1`. Por isso o
 * `path` é relativo à raiz, não ao `/v1`.
 */

import type { ChannelCredentials, WhatsAppProviderAdapter, WhatsAppProviderErrorCode } from "./whatsapp-provider-core.ts";
import {
  buildTemplateMessage, buildTemplateSubmission, classifyTemplateMutationResponse,
  nextTemplateCursor, parseTemplatePage,
  type TemplateMutationFailure,
} from "./whatsapp-template-provider-core.ts";

export const DATAFY_BASE_URL = "https://cloud.datafyapi.com.br";

export interface DatafyAccount {
  clienteId: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessId: string | null;
}

export function buildDatafyRequest(input: {
  token: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}): { url: string; init: RequestInit } {
  const path = input.path.replace(/^\/+/, "");
  const hasBody = input.body !== undefined;
  return {
    // O token vai SEMPRE em header. A Z-API deste repo carrega credencial no
    // path e por isso precisa de redação de erro; aqui a URL é inofensiva.
    url: `${DATAFY_BASE_URL}/${path}`,
    init: {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    },
  };
}

/**
 * `402` é "assinatura Datafy inativa" e `403` é "operação bloqueada ou recurso
 * fora do token". Os dois são problema de credencial/autorização do nosso lado,
 * não indisponibilidade — agrupá-los em AUTH_ERROR impede retry inútil.
 */
export function classifyDatafyStatus(status: number): WhatsAppProviderErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 402 || status === 403) return "AUTH_ERROR";
  if (status === 404) return "INSTANCE_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN_PROVIDER_ERROR";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * `phone_number_id` é obrigatório: é ele que identifica o canal e que a guarda
 * de identidade cross-tenant compara. Sem ele a descoberta não serve para nada,
 * e aceitar o resto faria um canal nascer sem âncora.
 */
export function parseDatafyAccount(body: unknown): DatafyAccount | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const phoneNumberId = str(record.phone_number_id);
  if (!phoneNumberId) return null;
  return {
    clienteId: str(record.cliente_id),
    phoneNumberId,
    wabaId: str(record.waba_id),
    businessId: str(record.business_id),
  };
}

/**
 * A Cloud API devolve `messages[0].id` (`wamid....`). Ausente, devolvemos
 * undefined em vez de inventar: `notifications_sent` correlaciona recibo por
 * esse id, e um valor fabricado faria o rastreio casar com a linha errada.
 */
export function pickDatafyMessageId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || !messages.length) return undefined;
  const first = messages[0];
  if (!first || typeof first !== "object") return undefined;
  return str((first as Record<string, unknown>).id) ?? undefined;
}

export const DATAFY_TEMPLATE_FIELDS = 'id,name,language,status,category,parameter_format,components,rejected_reason';

export class DatafyTemplateError extends Error {
  constructor(readonly code: WhatsAppProviderErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'DatafyTemplateError';
  }
}

type TemplateTransport = Required<Pick<WhatsAppProviderAdapter, 'listTemplates' | 'createTemplate' | 'sendTemplate'>>;

/**
 * Same factory for production and fake HTTP tests. No hidden POST retry: callers
 * must reconcile uncertainty or schedule a proven refusal in the durable ledger.
 */
export function createDatafyTemplateTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): TemplateTransport {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, 15_000) : 15_000;

  function requireTarget(credentials: ChannelCredentials, id: string): string {
    if (!credentials.access_token?.trim()) throw new DatafyTemplateError('INVALID_REQUEST', 'missing_credentials');
    // Graph resource IDs are decimal strings. Refuse dot segments or separators before building a URL.
    if (typeof id !== 'string' || !/^\d{1,64}$/.test(id)) throw new DatafyTemplateError('INVALID_REQUEST', 'template_target_invalid');
    return credentials.access_token;
  }

  async function request(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
    const { url, init } = buildDatafyRequest({ token, method, path, body });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Refuse redirects, including responses that could forward authentication to a remote origin.
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      return { status: response.status, body: await response.json().catch(() => null) as unknown };
    } catch {
      // No original exception/cause: fetch errors can contain URLs, tokens and request bodies.
      throw new DatafyTemplateError(controller.signal.aborted ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        controller.signal.aborted ? 'datafy_template_timeout' : 'datafy_template_fetch_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  const invalid = (error: unknown): TemplateMutationFailure => ({
    state: 'rejected', retryable: false, errorCode: 'INVALID_REQUEST',
    error: error instanceof DatafyTemplateError ? error.message : 'template_input_invalid',
  });
  const uncertain = (error: unknown): TemplateMutationFailure => ({
    state: 'uncertain', error: error instanceof DatafyTemplateError ? error.message : 'datafy_template_fetch_failed',
    errorCode: error instanceof DatafyTemplateError ? error.code : 'PROVIDER_UNAVAILABLE',
  });

  return {
    async listTemplates(credentials, input) {
      const token = requireTarget(credentials, input.wabaId);
      const query = new URLSearchParams({ fields: DATAFY_TEMPLATE_FIELDS });
      if (input.after !== undefined) query.set('after', nextTemplateCursor(input.after, new Set()));
      const response = await request(token, 'GET', `v1/${encodeURIComponent(input.wabaId)}/message_templates?${query}`);
      const code = classifyDatafyStatus(response.status);
      if (code) throw new DatafyTemplateError(code, `datafy_template_http_${response.status}`, response.status);
      // Include the request cursor to reject immediate cycles; the sync service supplies its full seen set.
      return parseTemplatePage(response.body, new Set(input.after === undefined ? [] : [input.after]));
    },
    async createTemplate(credentials, input) {
      let token: string;
      let body: ReturnType<typeof buildTemplateSubmission>;
      try {
        token = requireTarget(credentials, input.wabaId);
        body = buildTemplateSubmission(input.definition);
      } catch (error) { return invalid(error); }
      try {
        const response = await request(token, 'POST', `v1/${encodeURIComponent(input.wabaId)}/message_templates`, body);
        const failure = classifyTemplateMutationResponse(response.status, response.body);
        if (failure) return failure;
        const entry = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
          ? response.body as Record<string, unknown> : null;
        const id = str(entry?.id);
        if (!id || entry?.error !== undefined) return { state: 'uncertain', status: response.status,
          error: 'datafy_template_response_invalid', errorCode: 'UNKNOWN_PROVIDER_ERROR' };
        return { state: 'accepted', status: response.status, remoteId: id,
          remoteStatus: str(entry?.status), category: str(entry?.category) };
      } catch (error) { return uncertain(error); }
    },
    async sendTemplate(credentials, input) {
      let token: string;
      let body: ReturnType<typeof buildTemplateMessage>;
      try {
        token = requireTarget(credentials, input.phoneNumberId);
        body = buildTemplateMessage(input);
      } catch (error) { return invalid(error); }
      try {
        const response = await request(token, 'POST', `v1/${encodeURIComponent(input.phoneNumberId)}/messages`, body);
        const failure = classifyTemplateMutationResponse(response.status, response.body);
        if (failure) return failure;
        const id = pickDatafyMessageId(response.body);
        if (!id || (response.body as Record<string, unknown>)?.error !== undefined) return { state: 'uncertain', status: response.status,
          error: 'datafy_template_response_invalid', errorCode: 'UNKNOWN_PROVIDER_ERROR' };
        return { state: 'accepted', status: response.status, providerMessageId: id };
      } catch (error) { return uncertain(error); }
    },
  };
}

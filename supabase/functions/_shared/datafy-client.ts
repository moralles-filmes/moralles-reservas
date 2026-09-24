/**
 * Cliente HTTP único da Datafy. Nenhum `fetch()` da Datafy pode nascer fora
 * daqui — é o que mantém base URL, autenticação, timeout e classificação de
 * erro num lugar só quando a API evoluir.
 *
 * A Datafy é proxy da Cloud API: `/v1/...` espelha a Graph API da Meta, e os
 * endpoints próprios (`/me`, `/media/{id}`) ficam fora do `/v1`. Por isso o
 * `path` é relativo à raiz, não ao `/v1`.
 */

import type { WhatsAppProviderErrorCode } from "./whatsapp-provider-core.ts";

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

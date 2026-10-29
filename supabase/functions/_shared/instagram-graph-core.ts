/**
 * Núcleo puro do cliente do Graph do Instagram (Login com Instagram).
 * Sem Deno e sem imports remotos: o Vitest importa direto.
 */

export const INSTAGRAM_GRAPH_VERSION = "v26.0";
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"] as const;
export const INSTAGRAM_SUBSCRIBED_FIELDS = ["messages"] as const;

export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";

export type GraphErrorClass =
  | "reauth_required"
  | "window_closed"
  | "rate_limited"
  | "recipient_unavailable"
  | "transient"
  | "invalid_request";

const RECIPIENT_UNAVAILABLE = new Set([551, 2018108, 2534014, 2018001]);
const WINDOW_CLOSED = new Set([10, 2534022]);

export function classifyGraphError(i: {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
}): GraphErrorClass {
  const { httpStatus, code, subcode } = i;
  if (code === 190) return "reauth_required";
  if ((code !== null && WINDOW_CLOSED.has(code)) || (subcode !== null && WINDOW_CLOSED.has(subcode))) {
    return "window_closed";
  }
  if (code === 4 || code === 613 || code === 17 || code === 32) return "rate_limited";
  if (
    (code !== null && RECIPIENT_UNAVAILABLE.has(code)) ||
    (subcode !== null && RECIPIENT_UNAVAILABLE.has(subcode))
  ) {
    return "recipient_unavailable";
  }
  if (code === 1 || code === 2) return "transient";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === null || httpStatus >= 500) return "transient";
  return "invalid_request";
}

export function buildAuthorizeUrl(i: { appId: string; redirectUri: string; state: string }): string {
  // Vírgula literal entre escopos (formato da documentação da Meta); o resto é codificado.
  const q = [
    `client_id=${encodeURIComponent(i.appId)}`,
    `redirect_uri=${encodeURIComponent(i.redirectUri)}`,
    `response_type=code`,
    `scope=${INSTAGRAM_SCOPES.join(",")}`,
    `state=${encodeURIComponent(i.state)}`,
  ].join("&");
  return `${INSTAGRAM_AUTHORIZE_URL}?${q}`;
}

export function stripOAuthCodeSuffix(code: string): string {
  return code.endsWith("#_") ? code.slice(0, -2) : code;
}

/**
 * Remove segredos conhecidos (crus e codificados) e, por garantia, qualquer
 * valor de `access_token=`/`client_secret=` em query.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== "string" || s.trim() === "") continue;
    for (const form of new Set([s, encodeURIComponent(s)])) {
      out = out.split(form).join("[redacted]");
    }
  }
  return out.replace(/(access_token|client_secret|(?<![A-Za-z0-9_])code)=[^&\s"']*/gi, "$1=[redacted]");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function parseCodeExchange(json: unknown): { shortToken: string } | null {
  if (!isObj(json)) return null;
  const row = Array.isArray(json.data) ? json.data[0] : json;
  if (!isObj(row)) return null;
  const t = str(row.access_token);
  return t ? { shortToken: t } : null;
}

export function parseLongLived(json: unknown): { token: string; expiresInSec: number } | null {
  if (!isObj(json)) return null;
  const t = str(json.access_token);
  const e = json.expires_in;
  if (!t || typeof e !== "number" || !Number.isInteger(e) || e <= 0) return null;
  return { token: t, expiresInSec: e };
}

export function parseMe(
  json: unknown,
): { igUserId: string; username: string | null; accountType: string | null } | null {
  if (!isObj(json)) return null;
  const raw = json.user_id;
  // Número só se for inteiro seguro: ids de 17 dígitos perdem precisão no JSON.parse.
  const id = typeof raw === "number" ? (Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null) : str(raw);
  if (!id) return null;
  return { igUserId: id, username: str(json.username), accountType: str(json.account_type) };
}

/** Extrai code/subcode de `{error:{code,error_subcode}}` ou `{code,error_message}`. */
export function parseGraphErrorBody(json: unknown): { code: number | null; subcode: number | null } {
  if (!isObj(json)) return { code: null, subcode: null };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const e = isObj(json.error) ? json.error : json;
  return { code: num(e.code), subcode: num(e.error_subcode) };
}

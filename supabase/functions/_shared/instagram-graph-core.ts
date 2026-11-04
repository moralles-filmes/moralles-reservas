/**
 * Núcleo puro do cliente do Graph do Instagram (Login do Facebook para Empresas com a Página).
 * Sem Deno e sem imports remotos: o Vitest importa direto.
 */

export const INSTAGRAM_GRAPH_VERSION = "v26.0";
export const INSTAGRAM_SUBSCRIBED_FIELDS = ["messages"] as const;

export const INSTAGRAM_AUTHORIZE_URL = `https://www.facebook.com/${INSTAGRAM_GRAPH_VERSION}/dialog/oauth`;

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

export function buildAuthorizeUrl(i: { appId: string; redirectUri: string; state: string; configId: string }): string {
  // Sem `scope`: as permissões vêm da configuração (config_id) do Login do Facebook para Empresas.
  const q = [
    `client_id=${encodeURIComponent(i.appId)}`,
    `redirect_uri=${encodeURIComponent(i.redirectUri)}`,
    `state=${encodeURIComponent(i.state)}`,
    `config_id=${encodeURIComponent(i.configId)}`,
    `response_type=code`,
    `override_default_response_type=true`,
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

/** Número só se for inteiro seguro: ids de 17 dígitos perdem precisão no JSON.parse. */
function parseId(raw: unknown): string | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
  // Vira segmento de path do Graph e chave da conta: só dígitos, sem zero à esquerda, até 64.
  return typeof raw === "string" && /^[1-9][0-9]{0,63}$/.test(raw) ? raw : null;
}

export function parseCodeExchange(json: unknown): { shortToken: string } | null {
  if (!isObj(json)) return null;
  const t = str(json.access_token);
  return t ? { shortToken: t } : null;
}

export function parseLongLived(json: unknown): { token: string; expiresInSec: number } | null {
  if (!isObj(json)) return null;
  const t = str(json.access_token);
  const e = json.expires_in;
  if (!t || typeof e !== "number" || !Number.isInteger(e) || e <= 0 || e > 90 * 86_400) return null;
  return { token: t, expiresInSec: e };
}

export function parseUserLongLived(json: unknown): { token: string } | null {
  if (!isObj(json)) return null;
  const t = str(json.access_token);
  return t ? { token: t } : null;
}

export type PageCandidate = {
  pageId: string;
  pageName: string | null;
  pageToken: string;
  tasks: string[];
  igUserId: string;
  igUsername: string | null;
};

/** `GET /me/accounts`: fica só a Página com token, id e conta do Instagram válidos. */
export function parsePages(json: unknown): PageCandidate[] | null {
  if (!isObj(json) || !Array.isArray(json.data)) return null;
  const out: PageCandidate[] = [];
  for (const row of json.data) {
    if (!isObj(row)) continue;
    const pageToken = str(row.access_token);
    const pageId = parseId(row.id);
    const ig = row.instagram_business_account;
    const igUserId = isObj(ig) ? parseId(ig.id) : null;
    if (!pageToken || !pageId || !igUserId || !isObj(ig)) continue;
    out.push({
      pageId,
      pageName: str(row.name),
      pageToken,
      tasks: Array.isArray(row.tasks) ? row.tasks.filter((t): t is string => typeof t === "string") : [],
      igUserId,
      igUsername: str(ig.username),
    });
  }
  return out;
}

export type PageChoice =
  | { kind: "one"; page: PageCandidate }
  | { kind: "none"; reason: "no_instagram" | "insufficient_task" }
  | { kind: "many"; usernames: string[] };

const REQUIRED_TASKS = ["MODERATE", "MANAGE"];

export function choosePage(pages: PageCandidate[]): PageChoice {
  if (pages.length === 0) return { kind: "none", reason: "no_instagram" };
  const ok = pages.filter((p) => p.tasks.some((t) => REQUIRED_TASKS.includes(t)));
  if (ok.length === 0) return { kind: "none", reason: "insufficient_task" };
  if (ok.length === 1) return { kind: "one", page: ok[0] };
  return { kind: "many", usernames: ok.map((p) => p.igUsername ?? p.pageName ?? p.pageId) };
}

/** `data.data_access_expires_at` (segundos) do `debug_token` em ISO; inválido ou 0 dá null. */
export function parseDataAccessExpiry(json: unknown): string | null {
  if (!isObj(json) || !isObj(json.data)) return null;
  const v = json.data.data_access_expires_at;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseMe(
  json: unknown,
): { igUserId: string; username: string | null; accountType: string | null } | null {
  if (!isObj(json)) return null;
  const id = parseId(json.user_id);
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

/**
 * Desfecho desconhecido: a requisição pode ter sido aplicada. Verdadeiro para
 * `ok:false` com HTTP 2xx (corpo ilegível), sem status (timeout/rede) ou, em
 * POST, falha `transient`. O chamador não trata como falha definitiva.
 */
export function isGraphOutcomeUnknown(
  r: { ok: true; value: unknown } | { ok: false; httpStatus: number | null; errorClass: GraphErrorClass },
  method: "GET" | "POST",
): boolean {
  if (r.ok === true) return false;
  const s = r.httpStatus;
  if (s === null) return true;
  if (s >= 200 && s < 300) return true;
  return method === "POST" && r.errorClass === "transient";
}

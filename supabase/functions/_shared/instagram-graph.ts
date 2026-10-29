/**
 * Adapter fino do Graph do Instagram. Recebe `fetch` por injeção.
 * Todo caminho de falha devolve só classe, status HTTP e código numérico:
 * nenhum texto vindo da Meta ou do runtime chega ao resultado, então nenhum
 * token pode vazar por ele. (R2-e: GETs da Meta que exigem credencial na query
 * passam por redactSecrets antes de qualquer uso da URL.)
 */
import {
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  classifyGraphError,
  parseCodeExchange,
  parseGraphErrorBody,
  parseLongLived,
  parseMe,
  stripOAuthCodeSuffix,
  type GraphErrorClass,
} from "./instagram-graph-core.ts";

export type GraphResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorClass: GraphErrorClass; httpStatus: number | null; code: number | null };

const GRAPH = "https://graph.instagram.com";
const V = `${GRAPH}/${INSTAGRAM_GRAPH_VERSION}`;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createInstagramGraph(fetchImpl: typeof fetch, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const fail = (
    httpStatus: number | null,
    code: number | null,
    subcode: number | null,
  ): { ok: false; errorClass: GraphErrorClass; httpStatus: number | null; code: number | null } => ({
    ok: false,
    errorClass: classifyGraphError({ httpStatus, code, subcode }),
    httpStatus,
    code,
  });

  async function call<T>(
    url: string,
    init: RequestInit,
    parse: (json: unknown) => T | null,
  ): Promise<GraphResult<T>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: ctl.signal });
      } catch {
        // rede, DNS, timeout: a mensagem do erro pode conter a URL, então é descartada.
        return fail(null, null, null);
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const { code, subcode } = parseGraphErrorBody(json);
        return fail(res.status, code, subcode);
      }
      const value = parse(json);
      if (value === null) return fail(res.status, null, null) as GraphResult<T>;
      return { ok: true, value };
    } finally {
      clearTimeout(timer);
    }
  }

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const get = (token: string): RequestInit => ({ method: "GET", headers: bearer(token) });

  return {
    exchangeCode(i: { appId: string; appSecret: string; redirectUri: string; code: string }) {
      const body = new URLSearchParams({
        client_id: i.appId,
        client_secret: i.appSecret,
        grant_type: "authorization_code",
        redirect_uri: i.redirectUri,
        code: stripOAuthCodeSuffix(i.code),
      });
      return call("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, parseCodeExchange);
    },

    toLongLived(i: { appSecret: string; shortToken: string }) {
      const q = new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: i.appSecret,
        access_token: i.shortToken,
      });
      return call(`${GRAPH}/access_token?${q}`, { method: "GET" }, parseLongLived);
    },

    refresh(i: { token: string }) {
      const q = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: i.token });
      return call(`${GRAPH}/refresh_access_token?${q}`, { method: "GET" }, parseLongLived);
    },

    me(i: { token: string }) {
      return call(`${V}/me?fields=user_id,username,account_type`, get(i.token), parseMe);
    },

    subscribe(i: { igUserId: string; token: string }) {
      const url = `${V}/${encodeURIComponent(i.igUserId)}/subscribed_apps?subscribed_fields=${INSTAGRAM_SUBSCRIBED_FIELDS.join(",")}`;
      return call(url, { method: "POST", headers: bearer(i.token) }, (j) =>
        typeof j === "object" && j !== null && (j as { success?: unknown }).success === true
          ? { success: true as const }
          : null);
    },

    sendText(i: { igUserId: string; token: string; igsid: string; text: string }) {
      return call(`${V}/${encodeURIComponent(i.igUserId)}/messages`, {
        method: "POST",
        headers: { ...bearer(i.token), "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: i.igsid }, message: { text: i.text } }),
      }, (j) => {
        const id = typeof j === "object" && j !== null ? (j as { message_id?: unknown }).message_id : null;
        return typeof id === "string" && id !== "" ? { messageId: id } : null;
      });
    },

    profile(i: { igsid: string; token: string }) {
      return call(`${V}/${encodeURIComponent(i.igsid)}?fields=name,username`, get(i.token), (j) => {
        if (typeof j !== "object" || j === null) return null;
        const o = j as { name?: unknown; username?: unknown };
        return {
          name: typeof o.name === "string" ? o.name : null,
          username: typeof o.username === "string" ? o.username : null,
        };
      });
    },
  };
}

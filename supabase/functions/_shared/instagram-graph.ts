/**
 * Adapter fino do Graph para o Direct do Instagram pela Página do Facebook
 * (Login do Facebook para Empresas). Recebe `fetch` por injeção. Host
 * `graph.facebook.com`: troca do código, token longo do usuário, Páginas
 * (`/me/accounts`), `debug_token`, inscrição da Página, envio e perfil.
 *
 * Todo caminho de falha devolve só classe, status HTTP e código numérico:
 * nenhum texto vindo da Meta ou do runtime chega ao resultado, então nenhum
 * token pode vazar por ele. (GETs da Meta que exigem credencial na query levam-na na URL, que
 * nunca sai deste módulo: `exchangeCode`, `toLongLivedUser`, o `input_token` do
 * `debugToken`.)
 *
 * Resultado ambíguo: `ok:false` com `httpStatus` 2xx (corpo ilegível após 2xx) ou
 * `httpStatus: null` (timeout/rede), e `transient` em POST, significam "desfecho
 * desconhecido: a requisição pode ter sido aplicada". O chamador não deve tratar
 * como falha definitiva (o Bloco 4 não reenvia automaticamente).
 *
 * A regra está codificada em `isGraphOutcomeUnknown` (instagram-graph-core.ts): use-a em vez de reimplementar.
 *
 * R2-e é cumprida por omissão: o adapter nunca copia texto remoto ou de runtime
 * para o resultado. Quem acrescentar log deve chamar `redactSecrets` por conta
 * própria, com todas as credenciais da chamada (inclusive o par `appId|appSecret`
 * que o `debugToken` manda no header).
 */
import {
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  classifyGraphError,
  parseCodeExchange,
  parseDataAccessExpiry,
  parseGraphErrorBody,
  parsePages,
  parseUserLongLived,
  stripOAuthCodeSuffix,
  type GraphErrorClass,
} from "./instagram-graph-core.ts";

export type GraphResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorClass: GraphErrorClass; httpStatus: number | null; code: number | null };

const GRAPH = "https://graph.facebook.com";
const V = `${GRAPH}/${INSTAGRAM_GRAPH_VERSION}`;
const PAGES_FIELDS = "id,name,tasks,access_token,instagram_business_account{id,username}";
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
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const successTrue = (j: unknown) => (isObj(j) && j.success === true ? { success: true as const } : null);

  return {
    /** Código → token curto do usuário. A Meta só aceita GET, com as credenciais na query. */
    exchangeCode(i: { appId: string; appSecret: string; redirectUri: string; code: string }) {
      const q = new URLSearchParams({
        client_id: i.appId,
        client_secret: i.appSecret,
        redirect_uri: i.redirectUri,
        code: stripOAuthCodeSuffix(i.code),
      });
      return call(`${V}/oauth/access_token?${q}`, { method: "GET" }, parseCodeExchange);
    },

    /** Token curto → token longo do usuário (cerca de 60 dias). Credenciais na query. */
    toLongLivedUser(i: { appId: string; appSecret: string; shortToken: string }) {
      const q = new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: i.appId,
        client_secret: i.appSecret,
        fb_exchange_token: i.shortToken,
      });
      return call(`${V}/oauth/access_token?${q}`, { method: "GET" }, parseUserLongLived);
    },

    /** Páginas autorizadas, com o token de cada uma e a conta do Instagram ligada. */
    listPages(i: { userToken: string }) {
      return call(`${V}/me/accounts?fields=${PAGES_FIELDS}&limit=100`, get(i.userToken), parsePages);
    },

    /**
     * Prazo de acesso a dados do token (`dataAccessExpiresAt`, ISO ou null). O
     * `input_token` vai na query (a Meta não o aceita em outro lugar); o token
     * do app `appId|appSecret` vai só no header, nunca na URL.
     */
    debugToken(i: { appId: string; appSecret: string; inputToken: string }) {
      const q = new URLSearchParams({ input_token: i.inputToken });
      return call(`${V}/debug_token?${q}`, get(`${i.appId}|${i.appSecret}`), (j) =>
        isObj(j) && isObj(j.data) ? { dataAccessExpiresAt: parseDataAccessExpiry(j) } : null);
    },

    /** Inscreve a Página no app, com o token da Página. */
    subscribePage(i: { pageId: string; pageToken: string }) {
      const url = `${V}/${encodeURIComponent(i.pageId)}/subscribed_apps?subscribed_fields=${INSTAGRAM_SUBSCRIBED_FIELDS.join(",")}`;
      return call(url, { method: "POST", headers: bearer(i.pageToken) }, successTrue);
    },

    /** Envio pela Página, com o token da Página. */
    sendText(i: { pageId: string; token: string; igsid: string; text: string }) {
      return call(`${V}/${encodeURIComponent(i.pageId)}/messages`, {
        method: "POST",
        headers: { ...bearer(i.token), "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: i.igsid }, message: { text: i.text } }),
      }, (j) => {
        const id = isObj(j) ? j.message_id : null;
        return typeof id === "string" && id !== "" ? { messageId: id } : null;
      });
    },

    profile(i: { igsid: string; token: string }) {
      return call(`${V}/${encodeURIComponent(i.igsid)}?fields=name,username`, get(i.token), (j) => {
        if (!isObj(j)) return null;
        return {
          name: typeof j.name === "string" ? j.name : null,
          username: typeof j.username === "string" ? j.username : null,
        };
      });
    },
  };
}

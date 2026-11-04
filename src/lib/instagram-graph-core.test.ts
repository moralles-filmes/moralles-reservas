import { describe, expect, it } from "vitest";
import {
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  buildAuthorizeUrl,
  choosePage,
  classifyGraphError,
  isGraphOutcomeUnknown,
  parseCodeExchange,
  parseDataAccessExpiry,
  parseLongLived,
  parseMe,
  parsePages,
  parseUserLongLived,
  redactSecrets,
  stripOAuthCodeSuffix,
  type PageCandidate,
} from "../../supabase/functions/_shared/instagram-graph-core";
import { createInstagramGraph } from "../../supabase/functions/_shared/instagram-graph";

const TOKEN = "IGAA-test-token-XYZ";
const SECRET = "app-secret-test-ABC";
const SHORT = "IGAA-short-test-QRS";

describe("constantes", () => {
  it("fixa versão e campos", () => {
    expect(INSTAGRAM_GRAPH_VERSION).toBe("v26.0");
    expect(INSTAGRAM_SUBSCRIBED_FIELDS).toEqual(["messages"]);
  });
});

describe("classifyGraphError", () => {
  const cases: Array<[number | null, number | null, number | null, string]> = [
    [400, 190, null, "reauth_required"],
    [400, 10, null, "window_closed"],
    [400, 100, 2534022, "window_closed"],
    [400, 4, null, "rate_limited"],
    [400, 613, null, "rate_limited"],
    [400, 551, null, "recipient_unavailable"],
    [400, 100, 2018108, "recipient_unavailable"],
    [400, 100, 2534014, "recipient_unavailable"],
    [400, 100, 2018001, "recipient_unavailable"],
    [500, null, null, "transient"],
    [503, 1, null, "transient"],
    [null, null, null, "transient"],
    [400, 100, null, "invalid_request"],
    [404, null, null, "invalid_request"],
    [400, null, null, "invalid_request"],
    [429, null, null, "rate_limited"],
    [400, 17, null, "rate_limited"],
    [400, 32, null, "rate_limited"],
    [400, 1, null, "transient"],
    [400, 2, null, "transient"],
    [429, 190, null, "reauth_required"],
  ];
  it.each(cases)("http=%s code=%s subcode=%s -> %s", (httpStatus, code, subcode, expected) => {
    expect(classifyGraphError({ httpStatus, code, subcode })).toBe(expected);
  });
});

describe("buildAuthorizeUrl", () => {
  it("monta URL do Login do Facebook com config_id, sem scope, state codificado", () => {
    const u = buildAuthorizeUrl({ appId: "123", redirectUri: "https://x.test/cb?a=1", state: "a.b c/d+e", configId: "999" });
    const url = new URL(u);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("123");
    expect(p.get("redirect_uri")).toBe("https://x.test/cb?a=1");
    expect(p.get("state")).toBe("a.b c/d+e");
    expect(p.get("config_id")).toBe("999");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("override_default_response_type")).toBe("true");
    expect(p.has("scope")).toBe(false);
    expect(u).not.toContain("a.b c/d+e");
  });
});

describe("stripOAuthCodeSuffix", () => {
  it("tira #_", () => {
    expect(stripOAuthCodeSuffix("abc#_")).toBe("abc");
    expect(stripOAuthCodeSuffix("abc")).toBe("abc");
  });
});

describe("parsers", () => {
  it("parseMe usa user_id, nunca id", () => {
    expect(parseMe({ user_id: "17841", username: "loja", account_type: "Business" })).toEqual({
      igUserId: "17841",
      username: "loja",
      accountType: "Business",
    });
    expect(parseMe({ id: "999", username: "x" })).toBeNull();
    expect(parseMe(null)).toBeNull();
    expect(parseMe({ user_id: "17841" })).toEqual({ igUserId: "17841", username: null, accountType: null });
  });
  it("parseMe recusa user_id numerico inseguro e aceita string intacta", () => {
    expect(parseMe(JSON.parse('{"user_id":17841400000000001}'))).toBeNull();
    expect(parseMe({ user_id: 0 })).toBeNull();
    expect(parseMe({ user_id: -5 })).toBeNull();
    expect(parseMe({ user_id: 1.5 })).toBeNull();
    expect(parseMe({ user_id: 12345 })).toMatchObject({ igUserId: "12345" });
    expect(parseMe(JSON.parse('{"user_id":"17841400000000001"}'))).toMatchObject({ igUserId: "17841400000000001" });
  });
  it("parseLongLived exige expires_in inteiro positivo", () => {
    for (const bad of [0, -1, 1.5]) expect(parseLongLived({ access_token: TOKEN, expires_in: bad })).toBeNull();
  });
  it("parseCodeExchange aceita só objeto de topo", () => {
    expect(parseCodeExchange({ access_token: SHORT })).toEqual({ shortToken: SHORT });
    expect(parseCodeExchange({ data: [{ access_token: SHORT, user_id: 1 }] })).toBeNull();
    expect(parseCodeExchange({ data: [] })).toBeNull();
    expect(parseCodeExchange("x")).toBeNull();
  });
  it("parseLongLived", () => {
    expect(parseLongLived({ access_token: TOKEN, expires_in: 5184000 })).toEqual({ token: TOKEN, expiresInSec: 5184000 });
    expect(parseLongLived({ access_token: TOKEN })).toBeNull();
    expect(parseLongLived({ expires_in: 5 })).toBeNull();
  });
});

const page = (over: Record<string, unknown> = {}) => ({
  id: "111",
  name: "Moralles Films",
  tasks: ["MODERATE", "MESSAGING"],
  access_token: "PAGE-T",
  instagram_business_account: { id: "17841470263374765", username: "morallesfilmes" },
  ...over,
});
const cand = (username: string, tasks: string[]): PageCandidate => ({
  pageId: "1", pageName: null, pageToken: "t", tasks, igUserId: "9", igUsername: username,
});

describe("parsePages", () => {
  it("devolve o candidato com os valores", () => {
    expect(parsePages({ data: [page()] })).toEqual([
      {
        pageId: "111",
        pageName: "Moralles Films",
        pageToken: "PAGE-T",
        tasks: ["MODERATE", "MESSAGING"],
        igUserId: "17841470263374765",
        igUsername: "morallesfilmes",
      },
    ]);
  });
  it("id numérico inseguro descarta o item; inteiro seguro vira string", () => {
    const unsafe = JSON.parse('{"data":[{"id":"1","access_token":"T","instagram_business_account":{"id":17841470263374765}}]}');
    expect(parsePages(unsafe)).toEqual([]);
    const safe = parsePages({ data: [page({ id: 222, instagram_business_account: { id: 333 } })] });
    expect(safe?.[0]).toMatchObject({ pageId: "222", igUserId: "333", igUsername: null });
    expect(parsePages({ data: [page({ id: 0 })] })).toEqual([]);
  });
  it("sem access_token ou sem instagram_business_account sai", () => {
    expect(parsePages({ data: [page({ access_token: undefined }), page({ instagram_business_account: undefined })] })).toEqual([]);
  });
  it("data ausente ou não array dá null", () => {
    expect(parsePages({})).toBeNull();
    expect(parsePages({ data: "x" })).toBeNull();
    expect(parsePages(null)).toBeNull();
  });
});

describe("choosePage", () => {
  it("vazio dá no_instagram", () => {
    expect(choosePage([])).toEqual({ kind: "none", reason: "no_instagram" });
  });
  it("sem tarefa suficiente dá insufficient_task", () => {
    expect(choosePage([cand("a", ["ADVERTISE"])])).toEqual({ kind: "none", reason: "insufficient_task" });
  });
  it("dois válidos dão many; um válido dá one", () => {
    expect(choosePage([cand("a", ["MANAGE"]), cand("b", ["MODERATE"])])).toEqual({ kind: "many", usernames: ["a", "b"] });
    const ok = cand("a", ["MANAGE"]);
    expect(choosePage([ok, cand("b", ["ADVERTISE"])])).toEqual({ kind: "one", page: ok });
  });
});

describe("parseUserLongLived", () => {
  it("aceita access_token mesmo sem expires_in", () => {
    expect(parseUserLongLived({ access_token: "U-LONG", token_type: "bearer" })).toEqual({ token: "U-LONG" });
    expect(parseUserLongLived({ token_type: "bearer" })).toBeNull();
    expect(parseUserLongLived(null)).toBeNull();
  });
});

describe("parseDataAccessExpiry", () => {
  it("converte segundos positivos em ISO", () => {
    expect(parseDataAccessExpiry({ data: { data_access_expires_at: 1801579536 } })).toBe("2027-02-02T14:45:36.000Z");
  });
  it("valores inválidos dão null", () => {
    for (const v of [0, "1801579536", -5, 1.5]) {
      expect(parseDataAccessExpiry({ data: { data_access_expires_at: v } })).toBeNull();
    }
    expect(parseDataAccessExpiry({ data: {} })).toBeNull();
    expect(parseDataAccessExpiry({})).toBeNull();
    expect(parseDataAccessExpiry(null)).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("tira token de URL e de mensagem de TypeError", () => {
    const url = `https://graph.instagram.com/v26.0/me?access_token=${TOKEN}&fields=x`;
    expect(redactSecrets(url, [TOKEN])).not.toContain(TOKEN);
    const err = new TypeError(`fetch failed for ${url}`);
    expect(redactSecrets(err.message, [TOKEN])).not.toContain(TOKEN);
  });
  it("tira forma codificada e ignora segredos vazios", () => {
    const s = "a b/c";
    expect(redactSecrets(`x=${encodeURIComponent(s)} y=${s}`, [s, "", "  "])).not.toMatch(/a%20b|a b/);
  });
  it("redige o code= do OAuth", () => {
    const out = redactSecrets("code=abc123&grant_type=authorization_code&state=s", []);
    expect(out).not.toContain("abc123");
    expect(out).toContain("grant_type=authorization_code");
  });
  it("redige access_token= e client_secret= mesmo desconhecidos", () => {
    const out = redactSecrets("?access_token=zzz123&client_secret=qqq456&x=1", []);
    expect(out).not.toContain("zzz123");
    expect(out).not.toContain("qqq456");
    expect(out).toContain("x=1");
  });
});

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("adapter createInstagramGraph", () => {
  it("erro 500 cujo corpo ecoa o token não deixa o token em nenhum campo", async () => {
    const { f } = fakeFetch(() => json({ error: { message: `bad token ${TOKEN} secret ${SECRET}`, code: 1 } }, 500));
    const g = createInstagramGraph(f);
    const r = await g.sendText({ igUserId: "1", token: TOKEN, igsid: "2", text: "oi" });
    expect(r).toEqual({ ok: false, errorClass: "transient", httpStatus: 500, code: 1 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const r2 = await g.toLongLived({ appSecret: SECRET, shortToken: SHORT });
    expect(JSON.stringify(r2)).not.toContain(SECRET);
    expect(JSON.stringify(r2)).not.toContain(SHORT);
  });

  it("erro de rede com URL contendo access_token= é redigido", async () => {
    const { f } = fakeFetch((url) => {
      throw new TypeError(`fetch failed: ${url}`);
    });
    const g = createInstagramGraph(f);
    const r = await g.refresh({ token: TOKEN });
    expect(r).toEqual({ ok: false, errorClass: "transient", httpStatus: null, code: null });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("classifica pelo código do corpo", async () => {
    const { f } = fakeFetch(() => json({ error: { code: 190, message: "x" } }, 400));
    const r = await createInstagramGraph(f).me({ token: TOKEN });
    expect(r).toEqual({ ok: false, errorClass: "reauth_required", httpStatus: 400, code: 190 });
    const { f: f2 } = fakeFetch(() => json({ error: { code: 100, error_subcode: 2534022 } }, 400));
    const r2 = await createInstagramGraph(f2).sendText({ igUserId: "1", token: TOKEN, igsid: "2", text: "a" });
    expect(r2).toMatchObject({ ok: false, errorClass: "window_closed", code: 100 });
    const { f: f3 } = fakeFetch(() => json({ error_type: "OAuthException", code: 400, error_message: "x" }, 400));
    const r3 = await createInstagramGraph(f3).exchangeCode({
      appId: "1",
      appSecret: SECRET,
      redirectUri: "https://x/cb",
      code: "c",
    });
    expect(r3).toMatchObject({ ok: false, errorClass: "invalid_request", code: 400 });
  });

  it("corpo não-JSON ou 200 sem forma esperada falha sem vazar", async () => {
    const { f } = fakeFetch(() => new Response(`<html>${TOKEN}</html>`, { status: 502 }));
    const r = await createInstagramGraph(f).me({ token: TOKEN });
    expect(r).toEqual({ ok: false, errorClass: "transient", httpStatus: 502, code: null });
    const { f: f2 } = fakeFetch(() => json({ nada: 1 }));
    const r2 = await createInstagramGraph(f2).me({ token: TOKEN });
    expect(r2).toMatchObject({ ok: false, errorClass: "invalid_request", httpStatus: 200 });
  });

  it("timeout aborta e vira transient", async () => {
    const { f } = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const g = createInstagramGraph(f, { timeoutMs: 20 });
    const r = await g.me({ token: TOKEN });
    expect(r).toEqual({ ok: false, errorClass: "transient", httpStatus: null, code: null });
  });

  it("exchangeCode: POST form, code sem #_, sem token na query", async () => {
    const { f, calls } = fakeFetch(() => json({ access_token: SHORT }));
    const r = await createInstagramGraph(f).exchangeCode({
      appId: "42",
      appSecret: SECRET,
      redirectUri: "https://x/cb",
      code: "abc#_",
    });
    expect(r).toEqual({ ok: true, value: { shortToken: SHORT } });
    expect(calls[0].url).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[0].init?.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("code")).toBe("abc");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("42");
    expect(body.get("client_secret")).toBe(SECRET);
    expect(body.get("redirect_uri")).toBe("https://x/cb");
  });

  it("toLongLived e refresh: GET com credenciais na query (R2-e)", async () => {
    const { f, calls } = fakeFetch(() => json({ access_token: TOKEN, expires_in: 5184000 }));
    const g = createInstagramGraph(f);
    expect(await g.toLongLived({ appSecret: SECRET, shortToken: SHORT })).toEqual({
      ok: true,
      value: { token: TOKEN, expiresInSec: 5184000 },
    });
    const u1 = new URL(calls[0].url);
    expect(u1.origin + u1.pathname).toBe("https://graph.instagram.com/access_token");
    expect(u1.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(u1.searchParams.get("client_secret")).toBe(SECRET);
    expect(u1.searchParams.get("access_token")).toBe(SHORT);
    await g.refresh({ token: TOKEN });
    const u2 = new URL(calls[1].url);
    expect(u2.origin + u2.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(u2.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(u2.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("me, subscribe, sendText, profile: Bearer, token nunca na query", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.includes("/me?")) return json({ user_id: "17841", username: "loja", account_type: "Business" });
      if (url.includes("/messages")) return json({ recipient_id: "2", message_id: "mid.1" });
      if (url.includes("subscribed_apps")) return json({ success: true });
      return json({ name: "Ana", username: "ana" });
    });
    const g = createInstagramGraph(f);
    expect(await g.me({ token: TOKEN })).toEqual({
      ok: true,
      value: { igUserId: "17841", username: "loja", accountType: "Business" },
    });
    expect(await g.subscribe({ igUserId: "17841", token: TOKEN })).toEqual({ ok: true, value: { success: true } });
    expect(await g.sendText({ igUserId: "17841", token: TOKEN, igsid: "2", text: "oi" })).toEqual({
      ok: true,
      value: { messageId: "mid.1" },
    });
    expect(await g.profile({ igsid: "2", token: TOKEN })).toEqual({
      ok: true,
      value: { name: "Ana", username: "ana" },
    });
    expect(calls[0].url).toBe("https://graph.instagram.com/v26.0/me?fields=user_id,username,account_type");
    expect(calls[1].url).toBe("https://graph.instagram.com/v26.0/17841/subscribed_apps?subscribed_fields=messages");
    expect(calls[1].init?.method).toBe("POST");
    expect(calls[2].url).toBe("https://graph.instagram.com/v26.0/17841/messages");
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ recipient: { id: "2" }, message: { text: "oi" } });
    expect(calls[3].url).toBe("https://graph.instagram.com/v26.0/2?fields=name,username");
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(new Headers(c.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("profile rejeita corpo array", async () => {
    const { f } = fakeFetch(() => json([{ name: "Ana" }]));
    const r = await createInstagramGraph(f).profile({ igsid: "2", token: TOKEN });
    expect(r).toMatchObject({ ok: false, errorClass: "invalid_request", httpStatus: 200 });
  });

  it("sem retry: uma única chamada em falha", async () => {
    const { f, calls } = fakeFetch(() => json({ error: { code: 1 } }, 500));
    await createInstagramGraph(f).sendText({ igUserId: "1", token: TOKEN, igsid: "2", text: "a" });
    expect(calls.length).toBe(1);
  });
});

describe("isGraphOutcomeUnknown", () => {
  const f = (httpStatus: number | null, errorClass: "transient" | "invalid_request" | "reauth_required") =>
    ({ ok: false as const, errorClass, httpStatus, code: null });
  it("tabela de desfechos", () => {
    expect(isGraphOutcomeUnknown(f(200, "invalid_request"), "POST")).toBe(true);
    expect(isGraphOutcomeUnknown(f(200, "invalid_request"), "GET")).toBe(true);
    expect(isGraphOutcomeUnknown(f(null, "transient"), "GET")).toBe(true);
    expect(isGraphOutcomeUnknown(f(503, "transient"), "POST")).toBe(true);
    expect(isGraphOutcomeUnknown(f(503, "transient"), "GET")).toBe(false);
    expect(isGraphOutcomeUnknown(f(400, "invalid_request"), "POST")).toBe(false);
    expect(isGraphOutcomeUnknown({ ok: true, value: 1 }, "POST")).toBe(false);
  });
});

describe("parseLongLived teto", () => {
  it("rejeita expires_in acima de 90 dias", () => {
    expect(parseLongLived({ access_token: TOKEN, expires_in: 90 * 86_400 })).not.toBeNull();
    expect(parseLongLived({ access_token: TOKEN, expires_in: 90 * 86_400 + 1 })).toBeNull();
  });
});

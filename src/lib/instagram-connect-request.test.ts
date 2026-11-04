// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";
import {
  INSTAGRAM_STATE_TTL_MS,
  signInstagramState,
  verifyInstagramState,
} from "../../supabase/functions/_shared/instagram-oauth-state.ts";

/**
 * Request do `instagram-connect` (Task 2.4, C1/C2/C6) no harness.
 *
 * Usuário = o Bearer (sintético) conferido pelo cliente anon (`getUser`).
 * O banco falso emula as RPCs do Bloco 1 com a MESMA autorização do SQL
 * (papel + grant em `store_…`; papel na unidade DA CONTA em `disconnect_…`),
 * para que um furo na EF apareça como gravação indevida e não só como status.
 * O Graph é o `transport` do harness; nenhuma chamada sai para a Meta.
 */

const env = {
  SUPABASE_URL: "https://synthetic-project.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  SUPABASE_ANON_KEY: "synthetic-anon-key",
  APP_BASE_URL: "https://app.synthetic.invalid",
  INSTAGRAM_APP_ID: "999000111",
  INSTAGRAM_OAUTH_STATE_SECRET: "synthetic-state-secret-0123456789-abcdef",
  INSTAGRAM_LOGIN_CONFIG_ID: "555000222",
};
const APP_SECRET = "synthetic-ig-app-secret-XYZ";
const CODE = "AQ-synthetic-code-123";
const SHORT = "EAA-test-user-short-XYZ";
const USER_LONG = "EAA-test-user-long-XYZ";
const PAGE_TOKEN = "EAA-test-page-token-XYZ";
const PAGE_TOKEN_2 = "EAA-test-page-token-two-XYZ";
const IG = "17841400000000001";
const PAGE = "104000000000077";
const PAGE_2 = "104000000000088";
const IG_2 = "17841400000000002";
const MANY_PAGES_MSG = "Selecione só a Página desta loja ao conectar. No diálogo do Facebook, use \"Editar acesso\" e deixe marcada só a Página desta loja.";
const FB = "https://graph.facebook.com/v26.0";
const URL_FN = `${env.SUPABASE_URL}/functions/v1/instagram-connect`;
const REDIRECT = `${env.APP_BASE_URL}/instagram/callback`;
const LEAK = "pg-message-with-SECRET-detail";

const id = (n: number) => `14000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UNIT_A = id(101), UNIT_B = id(102);
const ORG = id(201);
const OWNER_A = id(1), GERENTE_A = id(2), OPERADOR_A = id(3), OWNER_B = id(4), ADMIN = id(5), STRANGER = id(6);
const ACC_A = id(301);
const ACTIONS = ["start", "callback", "status", "disconnect", "resubscribe"] as const;

type Row = Record<string, unknown>;
type ErrorFlag = "members" | "admins" | "grants" | "units" | "secrets" | "accounts"
  | "store_mismatch" | "store_in_use" | "store_forbidden" | "store_invalid" | "store_other"
  | "status_forbidden" | "disconnect_forbidden" | "token" | "record";

const harnesses: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => harnesses.splice(0).forEach((h) => h.dispose()));

type Page = { id: unknown; name?: string; tasks?: string[]; access_token?: string; instagram_business_account?: Row };
const pageRow = (over: Partial<Page> = {}): Page => ({
  id: PAGE, name: "Restaurante A", tasks: ["ANALYZE", "MODERATE", "MESSAGING"], access_token: PAGE_TOKEN,
  instagram_business_account: { id: IG, username: "restaurante_a" }, ...over,
});

function fixture(opts: {
  env?: Record<string, string | undefined>;
  pages?: unknown;
  debug?: { status: number; body: unknown } | "network";
  subscribeOk?: boolean;
  exchangeOk?: boolean;
  longOk?: boolean;
} = {}) {
  const state = {
    members: [
      { user_id: OWNER_A, unit_id: UNIT_A, role: "owner" },
      { user_id: GERENTE_A, unit_id: UNIT_A, role: "gerente" },
      { user_id: OPERADOR_A, unit_id: UNIT_A, role: "operador" },
      { user_id: OWNER_B, unit_id: UNIT_B, role: "owner" },
    ] as Row[],
    admins: [ADMIN],
    grants: [
      { id: id(401), unit_id: UNIT_A, module: "instagram", revoked_at: null },
      { id: id(402), unit_id: UNIT_B, module: "instagram", revoked_at: null },
    ] as Row[],
    units: [{ id: UNIT_A, slug: "unidade-a", organization_id: ORG }, { id: UNIT_B, slug: "unidade-b", organization_id: ORG }] as Row[],
    accounts: [] as Row[],
    tokens: new Map<string, string>(),
    errors: new Set<ErrorFlag>(),
    rpcs: [] as { name: string; args: Row; key: string; auth: string | null }[],
    graph: [] as { method: string; url: string; body: string; auth: string | null }[],
    clients: [] as { key: string; auth: string | null }[],
  };
  let seq = 0;
  const users = new Set([OWNER_A, GERENTE_A, OPERADOR_A, OWNER_B, ADMIN, STRANGER]);
  const err = (code: string) => ({ data: null, error: { code, message: LEAK } });
  const roleOk = (actor: unknown, unitId: unknown) =>
    state.admins.includes(actor as string)
    || state.members.some((m) => m.user_id === actor && m.unit_id === unitId && (m.role === "owner" || m.role === "gerente"));
  const grantOk = (unitId: unknown) => state.grants.some((g) => g.unit_id === unitId && g.revoked_at === null);

  const createClient = (_url: string, key: string, options?: { global?: { headers?: Record<string, string> } }) => {
    const auth = options?.global?.headers?.Authorization ?? null;
    state.clients.push({ key, auth });
    const from = (table: string) => {
      let columns = "";
      const f: Row = {};
      const result = async (): Promise<{ data: unknown; error: unknown }> => {
        if (key !== env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(`table ${table} read without service role`);
        const pick = (rows: Row[]) => rows.length > 1 ? err("PGRST116") : { data: rows[0] ?? null, error: null };
        if (table === "unit_members") {
          if (state.errors.has("members")) return err("08006");
          expect(columns).toBe("role");
          return pick(state.members.filter((m) => m.user_id === f.user_id && m.unit_id === f.unit_id).map((m) => ({ role: m.role })));
        }
        if (table === "platform_admins") {
          if (state.errors.has("admins")) return err("08006");
          return pick(state.admins.filter((a) => a === f.user_id).map((a) => ({ user_id: a })));
        }
        if (table === "unit_module_grants") {
          if (state.errors.has("grants")) return err("08006");
          expect(f.module).toBe("instagram");
          expect(f["is:revoked_at"]).toBe(null);
          return pick(state.grants.filter((g) => g.unit_id === f.unit_id && g.module === "instagram" && g.revoked_at === null)
            .map((g) => ({ id: g.id })));
        }
        if (table === "units") {
          if (state.errors.has("units")) return err("08006");
          return pick(state.units.filter((u) => u.id === f.id).map((u) => ({ slug: u.slug })));
        }
        if (table === "platform_secrets") {
          if (state.errors.has("secrets")) return err("08006");
          expect(f.key).toBe("instagram_app_secret");
          return { data: { value: APP_SECRET }, error: null };
        }
        if (table === "instagram_accounts") {
          if (state.errors.has("accounts")) return err("08006");
          expect(f.unit_id).toBeTypeOf("string");
          expect(f["neq:status"]).toBe("disconnected");
          return pick(state.accounts.filter((a) => a.unit_id === f.unit_id && a.status !== "disconnected")
            .map((a) => ({ id: a.id, ig_user_id: a.ig_user_id, status: a.status, page_id: a.page_id ?? null })));
        }
        throw new Error(`unexpected read ${table}`);
      };
      const q = {
        select(v: string) { columns = v; return q; },
        eq(k: string, v: unknown) { f[k] = v; return q; },
        neq(k: string, v: unknown) { f[`neq:${k}`] = v; return q; },
        is(k: string, v: unknown) { f[`is:${k}`] = v; return q; },
        maybeSingle: () => result(),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return result().then(resolve, reject); },
      };
      return q;
    };
    const rpc = async (name: string, args: Row) => {
      state.rpcs.push({ name, args: { ...args }, key, auth });
      if (name === "get_instagram_account_status") {
        // Com service role, auth.uid() é nulo e a RPC recusa (C6).
        const uid = key === env.SUPABASE_ANON_KEY && auth?.startsWith("Bearer ") ? auth.slice(7) : null;
        if (state.errors.has("status_forbidden") || !uid) return err("42501");
        if (!(state.admins.includes(uid) || state.members.some((m) => m.user_id === uid && m.unit_id === args.p_unit_id))) return err("42501");
        return {
          data: state.accounts.filter((a) => a.unit_id === args.p_unit_id && a.status !== "disconnected").map((a) => ({
            username: a.username, status: a.status, token_expires_at: a.token_expires_at,
            connected_at: a.connected_at, subscribed: (a.subscribed_fields as string[]).includes("messages"), last_error_code: null,
          })),
          error: null,
        };
      }
      if (key !== env.SUPABASE_SERVICE_ROLE_KEY) return err("42501");
      if (name === "store_instagram_account_connection") {
        if (state.errors.has("store_other")) return err("XX000");
        if (state.errors.has("store_mismatch")) return { data: null, error: { code: "42501", message: "instagram_account_secret_mismatch" } };
        if (state.errors.has("store_invalid")) return err("22023");
        // Mesmo contrato da 20261104130000: 8 argumentos, page_id só dígitos.
        expect(Object.keys(args).sort()).toEqual(["p_account_type", "p_actor", "p_expires_at", "p_ig_user_id",
          "p_page_id", "p_token", "p_unit_id", "p_username"]);
        if (typeof args.p_page_id !== "string" || !/^[0-9]{1,64}$/.test(args.p_page_id)) return err("22023");
        if (state.errors.has("store_forbidden") || !roleOk(args.p_actor, args.p_unit_id) || !grantOk(args.p_unit_id)) return err("42501");
        if (state.errors.has("store_in_use") || state.accounts.some((a) => a.ig_user_id === args.p_ig_user_id
          && a.status !== "disconnected" && a.unit_id !== args.p_unit_id)) return err("P0001");
        const accId = `acc-${++seq}`;
        state.accounts.push({
          id: accId, unit_id: args.p_unit_id, ig_user_id: args.p_ig_user_id, page_id: args.p_page_id, username: args.p_username,
          account_type: args.p_account_type, status: "connected", token_expires_at: args.p_expires_at,
          connected_at: new Date().toISOString(), subscribed_fields: [], connected_by: args.p_actor,
        });
        state.tokens.set(accId, args.p_token as string);
        return { data: accId, error: null };
      }
      if (name === "record_instagram_account_subscription") {
        if (state.errors.has("record")) return err("55000");
        const acc = state.accounts.find((a) => a.id === args.p_account_id);
        if (!acc) return err("P0002");
        acc.subscribed_fields = args.p_fields;
        return { data: null, error: null };
      }
      if (name === "disconnect_instagram_account") {
        const acc = state.accounts.find((a) => a.id === args.p_account_id);
        if (state.errors.has("disconnect_forbidden") || !acc || !roleOk(args.p_actor, acc.unit_id)) return err("42501");
        acc.status = "disconnected";
        return { data: null, error: null };
      }
      if (name === "get_instagram_account_token") {
        if (state.errors.has("token")) return err("P0002");
        const t = state.tokens.get(args.p_account_id as string);
        return t ? { data: t, error: null } : err("P0002");
      }
      throw new Error(`unexpected rpc ${name}`);
    };
    return {
      auth: {
        getUser: async () => {
          const u = key === env.SUPABASE_ANON_KEY && auth?.startsWith("Bearer ") ? auth.slice(7) : null;
          return u && users.has(u) ? { data: { user: { id: u } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
        },
      },
      from,
      rpc,
    };
  };

  const record = async (r: Request) => {
    state.graph.push({ method: r.method, url: r.url, body: r.method === "POST" ? await r.clone().text() : "", auth: r.headers.get("authorization") });
  };
  const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  // A URL de cada rota é exata (o harness casa método + URL): ordem e valores da query são parte do contrato.
  const exchangeQ = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT, code: CODE,
  });
  const longQ = new URLSearchParams({
    grant_type: "fb_exchange_token", client_id: env.INSTAGRAM_APP_ID, client_secret: APP_SECRET, fb_exchange_token: SHORT,
  });
  const subscribeRoute = (pageId: string) => ({
    method: "POST", url: `${FB}/${pageId}/subscribed_apps?subscribed_fields=messages`, respond: async (r: Request) => {
      await record(r);
      return opts.subscribeOk === false
        ? jsonRes(400, { error: { code: 100, message: `invalid token ${PAGE_TOKEN}` } })
        : jsonRes(200, { success: true });
    },
  });
  const transport = [
    { method: "GET", url: `${FB}/oauth/access_token?${exchangeQ}`, respond: async (r: Request) => {
      await record(r);
      return opts.exchangeOk === false
        ? jsonRes(400, { error: { type: "OAuthException", code: 100, message: `bad code ${CODE} ${APP_SECRET}` } })
        : jsonRes(200, { access_token: SHORT, token_type: "bearer", expires_in: 5_183_944 });
    } },
    { method: "GET", url: `${FB}/oauth/access_token?${longQ}`, respond: async (r: Request) => {
      await record(r);
      return opts.longOk === false
        ? jsonRes(400, { error: { code: 190, message: `expired ${SHORT} ${APP_SECRET}` } })
        : jsonRes(200, { access_token: USER_LONG, token_type: "bearer", expires_in: 5_183_944 });
    } },
    {
      method: "GET",
      url: new URL(`${FB}/me/accounts?fields=id,name,tasks,access_token,instagram_business_account{id,username}&limit=100`).href,
      respond: async (r: Request) => {
        await record(r);
        return jsonRes(200, opts.pages ?? { data: [pageRow()], paging: { cursors: { before: "a", after: "b" } } });
      },
    },
    ...[PAGE_TOKEN, PAGE_TOKEN_2].map((t) => ({
      method: "GET", url: `${FB}/debug_token?${new URLSearchParams({ input_token: t })}`, respond: async (r: Request) => {
        await record(r);
        if (opts.debug === "network") throw new TypeError(`fetch failed ${r.url}`);
        if (opts.debug) return jsonRes(opts.debug.status, opts.debug.body);
        return jsonRes(200, { data: {
          app_id: env.INSTAGRAM_APP_ID, type: "PAGE", is_valid: true, expires_at: 0,
          data_access_expires_at: 1801579536, scopes: ["instagram_basic", "instagram_manage_messages"],
        } });
      },
    })),
    subscribeRoute(PAGE),
    subscribeRoute(PAGE_2),
  ];

  const harnessEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...env, ...(opts.env ?? {}) })) if (typeof v === "string") harnessEnv[k] = v;
  const harness = createEdgeRequestHarness({ env: harnessEnv, createClient, transport });
  harnesses.push(harness);

  const call = async (user: string | null, body: unknown, method = "POST") => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: "http://localhost:8080" };
    if (user) headers.Authorization = `Bearer ${user}`;
    const res = await harness.request("instagram-connect", new Request(URL_FN, {
      method, headers, body: method === "POST" ? JSON.stringify(body) : undefined,
    }));
    const text = await res.text();
    let json: Row = {};
    try { json = JSON.parse(text); } catch { /* corpo vazio */ }
    return { status: res.status, text, json, headers: res.headers };
  };
  const start = async (user: string, unitId: string) => {
    const r = await call(user, { action: "start", unit_id: unitId });
    expect(r.status).toBe(200);
    return new URL(r.json.authorize_url as string).searchParams.get("state") as string;
  };
  const signFor = (userId: string, unitId: string, exp = harness.now + INSTAGRAM_STATE_TTL_MS) =>
    signInstagramState({ unitId, userId, exp, nonce: crypto.randomUUID() }, env.INSTAGRAM_OAUTH_STATE_SECRET, harness.now);
  const writes = () => state.rpcs.filter((r) => r.name !== "get_instagram_account_status");
  const seedAccount = (unitId = UNIT_A, status = "connected", pageId: string | null = PAGE) => {
    state.accounts.push({
      id: ACC_A, unit_id: unitId, ig_user_id: IG, page_id: pageId, username: "restaurante_a", account_type: null, status,
      token_expires_at: "2026-12-01T12:00:00.000Z", connected_at: "2026-10-01T12:00:00.000Z", subscribed_fields: ["messages"],
    });
    state.tokens.set(ACC_A, PAGE_TOKEN);
  };
  /** Credenciais que nunca saem: token do usuário (curto e longo), segredo do app, code e o token do app. */
  const NEVER = [SHORT, USER_LONG, APP_SECRET, CODE, `${env.INSTAGRAM_APP_ID}|${APP_SECRET}`];
  const leakFree = (text: string) => {
    for (const s of [...NEVER, PAGE_TOKEN, PAGE_TOKEN_2, LEAK]) expect(text).not.toContain(s);
  };
  return { state, harness, call, start, signFor, writes, seedAccount, leakFree, NEVER };
}

describe("instagram-connect — transporte e autenticação", () => {
  it("OPTIONS responde o preflight com CORS da origem permitida", async () => {
    const f = fixture();
    const r = await f.call(null, null, "OPTIONS");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:8080");
  });

  it("sem Authorization ou com sessão inválida → 401, sem leitura", async () => {
    const f = fixture();
    expect((await f.call(null, { action: "start", unit_id: UNIT_A })).status).toBe(401);
    expect((await f.call("nao-e-usuario", { action: "start", unit_id: UNIT_A })).status).toBe(401);
    expect(f.state.rpcs).toEqual([]);
  });

  it("método diferente de POST → 405; ação desconhecida → 400; unit_id inválido → 400", async () => {
    const f = fixture();
    expect((await f.call(OWNER_A, null, "GET")).status).toBe(405);
    expect((await f.call(OWNER_A, { action: "apagar", unit_id: UNIT_A })).status).toBe(400);
    expect((await f.call(OWNER_A, { action: "start", unit_id: "x' or 1=1" })).status).toBe(400);
    expect((await f.call(OWNER_A, { action: "start" })).status).toBe(400);
  });
});

describe("instagram-connect — papel", () => {
  it("operador recebe 403 em todas as ações, com o mesmo corpo do não membro, sem Graph nem RPC", async () => {
    const f = fixture();
    f.seedAccount();
    const bodies = new Set<string>();
    for (const user of [OPERADOR_A, STRANGER]) {
      for (const action of ACTIONS) {
        const body = action === "callback"
          ? { action, code: CODE, state: await f.signFor(user, UNIT_A) }
          : { action, unit_id: UNIT_A };
        const r = await f.call(user, body);
        expect(r.status, `${user} ${action}`).toBe(403);
        bodies.add(r.text);
      }
    }
    expect(bodies.size).toBe(1);
    expect(f.state.graph).toEqual([]);
    expect(f.state.rpcs).toEqual([]);
    expect(f.state.accounts[0].status).toBe("connected");
  });

  it("leitura de papel com erro falha fechado (503), nunca libera", async () => {
    for (const flag of ["members", "admins"] as const) {
      const f = fixture();
      f.state.errors.add(flag);
      const r = await f.call(OWNER_A, { action: "start", unit_id: UNIT_A });
      expect(r.status).toBe(503);
      f.leakFree(r.text);
      expect(f.harness.logs.join("\n")).not.toContain(LEAK);
    }
  });
});

describe("instagram-connect — start", () => {
  it("owner recebe authorize_url com state assinado de 10 min preso a usuário e unidade", async () => {
    const f = fixture();
    const r = await f.call(OWNER_A, { action: "start", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["authorize_url", "state"]);
    expect(r.json.state).toBe(new URL(r.json.authorize_url as string).searchParams.get("state"));
    const url = new URL(r.json.authorize_url as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe(env.INSTAGRAM_APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("config_id")).toBe(env.INSTAGRAM_LOGIN_CONFIG_ID);
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.has("scope")).toBe(false);
    const v = await verifyInstagramState(url.searchParams.get("state") as string, env.INSTAGRAM_OAUTH_STATE_SECRET, f.harness.now);
    expect(v.ok).toBe(true);
    if (v.ok === true) {
      expect(v.payload.unitId).toBe(UNIT_A);
      expect(v.payload.userId).toBe(OWNER_A);
      expect(v.payload.exp).toBe(f.harness.now + INSTAGRAM_STATE_TTL_MS);
      expect(v.payload.nonce).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(f.state.graph).toEqual([]);
  });

  it("gerente e platform_admin (sem membership) também iniciam", async () => {
    const f = fixture();
    expect((await f.call(GERENTE_A, { action: "start", unit_id: UNIT_A })).status).toBe(200);
    expect((await f.call(ADMIN, { action: "start", unit_id: UNIT_A })).status).toBe(200);
  });

  it("grant inativo → 403, inclusive para platform_admin; erro de leitura do grant → 503", async () => {
    const f = fixture();
    f.state.grants[0].revoked_at = "2026-10-01T00:00:00Z";
    expect((await f.call(OWNER_A, { action: "start", unit_id: UNIT_A })).status).toBe(403);
    expect((await f.call(ADMIN, { action: "start", unit_id: UNIT_A })).status).toBe(403);
    const g = fixture();
    g.state.errors.add("grants");
    expect((await g.call(OWNER_A, { action: "start", unit_id: UNIT_A })).status).toBe(503);
  });

  it("owner de outra unidade → 403", async () => {
    const f = fixture();
    expect((await f.call(OWNER_B, { action: "start", unit_id: UNIT_A })).status).toBe(403);
  });

  it.each([
    ["sem INSTAGRAM_APP_ID", { INSTAGRAM_APP_ID: undefined }],
    ["sem segredo do state", { INSTAGRAM_OAUTH_STATE_SECRET: undefined }],
    ["segredo do state fraco", { INSTAGRAM_OAUTH_STATE_SECRET: "curto" }],
    ["sem INSTAGRAM_LOGIN_CONFIG_ID", { INSTAGRAM_LOGIN_CONFIG_ID: undefined }],
    ["INSTAGRAM_LOGIN_CONFIG_ID fora do formato", { INSTAGRAM_LOGIN_CONFIG_ID: "abc" }],
  ])("%s → 503", async (_n, override) => {
    const f = fixture({ env: override });
    const r = await f.call(OWNER_A, { action: "start", unit_id: UNIT_A });
    expect(r.status).toBe(503);
    expect(r.json.authorize_url).toBeUndefined();
    expect(r.json.state).toBeUndefined();
  });

  it("INSTAGRAM_APP_ID fora do formato (\"abc\") → 503 e loga app_id_missing", async () => {
    const f = fixture({ env: { INSTAGRAM_APP_ID: "abc" } });
    const r = await f.call(OWNER_A, { action: "start", unit_id: UNIT_A });
    expect(r.status).toBe(503);
    expect(r.json.authorize_url).toBeUndefined();
    expect(f.harness.logs.join("\n")).toMatch(/instagram_connect_misconfigured[^\n]*app_id_missing/);
  });

  it.each([undefined, "abc", "12 34"])("config_id %s → loga config_id_missing", async (value) => {
    const f = fixture({ env: { INSTAGRAM_LOGIN_CONFIG_ID: value } });
    expect((await f.call(OWNER_A, { action: "start", unit_id: UNIT_A })).status).toBe(503);
    expect(f.harness.logs.join("\n")).toMatch(/instagram_connect_misconfigured[^\n]*config_id_missing/);
  });
});

describe("instagram-connect — callback", () => {
  it("caminho feliz: troca → token longo → Páginas → debug_token → grava a Página → assina, sem devolver token", async () => {
    const f = fixture();
    const state = await f.start(OWNER_A, UNIT_A);
    const r = await f.call(OWNER_A, { action: "callback", code: `${CODE}#_`, state });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ unit_slug: "unidade-a", username: "restaurante_a", subscribed: true });
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));

    // Sequência do Graph, toda no graph.facebook.com.
    expect(f.state.graph.map((g) => `${g.method} ${new URL(g.url).host}${new URL(g.url).pathname}`)).toEqual([
      "GET graph.facebook.com/v26.0/oauth/access_token",
      "GET graph.facebook.com/v26.0/oauth/access_token",
      "GET graph.facebook.com/v26.0/me/accounts",
      "GET graph.facebook.com/v26.0/debug_token",
      `POST graph.facebook.com/v26.0/${PAGE}/subscribed_apps`,
    ]);
    const exchange = new URL(f.state.graph[0].url).searchParams;
    expect(exchange.get("code")).toBe(CODE); // sem o sufixo #_
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange.get("client_id")).toBe(env.INSTAGRAM_APP_ID);
    expect(exchange.get("client_secret")).toBe(APP_SECRET);
    expect(f.state.graph[0].auth).toBeNull();
    const long = new URL(f.state.graph[1].url).searchParams;
    expect(long.get("grant_type")).toBe("fb_exchange_token");
    expect(long.get("fb_exchange_token")).toBe(SHORT);
    expect(f.state.graph[1].auth).toBeNull();
    // /me/accounts com o token LONGO do usuário, no header.
    expect(f.state.graph[2].auth).toBe(`Bearer ${USER_LONG}`);
    expect(f.state.graph[2].url).not.toContain(USER_LONG);
    // debug_token do token da Página; o token do app só no header, nunca na URL.
    expect(new URL(f.state.graph[3].url).searchParams.get("input_token")).toBe(PAGE_TOKEN);
    expect(f.state.graph[3].auth).toBe(`Bearer ${env.INSTAGRAM_APP_ID}|${APP_SECRET}`);
    expect(f.state.graph[3].url).not.toContain(APP_SECRET);
    // Inscrição da PÁGINA com o token da Página, nada na query além do campo.
    expect(f.state.graph[4].auth).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(f.state.graph[4].url).toBe(`${FB}/${PAGE}/subscribed_apps?subscribed_fields=messages`);

    // Gravação: conta pelo id do Instagram, Página à parte, token da Página e prazo do debug_token.
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
    expect(store.key).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(PAGE).not.toBe(IG);
    expect(store.args).toEqual({
      p_unit_id: UNIT_A, p_ig_user_id: IG, p_page_id: PAGE, p_username: "restaurante_a", p_account_type: null,
      p_token: PAGE_TOKEN, p_expires_at: "2027-02-02T14:45:36.000Z", p_actor: OWNER_A,
    });
    expect(f.state.rpcs.map((x) => x.name)).toEqual(["store_instagram_account_connection", "record_instagram_account_subscription"]);
    expect(f.state.rpcs[1].args).toEqual({ p_account_id: "acc-1", p_fields: ["messages"] });
    expect(f.state.accounts).toHaveLength(1);
    expect(f.state.accounts[0]).toMatchObject({ ig_user_id: IG, page_id: PAGE });
    expect(f.state.accounts[0].subscribed_fields).toEqual(["messages"]);
    f.harness.assertNoUnexpectedIo();
  });

  it("token do usuário, segredo e code nunca chegam a RPC, log ou resposta; o da Página só em p_token", async () => {
    const f = fixture();
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    const logs = f.harness.logs.join("\n");
    for (const s of f.NEVER) {
      expect(r.text).not.toContain(s);
      expect(logs).not.toContain(s);
      for (const rpc of f.state.rpcs) expect(JSON.stringify(rpc.args)).not.toContain(s);
    }
    expect(r.text).not.toContain(PAGE_TOKEN);
    expect(logs).not.toContain(PAGE_TOKEN);
    for (const rpc of f.state.rpcs) {
      const { p_token, ...rest } = rpc.args;
      expect(JSON.stringify(rest)).not.toContain(PAGE_TOKEN);
      if (rpc.name === "store_instagram_account_connection") expect(p_token).toBe(PAGE_TOKEN);
    }
    expect([...f.state.tokens.values()]).toEqual([PAGE_TOKEN]);
  });

  it("debug_token com data_access_expires_at 0 grava p_expires_at nulo", async () => {
    const f = fixture({ debug: { status: 200, body: { data: { type: "PAGE", is_valid: true, expires_at: 0, data_access_expires_at: 0 } } } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
    expect(store.args.p_expires_at).toBeNull();
    expect(f.harness.logs.join("\n")).not.toContain("instagram_debug_token_failed");
  });

  it.each([
    ["500 com o segredo ecoado", { status: 500, body: { error: { code: 1, message: `boom ${APP_SECRET} ${PAGE_TOKEN}` } } }],
    ["erro do Graph", { status: 400, body: { error: { code: 190, message: `invalid ${env.INSTAGRAM_APP_ID}|${APP_SECRET}` } } }],
    ["200 sem data", { status: 200, body: { nada: true } }],
    ["rede", "network"],
  ] as const)("debug_token com %s não bloqueia: grava p_expires_at nulo e loga só classe e status", async (_n, debug) => {
    const f = fixture({ debug: debug as { status: number; body: unknown } | "network" });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ unit_slug: "unidade-a", username: "restaurante_a", subscribed: true });
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
    expect(store.args.p_expires_at).toBeNull();
    expect(store.args.p_token).toBe(PAGE_TOKEN);
    const line = f.harness.logs.find((l) => l.includes("instagram_debug_token_failed"));
    expect(line).toBeDefined();
    const logged = JSON.parse(line as string) as Row;
    expect(Object.keys(logged).sort()).toEqual(["action", "errorClass", "evt", "httpStatus", "level", "ts"]);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it("o username gravado e devolvido é o @ do Instagram da Página escolhida", async () => {
    const f = fixture({ pages: { data: [pageRow({ name: "Nome da Página", instagram_business_account: { id: IG, username: "outro_arroba" } })] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    expect(r.json.username).toBe("outro_arroba");
    expect(f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!.args.p_username).toBe("outro_arroba");
  });

  it("platform_admin sem membership conecta com p_actor = ADMIN", async () => {
    const f = fixture();
    const state = await f.start(ADMIN, UNIT_A);
    const r = await f.call(ADMIN, { action: "callback", code: CODE, state });
    expect(r.status).toBe(200);
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection");
    expect(store?.args.p_actor).toBe(ADMIN);
  });

  it("42501 de secret_mismatch → 503 'concluir a conexão agora', nunca 403 nem a mensagem do SQL", async () => {
    const f = fixture();
    f.state.errors.add("store_mismatch");
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: "Não foi possível concluir a conexão agora." });
    expect(r.text).not.toContain("secret_mismatch");
    expect(f.harness.logs.join("\n")).not.toContain("secret_mismatch");
  });

  it("gerente também conecta", async () => {
    const f = fixture();
    const r = await f.call(GERENTE_A, { action: "callback", code: CODE, state: await f.start(GERENTE_A, UNIT_A) });
    expect(r.status).toBe(200);
    expect(f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")?.args.p_actor).toBe(GERENTE_A);
  });

  it("state de outro usuário → 403, sem troca do código e sem gravação", async () => {
    const f = fixture();
    const stateOfA = await f.start(OWNER_A, UNIT_A);
    // OWNER_B é owner da unidade B e tenta usar o state de A (com unit_id B no corpo).
    const r = await f.call(OWNER_B, { action: "callback", code: CODE, state: stateOfA, unit_id: UNIT_B });
    expect(r.status).toBe(403);
    // Colega COM papel na mesma unidade também não reaproveita o state do owner:
    // só o vínculo `state.userId === sessão` barra este caso (o papel passaria).
    const r2 = await f.call(GERENTE_A, { action: "callback", code: CODE, state: stateOfA });
    expect(r2.status).toBe(403);
    expect(r2.json.error).toBe(r.json.error);
    expect(f.state.graph).toEqual([]);
    expect(f.writes()).toEqual([]);
    expect(f.state.accounts).toEqual([]);
  });

  it("unit_id do corpo é ignorado: a unidade vem só do state", async () => {
    const f = fixture();
    // OWNER_A não tem papel na unidade B; o corpo aponta para lá.
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A), unit_id: UNIT_B });
    expect(r.status).toBe(200);
    expect(r.json.unit_slug).toBe("unidade-a");
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
    expect(store.args.p_unit_id).toBe(UNIT_A);
  });

  it("state vencido → 403, sem Graph", async () => {
    const f = fixture();
    const state = await f.start(OWNER_A, UNIT_A);
    await f.harness.advanceTime(INSTAGRAM_STATE_TTL_MS);
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state });
    expect(r.status).toBe(403);
    expect(f.state.graph).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it.each([
    ["adulterado", (s: string) => `${s.slice(0, 5)}${s[5] === "A" ? "B" : "A"}${s.slice(6)}`],
    ["malformado", () => "nao-e-state"],
    ["ausente", () => undefined],
  ])("state %s → 403, sem Graph", async (_n, mutate) => {
    const f = fixture();
    const state = mutate(await f.start(OWNER_A, UNIT_A));
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state });
    expect(r.status).toBe(403);
    expect(f.state.graph).toEqual([]);
  });

  it("state assinado com outro segredo → 403", async () => {
    const f = fixture();
    const forged = await signInstagramState(
      { unitId: UNIT_A, userId: OWNER_A, exp: f.harness.now + 60_000, nonce: crypto.randomUUID() },
      "another-synthetic-secret-0123456789-xyz", f.harness.now,
    );
    expect((await f.call(OWNER_A, { action: "callback", code: CODE, state: forged })).status).toBe(403);
    expect(f.state.graph).toEqual([]);
  });

  it("grant revogado entre o start e o callback → 403, sem troca do código", async () => {
    const f = fixture();
    const state = await f.start(OWNER_A, UNIT_A);
    f.state.grants[0].revoked_at = "2026-10-04T12:01:00Z";
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state });
    expect(r.status).toBe(403);
    expect(f.state.graph).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it("papel perdido entre o start e o callback → 403", async () => {
    const f = fixture();
    const state = await f.start(GERENTE_A, UNIT_A);
    f.state.members = f.state.members.filter((m) => m.user_id !== GERENTE_A);
    expect((await f.call(GERENTE_A, { action: "callback", code: CODE, state })).status).toBe(403);
    expect(f.state.graph).toEqual([]);
  });

  it("code ausente com state válido → 400, sem Graph", async () => {
    const f = fixture();
    const r = await f.call(OWNER_A, { action: "callback", state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(400);
    expect(f.state.graph).toEqual([]);
  });

  it("/me/accounts sem a forma esperada → 502, nada gravado", async () => {
    const f = fixture({ pages: { nada: [] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(502);
    expect(f.writes()).toEqual([]);
    expect(f.state.accounts).toEqual([]);
    expect(f.state.graph.some((g) => g.url.includes("debug_token") || g.url.includes("subscribed_apps"))).toBe(false);
    f.leakFree(r.text);
  });

  const noWrites = (f: ReturnType<typeof fixture>) => {
    expect(f.writes()).toEqual([]);
    expect(f.state.accounts).toEqual([]);
    expect(f.state.tokens.size).toBe(0);
    expect(f.state.graph.some((g) => g.url.includes("subscribed_apps"))).toBe(false);
    expect(f.state.graph.some((g) => g.url.includes("debug_token"))).toBe(false);
  };

  it.each([
    ["lista vazia", { data: [] }],
    ["Página sem Instagram ligado", { data: [pageRow({ instagram_business_account: undefined })] }],
    ["Página sem token", { data: [pageRow({ access_token: undefined })] }],
  ])("zero Páginas válidas (%s) → 422 noPage, nada gravado", async (_n, pages) => {
    const f = fixture({ pages });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: "Nenhuma Página do Facebook com Instagram profissional ligado foi autorizada." });
    noWrites(f);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it.each([
    ["só ANALYZE e MESSAGING", ["ANALYZE", "MESSAGING", "ADVERTISE"]],
    ["sem tasks", []],
  ])("Página com Instagram mas sem MODERATE/MANAGE (%s) → 422 taskInsufficient, nada gravado", async (_n, tasks) => {
    const f = fixture({ pages: { data: [pageRow({ tasks })] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: "Sua permissão nessa Página não basta para atender o Direct." });
    noWrites(f);
    f.leakFree(r.text);
  });

  it("MANAGE sozinha basta", async () => {
    const f = fixture({ pages: { data: [pageRow({ tasks: ["MANAGE"] })] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
  });

  it("duas Páginas aptas → 409 com os @ e sem token, nada gravado", async () => {
    const f = fixture({ pages: { data: [
      pageRow(),
      pageRow({ id: PAGE_2, name: "Restaurante B", access_token: PAGE_TOKEN_2, instagram_business_account: { id: IG_2, username: "restaurante_b" } }),
    ] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: MANY_PAGES_MSG, usernames: ["restaurante_a", "restaurante_b"] });
    noWrites(f);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  describe("várias Páginas aptas", () => {
    const two = () => ({ pages: { data: [
      pageRow(),
      pageRow({ id: PAGE_2, name: "Restaurante B", access_token: PAGE_TOKEN_2, instagram_business_account: { id: IG_2, username: "restaurante_b" } }),
    ] } });
    const cb = async (f: ReturnType<typeof fixture>) =>
      f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });

    it("(a) a unidade já tem conta igual a uma das Páginas → reconecta essa, sem 409", async () => {
      const f = fixture(two());
      f.seedAccount(UNIT_A, "connected", PAGE_2);
      f.state.accounts[0].ig_user_id = IG_2;
      const r = await cb(f);
      expect(r.status).toBe(200);
      expect(r.json.username).toBe("restaurante_b");
      const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
      expect(store.args).toMatchObject({ p_unit_id: UNIT_A, p_page_id: PAGE_2, p_ig_user_id: IG_2, p_token: PAGE_TOKEN_2 });
      expect(f.state.graph.some((g) => g.url.includes(`/${PAGE_2}/subscribed_apps`))).toBe(true);
      expect(f.state.graph.some((g) => g.url.includes(`/${PAGE}/subscribed_apps`))).toBe(false);
      f.leakFree(r.text);
      f.leakFree(f.harness.logs.join("\n"));
    });

    it("(b) unidade sem conta → 409 como antes, nada gravado", async () => {
      const f = fixture(two());
      const r = await cb(f);
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ error: MANY_PAGES_MSG, usernames: ["restaurante_a", "restaurante_b"] });
      noWrites(f);
    });

    it("(c) conta da unidade não bate com nenhuma Página → 409, nada novo gravado", async () => {
      const f = fixture(two());
      f.seedAccount(UNIT_A, "connected", "104000000000099");
      f.state.accounts[0].ig_user_id = "17841400000000099";
      const r = await cb(f);
      expect(r.status).toBe(409);
      expect(f.writes()).toEqual([]);
      expect(f.state.graph.some((g) => g.url.includes("subscribed_apps") || g.url.includes("debug_token"))).toBe(false);
      f.leakFree(r.text);
    });

    it("(d) falha ao ler a conta → 503, sem gravar nem assinar", async () => {
      const f = fixture(two());
      f.state.errors.add("accounts");
      const r = await cb(f);
      expect(r.status).toBe(503);
      expect(f.writes()).toEqual([]);
      expect(f.state.graph.some((g) => g.url.includes("subscribed_apps") || g.url.includes("debug_token"))).toBe(false);
      f.leakFree(r.text);
      f.leakFree(f.harness.logs.join("\n"));
    });
  });

  it("uma Página apta entre outras sem a tarefa conecta a apta", async () => {
    const f = fixture({ pages: { data: [
      pageRow({ id: PAGE_2, tasks: ["ANALYZE"], access_token: PAGE_TOKEN_2, instagram_business_account: { id: IG_2, username: "restaurante_b" } }),
      pageRow(),
    ] } });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    const store = f.state.rpcs.find((x) => x.name === "store_instagram_account_connection")!;
    expect(store.args).toMatchObject({ p_ig_user_id: IG, p_page_id: PAGE, p_token: PAGE_TOKEN });
  });

  it("token longo do usuário recusado → 502, nada gravado, sem /me/accounts", async () => {
    const f = fixture({ longOk: false });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "Não foi possível concluir a conexão com o Instagram. Tente de novo." });
    expect(f.state.graph).toHaveLength(2);
    noWrites(f);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
    expect(f.harness.logs.join("\n")).toMatch(/instagram_connect_graph_failed[^\n]*long_lived/);
  });

  it("troca do código recusada → 502 sem texto da Meta, nada gravado", async () => {
    const f = fixture({ exchangeOk: false });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(502);
    expect(f.writes()).toEqual([]);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it("conta já conectada a outra unidade → 409", async () => {
    const f = fixture();
    f.seedAccount(UNIT_B);
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Esta conta do Instagram já está conectada a outra unidade");
    expect(f.state.accounts).toHaveLength(1);
    expect(f.state.graph.some((g) => g.url.includes("subscribed_apps"))).toBe(false);
    f.leakFree(r.text);
  });

  it.each([
    ["store_forbidden", 403],
    ["store_invalid", 502],
    ["store_other", 503],
  ] as const)("erro %s do store → %i, sem texto do Postgres", async (flag, status) => {
    const f = fixture();
    f.state.errors.add(flag);
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(status);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
    expect(f.state.graph.some((g) => g.url.includes("subscribed_apps"))).toBe(false);
  });

  it("falha na assinatura → 200 com subscribed:false, conta gravada, sem registro de assinatura", async () => {
    const f = fixture({ subscribeOk: false });
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ unit_slug: "unidade-a", username: "restaurante_a", subscribed: false });
    expect(f.state.rpcs.map((x) => x.name)).toEqual(["store_instagram_account_connection"]);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it("falha ao registrar a assinatura → 200 com subscribed:false", async () => {
    const f = fixture();
    f.state.errors.add("record");
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state: await f.start(OWNER_A, UNIT_A) });
    expect(r.status).toBe(200);
    expect(r.json.subscribed).toBe(false);
  });

  it("segredo do app ilegível → 503 antes de qualquer Graph", async () => {
    const f = fixture();
    const state = await f.start(OWNER_A, UNIT_A);
    f.state.errors.add("secrets");
    const r = await f.call(OWNER_A, { action: "callback", code: CODE, state });
    expect(r.status).toBe(503);
    expect(f.state.graph).toEqual([]);
  });

  it("slug ilegível → 503 antes de consumir o código", async () => {
    const f = fixture();
    const state = await f.start(OWNER_A, UNIT_A);
    f.state.errors.add("units");
    expect((await f.call(OWNER_A, { action: "callback", code: CODE, state })).status).toBe(503);
    expect(f.state.graph).toEqual([]);
  });
});

describe("instagram-connect — status (C6)", () => {
  it("chama a RPC com o JWT do usuário, nunca com a service role", async () => {
    const f = fixture();
    f.seedAccount();
    const r = await f.call(GERENTE_A, { action: "status", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      account: {
        username: "restaurante_a", status: "connected", token_expires_at: "2026-12-01T12:00:00.000Z",
        connected_at: "2026-10-01T12:00:00.000Z", subscribed: true, last_error_code: null,
      },
    });
    const calls = f.state.rpcs.filter((x) => x.name === "get_instagram_account_status");
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(env.SUPABASE_ANON_KEY);
    expect(calls[0].auth).toBe(`Bearer ${GERENTE_A}`);
    expect(calls[0].args).toEqual({ p_unit_id: UNIT_A });
    f.leakFree(r.text);
  });

  it("sem conta ativa → account null; vale com grant revogado e para platform_admin", async () => {
    const f = fixture();
    f.state.grants[0].revoked_at = "2026-10-01T00:00:00Z";
    const r = await f.call(ADMIN, { action: "status", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ account: null });
  });

  it("RPC recusa (42501) → 403", async () => {
    const f = fixture();
    f.state.errors.add("status_forbidden");
    expect((await f.call(OWNER_A, { action: "status", unit_id: UNIT_A })).status).toBe(403);
  });
});

describe("instagram-connect — disconnect (C2)", () => {
  it("owner desconecta a conta ativa da própria unidade, com ator da sessão", async () => {
    const f = fixture();
    f.seedAccount();
    const r = await f.call(OWNER_A, { action: "disconnect", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ disconnected: true });
    expect(f.state.rpcs).toEqual([{
      name: "disconnect_instagram_account", args: { p_account_id: ACC_A, p_actor: OWNER_A },
      key: env.SUPABASE_SERVICE_ROLE_KEY, auth: null,
    }]);
    expect(f.state.accounts[0].status).toBe("disconnected");
  });

  it("platform_admin desconecta com p_actor = ADMIN", async () => {
    const f = fixture();
    f.seedAccount();
    const r = await f.call(ADMIN, { action: "disconnect", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(f.state.rpcs).toEqual([{
      name: "disconnect_instagram_account", args: { p_account_id: ACC_A, p_actor: ADMIN },
      key: env.SUPABASE_SERVICE_ROLE_KEY, auth: null,
    }]);
  });

  it("membro de outra unidade → 403, conta intacta", async () => {
    const f = fixture();
    f.seedAccount();
    const r = await f.call(OWNER_B, { action: "disconnect", unit_id: UNIT_A });
    expect(r.status).toBe(403);
    expect(f.state.rpcs).toEqual([]);
    expect(f.state.accounts[0].status).toBe("connected");
  });

  it("funciona com o grant revogado", async () => {
    const f = fixture();
    f.seedAccount();
    f.state.grants[0].revoked_at = "2026-10-01T00:00:00Z";
    expect((await f.call(GERENTE_A, { action: "disconnect", unit_id: UNIT_A })).status).toBe(200);
  });

  it("sem conta ativa → 200 idempotente, sem RPC", async () => {
    const f = fixture();
    const r = await f.call(OWNER_A, { action: "disconnect", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ disconnected: true });
    expect(f.state.rpcs).toEqual([]);
  });

  it("RPC recusa (42501) → 403; leitura da conta com erro → 503", async () => {
    const f = fixture();
    f.seedAccount();
    f.state.errors.add("disconnect_forbidden");
    expect((await f.call(OWNER_A, { action: "disconnect", unit_id: UNIT_A })).status).toBe(403);
    const g = fixture();
    g.state.errors.add("accounts");
    expect((await g.call(OWNER_A, { action: "disconnect", unit_id: UNIT_A })).status).toBe(503);
  });
});

describe("instagram-connect — resubscribe", () => {
  it("assina de novo com o token do cofre e registra; o token não volta", async () => {
    const f = fixture();
    f.seedAccount();
    f.state.accounts[0].subscribed_fields = [];
    const r = await f.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ subscribed: true });
    expect(f.state.rpcs.map((x) => x.name)).toEqual(["get_instagram_account_token", "record_instagram_account_subscription"]);
    expect(f.state.rpcs[0].args).toEqual({ p_account_id: ACC_A });
    expect(f.state.graph).toHaveLength(1);
    expect(f.state.graph[0].method).toBe("POST");
    expect(f.state.graph[0].url).toBe(`${FB}/${PAGE}/subscribed_apps?subscribed_fields=messages`);
    expect(f.state.graph[0].auth).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(f.state.accounts[0].subscribed_fields).toEqual(["messages"]);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it.each([
    ["nulo", null],
    ["fora do formato", "abc"],
  ])("conta com page_id %s → 409 reconectar, sem Graph e sem ler o token", async (_n, pageId) => {
    const f = fixture();
    f.seedAccount(UNIT_A, "connected", pageId);
    const r = await f.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "A conta do Instagram precisa ser reconectada." });
    expect(f.state.graph).toEqual([]);
    expect(f.state.rpcs).toEqual([]);
  });

  it("falha do Graph → 502 com subscribed:false", async () => {
    const f = fixture({ subscribeOk: false });
    f.seedAccount();
    const r = await f.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A });
    expect(r.status).toBe(502);
    expect(r.json.subscribed).toBe(false);
    f.leakFree(r.text);
    f.leakFree(f.harness.logs.join("\n"));
  });

  it("sem conta ativa → 404; conta em reauth_required → 409; grant revogado → 403", async () => {
    const f = fixture();
    expect((await f.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A })).status).toBe(404);
    const g = fixture();
    g.seedAccount(UNIT_A, "reauth_required");
    expect((await g.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A })).status).toBe(409);
    const h = fixture();
    h.seedAccount();
    h.state.grants[0].revoked_at = "2026-10-01T00:00:00Z";
    expect((await h.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A })).status).toBe(403);
    for (const x of [f, g, h]) expect(x.state.graph).toEqual([]);
  });

  it("token ilegível → 503, sem Graph", async () => {
    const f = fixture();
    f.seedAccount();
    f.state.errors.add("token");
    expect((await f.call(OWNER_A, { action: "resubscribe", unit_id: UNIT_A })).status).toBe(503);
    expect(f.state.graph).toEqual([]);
  });
});

describe("instagram-connect — guardas estáticas", () => {
  it("corpo acima de 16 KiB → 413; JSON inválido → 400; ambos em PT-BR", async () => {
    const f = fixture();
    const call = (body: string) => f.harness.request("instagram-connect", new Request(URL_FN, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8080", Authorization: `Bearer ${OWNER_A}` },
      body,
    }));
    const big = await call(JSON.stringify({ action: "start", unit_id: UNIT_A, pad: "x".repeat(17_000) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "Requisição grande demais." });
    const bad = await call("{nao-e-json");
    expect(bad.status).toBe(400);
    expect(f.state.rpcs).toEqual([]);
  });

  it("logs de falha de leitura da conta levam action; exceção não tratada leva só o nome da classe", async () => {
    const f = fixture();
    f.state.errors.add("accounts");
    expect((await f.call(OWNER_A, { action: "disconnect", unit_id: UNIT_A })).status).toBe(503);
    const logs = f.harness.logs.join("\n");
    expect(logs).toMatch(/instagram_connect_account_read_failed[^\n]*disconnect/);
  });

  it("Deno.env só no index e nenhum log de mensagem de erro", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/instagram-connect/index.ts"), "utf8");
    expect(src).not.toMatch(/\.message\b/);
    expect(src).not.toMatch(/String\(\s*(e|err|error)\s*\)/);
    expect(src).not.toMatch(/rpc\(\s*["']is_unit_member/);
    // Só o fluxo da Página: nada do Login do Instagram.
    expect(src).not.toMatch(/graph\.(me|subscribe|toLongLived|refresh)\(/);
    expect(src).not.toContain("graph.instagram.com");
    expect(src).not.toContain("notProfessional");
  });
});

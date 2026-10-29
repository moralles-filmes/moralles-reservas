// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";

/**
 * Request do `process-instagram-token-refresh` (Task 2.5, C4) no harness.
 * Banco e Graph falsos; nenhuma chamada sai para a Meta. Tokens sintéticos.
 */

const env = {
  SUPABASE_URL: "https://synthetic-project.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  INTERNAL_API_KEY: "synthetic-internal-key",
};
const URL_FN = `${env.SUPABASE_URL}/functions/v1/process-instagram-token-refresh`;
const LEAK = "pg-message-with-SECRET-detail";
const NEW_TOKEN = "IGAA-test-NEW-token-XYZ";
const id = (n: number) => `15000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UNIT = id(100);
const tokenOf = (accId: string) => `IGAA-test-old-${accId.slice(-4)}`;
const refreshUrl = (token: string) =>
  `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`;

type Row = Record<string, unknown>;

const harnesses: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => harnesses.splice(0).forEach((h) => h.dispose()));

const acct = (n: number, over: Row = {}): Row => ({
  id: id(n), unit_id: UNIT, status: "connected",
  token_refreshed_at: null, connected_at: "2026-08-20T12:00:00.000Z", token_expires_at: "2026-11-30T12:00:00.000Z",
  ...over,
});
const STALE = (n: number) => acct(n); // 45 dias em 2026-10-04: renova
const FRESH = (n: number) => acct(n, { connected_at: "2026-10-01T12:00:00.000Z" }); // 3 dias: skip
const EXPIRED = (n: number) => acct(n, { token_expires_at: "2026-10-01T12:00:00.000Z" });

function fixture(
  accounts: Row[],
  opts: { graph?: Record<string, { status: number; body: unknown }>; scanFails?: boolean; rpcFail?: Record<string, string> } = {},
) {
  const state = {
    accounts,
    reads: [] as { filters: Row; range: [number, number] | null }[],
    rpcs: [] as { name: string; args: Row; key: string }[],
    graph: [] as string[],
  };
  const err = (code: string) => ({ data: null, error: { code, message: LEAK } });

  const createClient = (_url: string, key: string) => {
    const from = (table: string) => {
      const f: Row = {};
      let range: [number, number] | null = null;
      const result = async () => {
        if (key !== env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("read without service role");
        if (table !== "instagram_accounts") throw new Error(`unexpected read ${table}`);
        state.reads.push({ filters: { ...f }, range });
        if (opts.scanFails) return err("08006");
        const matching = state.accounts.filter((a) => a.status === f.status);
        const [lo, hi] = range ?? [0, matching.length - 1];
        return { data: matching.slice(lo, hi + 1), error: null };
      };
      const q = {
        select(_v: string) { return q; },
        eq(k: string, v: unknown) { f[k] = v; return q; },
        order(_k: string, _o: unknown) { return q; },
        range(a: number, b: number) { range = [a, b]; return q; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return result().then(resolve, reject); },
      };
      return q;
    };
    const rpc = async (name: string, args: Row) => {
      state.rpcs.push({ name, args: { ...args }, key });
      if (key !== env.SUPABASE_SERVICE_ROLE_KEY) return err("42501");
      const failCode = opts.rpcFail?.[`${name}:${args.p_account_id}`];
      if (failCode) return err(failCode);
      const acc = state.accounts.find((a) => a.id === args.p_account_id);
      if (name === "get_instagram_account_token") {
        return acc ? { data: tokenOf(acc.id as string), error: null } : err("P0002");
      }
      if (name === "record_instagram_token_refresh") {
        if (acc) { acc.token_refreshed_at = new Date().toISOString(); acc.token_expires_at = args.p_expires_at; }
        return { data: null, error: null };
      }
      if (name === "set_instagram_account_status") {
        if (acc) acc.status = args.p_status;
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    };
    return { from, rpc };
  };

  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const transport = accounts.map((a) => ({
    method: "GET",
    url: refreshUrl(tokenOf(a.id as string)),
    respond: async (_r: Request) => {
      state.graph.push(a.id as string);
      const custom = opts.graph?.[a.id as string];
      if (custom) return jsonRes(custom.status, custom.body);
      return jsonRes(200, { access_token: NEW_TOKEN, token_type: "bearer", expires_in: 5_184_000 });
    },
  }));

  const harness = createEdgeRequestHarness({ env, createClient, transport });
  harnesses.push(harness);
  const call = async (headers: Record<string, string> = { "x-internal-key": env.INTERNAL_API_KEY }) => {
    const res = await harness.request(
      "process-instagram-token-refresh",
      new Request(URL_FN, { method: "POST", headers, body: "{}" }),
    );
    const text = await res.text();
    let json: Row = {};
    try { json = JSON.parse(text); } catch { /* corpo vazio */ }
    return { status: res.status, text, json };
  };
  const noLeak = (text: string) => {
    for (const a of accounts) expect(text).not.toContain(tokenOf(a.id as string));
    for (const s of [NEW_TOKEN, LEAK]) expect(text).not.toContain(s);
  };
  return { state, harness, call, noLeak };
}

describe("process-instagram-token-refresh (Request)", () => {
  it("sem x-internal-key: 401 e nenhuma leitura", async () => {
    const f = fixture([STALE(1)]);
    expect((await f.call({})).status).toBe(401);
    expect((await f.call({ "x-internal-key": "errada" })).status).toBe(401);
    expect(f.state.reads).toHaveLength(0);
    expect(f.state.rpcs).toHaveLength(0);
    expect(f.state.graph).toHaveLength(0);
  });

  it("pagina com range e lê todas as contas", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => FRESH(1000 + i));
    const f = fixture(many);
    const r = await f.call();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ scanned: 1203, refreshed: 0, expired: 0, reauth: 0, failed: 0 });
    expect(f.state.reads.map((x) => x.range)).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(f.state.reads.every((x) => x.filters.status === "connected")).toBe(true);
  });

  it("vencida: set_instagram_account_status expired e zero Graph", async () => {
    const f = fixture([EXPIRED(2)]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 1, reauth: 0, failed: 0 });
    expect(f.state.rpcs).toEqual([{
      name: "set_instagram_account_status",
      args: { p_account_id: id(2), p_status: "reauth_required", p_error_code: "expired" },
      key: env.SUPABASE_SERVICE_ROLE_KEY,
    }]);
    expect(f.state.graph).toHaveLength(0);
  });

  it("renova com sucesso: grava o token novo e nada vaza", async () => {
    const f = fixture([STALE(3), FRESH(4)]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 1, expired: 0, reauth: 0, failed: 0 });
    expect(f.state.graph).toEqual([id(3)]);
    const rec = f.state.rpcs.filter((x) => x.name === "record_instagram_token_refresh");
    expect(rec).toHaveLength(1);
    expect(rec[0].args.p_account_id).toBe(id(3));
    expect(rec[0].args.p_token).toBe(NEW_TOKEN);
    expect(rec[0].args.p_expires_at).toBe(new Date(f.harness.now + 5_184_000 * 1000).toISOString());
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("Graph 190: reauth_required com código curto, sem texto da Meta", async () => {
    const f = fixture([STALE(5)], {
      graph: { [id(5)]: { status: 400, body: { error: { code: 190, message: `Invalid OAuth access token ${tokenOf(id(5))}` } } } },
    });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 1, failed: 0 });
    const st = f.state.rpcs.find((x) => x.name === "set_instagram_account_status");
    expect(st?.args).toEqual({ p_account_id: id(5), p_status: "reauth_required", p_error_code: "190" });
    expect(f.state.rpcs.some((x) => x.name === "record_instagram_token_refresh")).toBe(false);
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("transitório: sem escrita, tenta amanhã", async () => {
    const f = fixture([STALE(6)], { graph: { [id(6)]: { status: 503, body: { error: { message: "down" } } } } });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 1 });
    expect(f.state.rpcs.filter((x) => x.name !== "get_instagram_account_token")).toHaveLength(0);
  });

  it("erro de RPC numa conta não interrompe a próxima", async () => {
    const f = fixture([STALE(7), STALE(8)], { rpcFail: { [`get_instagram_account_token:${id(7)}`]: "P0002" } });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 1, expired: 0, reauth: 0, failed: 1 });
    expect(f.state.graph).toEqual([id(8)]);
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("erro de leitura da varredura: 503 sem escrita e sem vazar", async () => {
    const f = fixture([STALE(9)], { scanFails: true });
    const r = await f.call();
    expect(r.status).toBe(503);
    expect(f.state.rpcs).toHaveLength(0);
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("data ilegível: pula sem Graph", async () => {
    const f = fixture([acct(10, { connected_at: "lixo" })]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 0 });
    expect(f.state.graph).toHaveLength(0);
    expect(f.state.rpcs).toHaveLength(0);
  });
});

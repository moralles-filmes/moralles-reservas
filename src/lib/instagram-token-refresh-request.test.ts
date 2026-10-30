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
const RECONNECTED_AT = "2026-10-04T11:59:00.123456+00:00";
const STALE = (n: number) => acct(n); // 45 dias em 2026-10-04: renova
const FRESH = (n: number) => acct(n, { connected_at: "2026-10-01T12:00:00.000Z" }); // 3 dias: skip
const EXPIRED = (n: number) => acct(n, { token_expires_at: "2026-10-01T12:00:00.000Z" });

function fixture(
  accounts: Row[],
  opts: { graph?: Record<string, { status: number; body: unknown }>; scanFails?: boolean; rpcFail?: Record<string, string>; graphDelayMs?: number; reconnectOnGraph?: string[]; reconnectAfterScan?: string[]; nullWrite?: string[] } = {},
) {
  const state = {
    accounts,
    orders: [] as unknown[][],
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
        const page = matching.slice(lo, hi + 1).map((a) => ({ ...a }));
        // Reconexão logo depois da leitura da varredura (antes de qualquer RPC).
        for (const a of state.accounts) if (opts.reconnectAfterScan?.includes(a.id as string)) a.connected_at = RECONNECTED_AT;
        return { data: page, error: null };
      };
      const q = {
        select(_v: string) { return q; },
        eq(k: string, v: unknown) { f[k] = v; return q; },
        order(...a: unknown[]) { state.orders.push(a); return q; },
        range(a: number, b: number) { range = [a, b]; return q; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return result().then(resolve, reject); },
      };
      return q;
    };
    const rpc = async (name: string, args: Row) => {
      state.rpcs.push({ name, args: { ...args }, key });
      if (key !== env.SUPABASE_SERVICE_ROLE_KEY) return err("42501");
      const failCode = opts.rpcFail?.[`${name}:${args.p_account_id}`];
      if (failCode === "throw") throw new TypeError(LEAK);
      if (failCode) return err(failCode);
      const acc = state.accounts.find((a) => a.id === args.p_account_id);
      if (name === "get_instagram_account_token") {
        if (opts.graphDelayMs) await harness.advanceTime(opts.graphDelayMs);
        return acc ? { data: tokenOf(acc.id as string), error: null } : err("P0002");
      }
      // CAS fiel à 20261029200800: geração ausente é 22023; divergente devolve
      // `false` sem efeito; igual aplica e devolve `true`.
      if (name === "record_instagram_token_refresh" || name === "set_instagram_account_status") {
        if (!acc) return err("P0002");
        if (opts.nullWrite?.includes(`${name}:${args.p_account_id}`)) return { data: null, error: null };
        if (typeof args.p_expected_connected_at !== "string") return err("22023");
        if (Date.parse(args.p_expected_connected_at) !== Date.parse(acc.connected_at as string)) {
          return { data: false, error: null };
        }
        if (name === "record_instagram_token_refresh") {
          acc.token_refreshed_at = new Date().toISOString();
          acc.token_expires_at = args.p_expires_at;
        } else {
          acc.status = args.p_status;
        }
        return { data: true, error: null };
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
      // O dono reconecta enquanto a varredura fala com a Meta: `connected_at` muda.
      if (opts.reconnectOnGraph?.includes(a.id as string)) a.connected_at = RECONNECTED_AT;
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
    expect(r.json).toEqual({ scanned: 1203, refreshed: 0, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 0 });
    expect(f.state.reads.map((x) => x.range)).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(f.state.reads.every((x) => x.filters.status === "connected")).toBe(true);
  });

  it("vencida: set_instagram_account_status expired e zero Graph", async () => {
    const f = fixture([EXPIRED(2)]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 1, reauth: 0, failed: 0, remaining: 0, skipped_stale: 0 });
    expect(f.state.rpcs).toEqual([{
      name: "set_instagram_account_status",
      args: { p_account_id: id(2), p_status: "reauth_required", p_error_code: "expired", p_expected_connected_at: "2026-08-20T12:00:00.000Z" },
      key: env.SUPABASE_SERVICE_ROLE_KEY,
    }]);
    expect(f.state.graph).toHaveLength(0);
  });

  it("renova com sucesso: grava o token novo e nada vaza", async () => {
    const f = fixture([STALE(3), FRESH(4)]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 1, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 0 });
    expect(f.state.graph).toEqual([id(3)]);
    const rec = f.state.rpcs.filter((x) => x.name === "record_instagram_token_refresh");
    expect(rec).toHaveLength(1);
    expect(rec[0].args.p_account_id).toBe(id(3));
    expect(rec[0].args.p_token).toBe(NEW_TOKEN);
    expect(rec[0].args.p_expected_connected_at).toBe("2026-08-20T12:00:00.000Z");
    expect(rec[0].args.p_expires_at).toBe(new Date(f.harness.now + 5_184_000 * 1000).toISOString());
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("Graph 190: reauth_required com código curto, sem texto da Meta", async () => {
    const f = fixture([STALE(5)], {
      graph: { [id(5)]: { status: 400, body: { error: { code: 190, message: `Invalid OAuth access token ${tokenOf(id(5))}` } } } },
    });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 1, failed: 0, remaining: 0, skipped_stale: 0 });
    const st = f.state.rpcs.find((x) => x.name === "set_instagram_account_status");
    expect(st?.args).toEqual({ p_account_id: id(5), p_status: "reauth_required", p_error_code: "190", p_expected_connected_at: "2026-08-20T12:00:00.000Z" });
    expect(f.state.rpcs.some((x) => x.name === "record_instagram_token_refresh")).toBe(false);
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("transitório: sem escrita, tenta amanhã", async () => {
    const f = fixture([STALE(6)], { graph: { [id(6)]: { status: 503, body: { error: { message: "down" } } } } });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 1, remaining: 0, skipped_stale: 0 });
    expect(f.state.rpcs.filter((x) => x.name !== "get_instagram_account_token")).toHaveLength(0);
  });

  it("erro de RPC numa conta não interrompe a próxima", async () => {
    const f = fixture([STALE(7), STALE(8)], { rpcFail: { [`get_instagram_account_token:${id(7)}`]: "P0002" } });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 1, expired: 0, reauth: 0, failed: 1, remaining: 0, skipped_stale: 0 });
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

  it("order(id) ascendente em toda página", async () => {
    const f = fixture([FRESH(1)]);
    await f.call();
    expect(f.state.orders).toEqual([["id", { ascending: true }]]);
  });

  it("processa primeiro vencidas e depois as mais velhas; ignora skip", async () => {
    const OLD = acct(21, { connected_at: "2026-07-01T12:00:00.000Z", token_expires_at: "2026-12-30T12:00:00.000Z" });
    const f = fixture([STALE(20), FRESH(22), OLD, EXPIRED(23)]);
    const r = await f.call();
    expect(r.json).toMatchObject({ scanned: 4, refreshed: 2, expired: 1, failed: 0, remaining: 0, skipped_stale: 0 });
    expect(f.state.rpcs.map((x) => `${x.name}:${x.args.p_account_id}`)).toEqual([
      `set_instagram_account_status:${id(23)}`,
      `get_instagram_account_token:${id(21)}`,
      `record_instagram_token_refresh:${id(21)}`,
      `get_instagram_account_token:${id(20)}`,
      `record_instagram_token_refresh:${id(20)}`,
    ]);
  });

  it("orçamento de tempo: para de iniciar contas e informa remaining", async () => {
    const f = fixture([STALE(30), STALE(31), STALE(32)], { graphDelayMs: 60_000 });
    const r = await f.call();
    // 1ª conta (t=0) e 2ª (t=60s) rodam; na 3ª (t=120s >= 100s) o orçamento acabou
    expect(r.json).toEqual({ scanned: 3, refreshed: 2, expired: 0, reauth: 0, failed: 0, remaining: 1, skipped_stale: 0 });
    expect(f.state.graph).toEqual([id(30), id(31)]);
    expect(f.harness.logs.join("\n")).toContain("instagram_refresh_budget_exhausted");
  });

  it("falha ao gravar o token novo: failed, segue a próxima, nada vaza", async () => {
    const f = fixture([STALE(40), STALE(41)], { rpcFail: { [`record_instagram_token_refresh:${id(40)}`]: "XX000" } });
    const r = await f.call();
    expect(r.json).toMatchObject({ refreshed: 1, failed: 1 });
    expect(f.state.graph).toEqual([id(40), id(41)]);
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("exceção por conta: loga só o nome da classe, nunca a mensagem", async () => {
    const f = fixture([STALE(50), STALE(51)], { rpcFail: { [`get_instagram_account_token:${id(50)}`]: "throw" } });
    const r = await f.call();
    expect(r.json).toMatchObject({ refreshed: 1, failed: 1 });
    const logs = f.harness.logs.join("\n");
    expect(logs).toContain("instagram_refresh_account_unhandled");
    expect(logs).toContain("TypeError");
    f.noLeak(r.text);
    f.noLeak(logs);
  });

  it("data ilegível: pula sem Graph", async () => {
    const f = fixture([acct(10, { connected_at: "lixo" })]);
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 0 });
    expect(f.state.graph).toHaveLength(0);
    expect(f.state.rpcs).toHaveLength(0);
  });

  // CAS por `connected_at` (Task 4.5): reconexão durante a varredura.
  it("reconexão durante o refresh: skipped_stale, o token novo da conexão não é sobrescrito", async () => {
    const f = fixture([STALE(60), STALE(61)], { reconnectOnGraph: [id(60)] });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 1, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 1 });
    const rec = f.state.rpcs.filter((x) => x.name === "record_instagram_token_refresh");
    expect(rec.map((x) => [x.args.p_account_id, x.args.p_expected_connected_at]))
      .toEqual([[id(60), "2026-08-20T12:00:00.000Z"], [id(61), "2026-08-20T12:00:00.000Z"]]);
    const a60 = f.state.accounts.find((a) => a.id === id(60));
    expect(a60).toMatchObject({ status: "connected", token_refreshed_at: null, connected_at: RECONNECTED_AT });
    expect(f.harness.logs.join("\n")).toContain("instagram_refresh_skipped_stale");
    f.noLeak(r.text);
    f.noLeak(f.harness.logs.join("\n"));
  });

  it("reconexão durante a varredura com Graph 190: skipped_stale, a conta NÃO vai para reauth_required", async () => {
    const f = fixture([STALE(62)], {
      reconnectOnGraph: [id(62)],
      graph: { [id(62)]: { status: 400, body: { error: { code: 190, message: "Invalid OAuth access token" } } } },
    });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 1 });
    expect(f.state.rpcs.find((x) => x.name === "set_instagram_account_status")?.args.p_expected_connected_at)
      .toBe("2026-08-20T12:00:00.000Z");
    expect(f.state.accounts.find((a) => a.id === id(62))).toMatchObject({ status: "connected", connected_at: RECONNECTED_AT });
  });

  it("reconexão depois da leitura da varredura com token vencido: skipped_stale, conta segue connected", async () => {
    const f = fixture([EXPIRED(63)], { reconnectAfterScan: [id(63)] });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 1, refreshed: 0, expired: 0, reauth: 0, failed: 0, remaining: 0, skipped_stale: 1 });
    expect(f.state.graph).toHaveLength(0);
    expect(f.state.accounts.find((a) => a.id === id(63))).toMatchObject({ status: "connected" });
  });

  it("resposta fora do contrato do CAS (nem true nem false) conta failed, nunca refreshed", async () => {
    const f = fixture([STALE(64), EXPIRED(65)], {
      nullWrite: [`record_instagram_token_refresh:${id(64)}`, `set_instagram_account_status:${id(65)}`],
    });
    const r = await f.call();
    expect(r.json).toEqual({ scanned: 2, refreshed: 0, expired: 0, reauth: 0, failed: 2, remaining: 0, skipped_stale: 0 });
  });
});

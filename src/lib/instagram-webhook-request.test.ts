// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";

/**
 * Request do `webhook-instagram` (Task 2.3) no harness: autentica sobre o
 * corpo cru, resolve conta e unidade pelo MESMO select (C3), gates sem cache
 * com polaridade fechada, grava na fila antes do ACK e dá o kick pós-ACK.
 *
 * O kick vai para `process-instagram-inbound`, que só nasce na Task 4.1: o
 * harness recusa o hop não declarado (`internal_hop`) e o código tem de
 * engolir a recusa. Cada tentativa fica registrada como um `internal_hop` e
 * como um log `instagram_inbound_kick_failed`; o formato do pedido (só
 * `{ event_id }` + `x-internal-key`) é coberto no teste do núcleo.
 */

const env = {
  SUPABASE_URL: "https://synthetic-project.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  INTERNAL_API_KEY: "synthetic-internal",
};
const IG_SECRET = "synthetic-ig-app-secret";
const META_SECRET = "synthetic-meta-app-secret";
const VERIFY = "synthetic-verify-token";
const URL_WEBHOOK = `${env.SUPABASE_URL}/functions/v1/webhook-instagram`;

const id = (n: number) => `13000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const UNIT_A = id(101), UNIT_B = id(102);
const ACC_A = id(1), ACC_B = id(2);
const IG_A = "17841400000000001", IG_B = "17841400000000002";

type Row = Record<string, unknown>;
type ErrorFlag = "secrets" | "accounts" | "grants" | "settings" | "insert";

const harnesses: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => harnesses.splice(0).forEach((h) => h.dispose()));

function fixture() {
  const state = {
    secrets: { instagram_app_secret: IG_SECRET, verify: VERIFY, meta_app_secret: null as string | null } as Record<string, string | null>,
    accounts: [
      { id: ACC_A, unit_id: UNIT_A, ig_user_id: IG_A, status: "connected" },
      { id: ACC_B, unit_id: UNIT_B, ig_user_id: IG_B, status: "connected" },
    ] as Row[],
    grants: [
      { unit_id: UNIT_A, module: "instagram", revoked_at: null },
      { unit_id: UNIT_B, module: "instagram", revoked_at: null },
    ] as Row[],
    settings: [
      { unit_id: UNIT_A, dm_enabled: true },
      { unit_id: UNIT_B, dm_enabled: true },
    ] as Row[],
    errors: new Set<ErrorFlag>(),
    queue: [] as Row[],
    reads: [] as string[],
    queries: [] as { table: string; columns: string; filters: Row }[],
  };
  let seq = 0;

  const db = {
    from(table: string) {
      let columns = "";
      let insertValue: Row | null = null;
      const filters: Row = {};
      const result = async (): Promise<{ data: unknown; error: unknown }> => {
        if (insertValue) {
          if (table !== "instagram_inbound_events") throw new Error(`unexpected insert ${table}`);
          if (state.errors.has("insert")) return { data: null, error: { code: "XX000" } };
          expect(Object.keys(insertValue).sort()).toEqual(
            ["body_sha256", "instagram_account_id", "raw_body", "signature_secret", "unit_id"],
          );
          expect(columns).toBe("id");
          const dup = state.queue.find((r) => r.instagram_account_id === insertValue!.instagram_account_id
            && r.body_sha256 === insertValue!.body_sha256);
          if (dup) return { data: null, error: { code: "23505" } };
          const row = { id: `evt-${++seq}`, ...insertValue };
          state.queue.push(row);
          return { data: { id: row.id }, error: null };
        }
        state.reads.push(table);
        state.queries.push({ table, columns, filters: { ...filters } });
        if (table === "platform_secrets") {
          if (state.errors.has("secrets")) return { data: null, error: { code: "08006" } };
          const key = filters.key as string;
          const map: Record<string, string | null> = {
            instagram_app_secret: state.secrets.instagram_app_secret,
            instagram_verify_token: state.secrets.verify,
            meta_app_secret: state.secrets.meta_app_secret,
          };
          if (!(key in map)) throw new Error(`unexpected secret ${key}`);
          return { data: map[key] === null ? null : { value: map[key] }, error: null };
        }
        if (table === "instagram_accounts") {
          if (state.errors.has("accounts")) return { data: null, error: { code: "08006" } };
          expect(columns).toBe("id, unit_id, ig_user_id");
          const ids = filters["in:ig_user_id"] as string[];
          return {
            data: state.accounts.filter((a) => ids.includes(a.ig_user_id as string) && a.status === filters.status)
              .map(({ id: i, unit_id, ig_user_id }) => ({ id: i, unit_id, ig_user_id })),
            error: null,
          };
        }
        if (table === "unit_module_grants") {
          if (state.errors.has("grants")) return { data: null, error: { code: "08006" } };
          expect(filters.module).toBe("instagram");
          expect(filters["is:revoked_at"]).toBe(null);
          const units = filters["in:unit_id"] as string[];
          return {
            data: state.grants.filter((g) => units.includes(g.unit_id as string) && g.module === "instagram" && g.revoked_at === null)
              .map((g) => ({ unit_id: g.unit_id })),
            error: null,
          };
        }
        if (table === "instagram_settings") {
          if (state.errors.has("settings")) return { data: null, error: { code: "08006" } };
          const units = filters["in:unit_id"] as string[];
          return { data: state.settings.filter((s) => units.includes(s.unit_id as string)), error: null };
        }
        throw new Error(`unexpected read ${table}`);
      };
      const q = {
        select(value: string) { columns = value; return q; },
        eq(k: string, v: unknown) { filters[k] = v; return q; },
        in(k: string, v: unknown) { filters[`in:${k}`] = v; return q; },
        is(k: string, v: unknown) { filters[`is:${k}`] = v; return q; },
        insert(value: Row) { insertValue = value; return q; },
        maybeSingle: () => result(),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return result().then(resolve, reject); },
      };
      return q;
    },
    rpc() { throw new Error("unexpected rpc"); },
  };

  const harness = createEdgeRequestHarness({ env, createClient: () => db });
  harnesses.push(harness);

  const post = (raw: Uint8Array, opts: { secret?: string | null; header?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    const secret = opts.secret === undefined ? IG_SECRET : opts.secret;
    if (opts.header !== undefined) headers["x-hub-signature-256"] = opts.header;
    else if (secret !== null) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    return harness.request("webhook-instagram", new Request(URL_WEBHOOK, { method: "POST", headers, body: new Uint8Array(raw) }));
  };
  /** POST com corpo em stream (chunked, sem Content-Length). */
  const postStream = (stream: ReadableStream<Uint8Array>, signedRaw?: Uint8Array) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signedRaw) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", IG_SECRET).update(signedRaw).digest("hex")}`;
    const init = { method: "POST", headers, body: stream, duplex: "half" } as RequestInit;
    const request = new Request(URL_WEBHOOK, init);
    expect(request.headers.get("content-length")).toBeNull();
    return harness.request("webhook-instagram", request);
  };
  const kickAttempts = () => harness.logs.filter((l) => l.includes("instagram_inbound_kick_failed")).length;
  /** Toda I/O inesperada tem de ser exatamente os `n` kicks recusados pelo harness. */
  const expectOnlyKicks = (n: number) => {
    if (n === 0) expect(() => harness.assertNoUnexpectedIo()).not.toThrow();
    else expect(() => harness.assertNoUnexpectedIo()).toThrow(`Unexpected fixture I/O recorded: ${Array(n).fill("internal_hop").join(", ")}`);
  };
  return { state, harness, post, postStream, kickAttempts, expectOnlyKicks };
}

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const msg = (igId: string, mid: string) => ({
  id: igId, time: 1,
  messaging: [{ sender: { id: "999" }, recipient: { id: igId }, timestamp: 1, message: { mid, text: "Olá, mesa p/ 2?" } }],
});
const batch = (...entries: unknown[]) => enc({ object: "instagram", entry: entries });

describe("webhook-instagram POST", () => {
  it("webhook grava uma linha por conta do lote", async () => {
    const f = fixture();
    const raw = batch(msg(IG_A, "m-a"), msg(IG_B, "m-b"));
    const res = await f.post(raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const hex = `\\x${Buffer.from(raw).toString("hex")}`;
    const sha = createHash("sha256").update(raw).digest("hex");
    expect(f.state.queue).toEqual([
      { id: "evt-1", instagram_account_id: ACC_A, unit_id: UNIT_A, raw_body: hex, body_sha256: sha, signature_secret: "instagram" },
      { id: "evt-2", instagram_account_id: ACC_B, unit_id: UNIT_B, raw_body: hex, body_sha256: sha, signature_secret: "instagram" },
    ]);
    // Uma única leitura de contas, filtrando `connected`.
    const accountQueries = f.state.queries.filter((q) => q.table === "instagram_accounts");
    expect(accountQueries).toHaveLength(1);
    expect(accountQueries[0].filters).toEqual({ "in:ig_user_id": [IG_A, IG_B], status: "connected" });
    await f.harness.drainBackground();
    expect(f.kickAttempts()).toBe(2);
    f.expectOnlyKicks(2);
    expect(f.harness.logs.join("\n")).not.toContain(IG_SECRET);
  });

  it("corpo cru com UTF-8 inválido é gravado byte a byte (R2-a)", async () => {
    const f = fixture();
    const head = new TextEncoder().encode(`{"object":"instagram","entry":[{"id":"${IG_A}","x":"café `);
    const raw = new Uint8Array([...head, 0xff, ...new TextEncoder().encode('"}]}')]);
    expect((await f.post(raw)).status).toBe(200);
    expect(f.state.queue).toHaveLength(1);
    expect(f.state.queue[0].raw_body).toBe(`\\x${Buffer.from(raw).toString("hex")}`);
    await f.harness.drainBackground();
    f.expectOnlyKicks(1);
  });

  it("assinatura inválida dá 401, sem nenhuma leitura de conta", async () => {
    const f = fixture();
    for (const opts of [{ secret: "other-secret" }, { secret: null }, { header: "sha1=abc" }]) {
      expect((await f.post(batch(msg(IG_A, "m")), opts)).status).toBe(401);
    }
    expect(f.state.reads.filter((t) => t !== "platform_secrets")).toEqual([]);
    expect(f.state.queue).toEqual([]);
    expect(f.harness.logs.filter((l) => l.includes("instagram_webhook_unauthorized"))).toHaveLength(3);
    f.expectOnlyKicks(0);
  });

  it("candidato meta casa e grava signature_secret='meta'", async () => {
    const f = fixture();
    f.state.secrets.meta_app_secret = META_SECRET;
    expect((await f.post(batch(msg(IG_A, "m")), { secret: META_SECRET })).status).toBe(200);
    expect(f.state.queue.map((r) => r.signature_secret)).toEqual(["meta"]);
    expect(f.harness.logs.some((l) => l.includes("instagram_webhook_authenticated") && l.includes('"meta"'))).toBe(true);
    await f.harness.drainBackground();
    f.expectOnlyKicks(1);
  });

  it("sem nenhum segredo configurado dá 503 (não 401)", async () => {
    const f = fixture();
    f.state.secrets.instagram_app_secret = null;
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(503);
    expect(f.state.reads.filter((t) => t !== "platform_secrets")).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("falha de leitura do segredo dá 503", async () => {
    const f = fixture();
    f.state.errors.add("secrets");
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(503);
    expect(f.state.queue).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("corpo acima do limite dá 413 antes de ler segredo", async () => {
    const f = fixture();
    const big = new Uint8Array(2_097_153).fill(0x20);
    expect((await f.post(big)).status).toBe(413);
    expect((await f.post(new Uint8Array(10).fill(0x20), { headers: { "content-length": "2097153" } })).status).toBe(413);
    expect(f.state.reads).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("corpo em stream sem Content-Length acima do limite: 413 durante a leitura, sem ler segredo", async () => {
    const f = fixture();
    const CHUNK = 64 * 1024;
    const TOTAL_CHUNKS = 64; // 4 MiB oferecidos; o limite é 2 MiB
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) { controller.close(); return; }
        pulled += 1;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    expect((await f.postStream(stream)).status).toBe(413);
    expect(f.state.reads).toEqual([]);
    // Parou logo depois de passar do limite: nunca leu o stream inteiro.
    expect(pulled * CHUNK).toBeLessThanOrEqual(2_097_152 + 2 * CHUNK);
    expect(cancelled).toBe(true);
    f.expectOnlyKicks(0);
  });

  it("corpo em stream exatamente no limite segue e grava os bytes idênticos", async () => {
    const f = fixture();
    const MAX = 2_097_152;
    const head = new TextEncoder().encode(`{"object":"instagram","entry":[{"id":"${IG_A}"}],"pad":"`);
    const tail = new TextEncoder().encode('"}');
    const raw = new Uint8Array(MAX);
    raw.set(head, 0);
    raw.fill(0x61, head.length, MAX - tail.length);
    raw.set(tail, MAX - tail.length);
    const CHUNK = 100_000;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= raw.length) { controller.close(); return; }
        controller.enqueue(raw.slice(offset, offset + CHUNK));
        offset += CHUNK;
      },
    });
    expect((await f.postStream(stream, raw)).status).toBe(200);
    expect(f.state.queue).toHaveLength(1);
    expect(f.state.queue[0].raw_body).toBe(`\\x${Buffer.from(raw).toString("hex")}`);
    expect(f.state.queue[0].body_sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    await f.harness.drainBackground();
    f.expectOnlyKicks(1);
  });

  it("lote misto: A elegível + B com grant revogado grava só A, com UNIT_A", async () => {
    const f = fixture();
    f.state.grants[1].revoked_at = "2026-10-01T00:00:00Z";
    expect((await f.post(batch(msg(IG_A, "m-a"), msg(IG_B, "m-b")))).status).toBe(200);
    expect(f.state.queue.map((r) => [r.instagram_account_id, r.unit_id])).toEqual([[ACC_A, UNIT_A]]);
    await f.harness.drainBackground();
    f.expectOnlyKicks(1);
  });

  it("lote misto: A elegível + B com Direct desligado grava só A, com UNIT_A", async () => {
    const f = fixture();
    f.state.settings[1].dm_enabled = false;
    expect((await f.post(batch(msg(IG_A, "m-a"), msg(IG_B, "m-b")))).status).toBe(200);
    expect(f.state.queue.map((r) => [r.instagram_account_id, r.unit_id])).toEqual([[ACC_A, UNIT_A]]);
    await f.harness.drainBackground();
    f.expectOnlyKicks(1);
  });

  it.each(["accounts", "grants", "settings"] as const)("erro ao ler %s dá 503, nada gravado", async (flag) => {
    const f = fixture();
    f.state.errors.add(flag);
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(503);
    expect(f.state.queue).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("grant revogado dá 200, sem linha gravada", async () => {
    const f = fixture();
    f.state.grants[0].revoked_at = "2026-10-01T00:00:00Z";
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(200);
    expect(f.state.queue).toEqual([]);
    expect(f.harness.logs.some((l) => l.includes('"no_grant":1'))).toBe(true);
    f.expectOnlyKicks(0);
  });

  it("Direct desligado e conta desconhecida dão 200, sem linha", async () => {
    const f = fixture();
    f.state.settings[0].dm_enabled = false;
    expect((await f.post(batch(msg(IG_A, "m"), msg("555", "m2")))).status).toBe(200);
    expect(f.state.queue).toEqual([]);
    expect(f.harness.logs.some((l) => l.includes('"dm_disabled":1') && l.includes('"unknown_account":1'))).toBe(true);
    f.expectOnlyKicks(0);
  });

  it("conta em reauth_required dá 200, sem linha", async () => {
    const f = fixture();
    f.state.accounts[0].status = "reauth_required";
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(200);
    expect(f.state.queue).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("mesmo corpo duas vezes grava uma linha (23505 é duplicata)", async () => {
    const f = fixture();
    const raw = batch(msg(IG_A, "m"));
    expect((await f.post(raw)).status).toBe(200);
    expect((await f.post(raw)).status).toBe(200);
    expect(f.state.queue).toHaveLength(1);
    await f.harness.drainBackground();
    expect(f.kickAttempts()).toBe(1);
    f.expectOnlyKicks(1);
  });

  it("erro do INSERT dá 503", async () => {
    const f = fixture();
    f.state.errors.add("insert");
    expect((await f.post(batch(msg(IG_A, "m")))).status).toBe(503);
    await f.harness.drainBackground();
    f.expectOnlyKicks(0);
  });

  it("object diferente de instagram e JSON inválido assinado dão 200 sem gravar", async () => {
    const f = fixture();
    expect((await f.post(enc({ object: "page", entry: [{ id: IG_A }] }))).status).toBe(200);
    expect((await f.post(new TextEncoder().encode("{not json"))).status).toBe(200);
    expect(f.state.reads.filter((t) => t !== "platform_secrets")).toEqual([]);
    expect(f.state.queue).toEqual([]);
    f.expectOnlyKicks(0);
  });

  it("método não suportado dá 405", async () => {
    const f = fixture();
    expect((await f.harness.request("webhook-instagram", new Request(URL_WEBHOOK, { method: "PUT", body: "x" }))).status).toBe(405);
    f.expectOnlyKicks(0);
  });
});

describe("webhook-instagram GET (verificação)", () => {
  const get = (f: ReturnType<typeof fixture>, q: string) =>
    f.harness.request("webhook-instagram", new Request(`${URL_WEBHOOK}?${q}`, { method: "GET" }));

  it("responde o hub.challenge", async () => {
    const f = fixture();
    const res = await get(f, `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("1158201444");
  });

  it("token errado dá 403", async () => {
    const f = fixture();
    expect((await get(f, "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
  });

  it("falha de leitura do token dá 503", async () => {
    const f = fixture();
    f.state.errors.add("secrets");
    expect((await get(f, `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(503);
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { createEdgeRequestHarness, resolveEdgeModule, validateEdgeSource } from "../test/fixtures/edge-request-harness";

const fixtures: ReturnType<typeof createEdgeRequestHarness>[] = [];
const env = {
  SUPABASE_URL: "https://synthetic-project.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  INTERNAL_API_KEY: "synthetic-internal-key",
};
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it('executes the actual management Deno.serve registration without exposing another endpoint',async()=>{
  const fixture=createEdgeRequestHarness({env,createClient:()=>({})});fixtures.push(fixture);
  const response=await fixture.request('manage-whatsapp-templates',new Request('https://synthetic-project.invalid/functions/v1/manage-whatsapp-templates',{method:'DELETE'}));
  expect(response.status).toBe(405);
  expect(fixture.manifest.has('manage-whatsapp-templates:manage-whatsapp-templates/index.ts')).toBe(true);
  expect(()=>Reflect.apply(fixture.load,fixture,['not-an-approved-endpoint'])).toThrow('Unknown Edge endpoint');
  fixture.assertNoUnexpectedIo();
});

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number };
type QueryTrace = { table: string; op: string; select?: string; filters: [string, string, unknown][]; values?: Row; count?: string; head?: boolean };
// A bounded structural I/O fixture, not an implementation of PostgreSQL locks,
// grants, JWT, RLS, triggers, queue ownership or authoritative RPC decisions.
function database(seed: Record<string, Row[]>, scripts: Record<string, (args: Row) => Result | Promise<Result>> = {}) {
  const tables = structuredClone(seed);
  const queries: QueryTrace[] = [];
  const rpcs: { name: string; args: Row }[] = [];
  const unexpected: string[] = [];
  const fail = (reason: string): never => { unexpected.push(reason); throw new Error(`Unexpected DB fixture I/O: ${reason}`); };
  // Exact projections exercised by these controls; unknown projections fail.
  const projections: Record<string, string[]> = {
    reservations: ["*, customer:customers(*), unit:units(name, phone, instagram, website, address)", "id, date, time, status", "id"],
    notification_outbox: ["id, reservation_id, unit_id, kind, attempts, automation_job_id, automation_initial_token"],
    whatsapp_automation_jobs: ["*"],
    whatsapp_automation_adoptions: ["adopted_at", "unit_id"],
    whatsapp_template_bindings: ["dispatch_enabled,adopted_at"],
    notifications_sent: ["id"],
    whatsapp_channels: ["id, unit_id, provider, credentials, webhook_secret, status, is_active, instance_token_secret_id, external_instance_id, template_credential_revision, activation_requested_at, manual_echo_verified_at, async_ingestion_enabled", "id"],
    platform_flags: ["value"],
    whatsapp_inbound_events: ["id"],
    units: ["organization_id", "name"],
    organizations: ["billing_status, whatsapp_legacy_grandfathered, whatsapp_grandfather_revoked_at"],
    organization_entitlement_overrides: ["enabled, starts_at, ends_at"],
    billing_subscriptions: ["id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features)"],
    waitlist: ["id, unit_id, customer_name, customer_phone, party_size, code, status, created_at"],
    settings: ["value", "key, value"],
    waitlist_message_templates: ["customized, body"],
  };
  const fields = new Set(["id", "unit_id", "organization_id", "key", "kind", "reservation_id", "waitlist_id", "status",
    "next_attempt_at", "whatsapp_provider", "whatsapp_channel_id", "provider_message_id", "delivered_at",
    "read_at", "failed_at", "is_active", "feature", "revoked_at", "starts_at", "ends_at", "event"]);
  const mutationColumns: Record<string, string[]> = {
    reservations: ["status"], notification_outbox: ["status", "updated_at", "next_attempt_at", "last_error"],
    notifications_sent: ["reservation_id", "unit_id", "kind", "status", "error", "provider_message_id", "whatsapp_provider", "whatsapp_channel_id", "sent_at", "delivered_at", "read_at", "failed_at"],
    webhook_executions: ["request_id", "unit_id", "channel_id", "phone_hash", "outcome", "error", "duration_ms", "meta"],
    whatsapp_inbound_events: ["provider", "channel_id", "unit_id", "raw_body", "delivery_id", "signature_header", "signature_scheme"],
  };
  const pick = (row: Row, columns: string[]) => Object.fromEntries(columns
    .filter((column) => Object.prototype.hasOwnProperty.call(row, column))
    .map((column) => [column, structuredClone(row[column])]));
  const relation = (value: unknown, columns: string[]): unknown => {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map((row) => relation(row, columns));
    if (typeof value !== "object") return fail("relation_shape");
    return pick(value as Row, columns);
  };
  const project = (table: string, row: Row, projection: string): Row => {
    // Only the two existing, explicitly seeded relation shapes are supported.
    // No join lookup/filtering or SQL authority is implemented here.
    if (table === "reservations" && projection === projections.reservations[0]) {
      return { ...pick(row, Object.keys(row).filter((key) => key !== "customer" && key !== "unit")),
        customer: structuredClone(row.customer),
        unit: relation(row.unit, ["name", "phone", "instagram", "website", "address"]) };
    }
    if (table === "billing_subscriptions" && projection === projections.billing_subscriptions[0]) {
      return { ...pick(row, ["id", "status", "canceled_at", "suspended_at"]),
        billing_plans: relation(row.billing_plans, ["category", "included_features"]) };
    }
    return pick(row, projection.split(",").map((column) => column.trim()));
  };
  const compare = (actual: unknown, op: string, expected: unknown) => {
    if (op === "eq" || op === "is") return actual === expected;
    if (op === "neq") return actual !== expected;
    if (op === "in") return (expected as unknown[]).includes(actual);
    if (op === "lte") return String(actual) <= String(expected);
    if (op === "gt") return String(actual) > String(expected);
    return fail(`operator:${op}`);
  };
  const client = {
    from(table: string) {
      if (!Object.prototype.hasOwnProperty.call(tables, table)) return fail(`table:${table}`);
      const trace: QueryTrace = { table, op: "read", filters: [] };
      let cardinality: "many" | "single" | "maybe" = "many";
      let limit = Infinity;
      let returning = false;
      let result: Result | undefined;
      const filter = (op: string, key: string, value: unknown) => {
        if (!fields.has(key)) return fail(`column:${key}`);
        trace.filters.push([op, key, value]); return query;
      };
      const mutate = (op: "update" | "insert", values: Row) => {
        if (Object.keys(values).some((key) => !mutationColumns[table]?.includes(key))) return fail(`mutation_columns:${table}`);
        trace.op = op; trace.values = values; return query;
      };
      const execute = () => {
        if (result) return result;
        queries.push(trace);
        let matches = tables[table].filter((row) => trace.filters.every(([op, key, value]) => op === "or"
          ? (value as [string, string, unknown][]).some(([branchOp, branchKey, branchValue]) => compare(row[branchKey], branchOp, branchValue))
          : compare(row[key], op, value))).slice(0, limit);
        if (trace.op === "insert") {
          const row = { ...(table === "whatsapp_inbound_events" ? { id: "queue-event" } : {}), ...trace.values };
          tables[table].push(row); matches = [row];
        }
        if (trace.op === "update") matches.forEach((row) => Object.assign(row, trace.values));
        const count = matches.length;
        const canReturn = !trace.head && (trace.op === "read" || returning);
        if (canReturn && !trace.select) return fail(`missing_projection:${table}`);
        let data: unknown = canReturn ? matches.map((row) => project(table, row, trace.select!)) : null;
        if (cardinality !== "many") {
          if (matches.length > 1 || (cardinality === "single" && matches.length !== 1)) {
            return result = { data: null, error: { code: "PGRST116", message: "fixture cardinality" } };
          }
          data = canReturn && matches.length ? project(table, matches[0], trace.select!) : null;
        }
        return result = { data, error: null, ...(trace.count ? { count } : {}) };
      };
      const query = new Proxy({
        select(columns = "*", options?: { count?: string; head?: boolean }) {
          if (!projections[table]?.includes(columns)) return fail(`projection:${table}`);
          trace.select = columns; trace.count = options?.count; trace.head = options?.head;
          returning = true; return query;
        },
        eq: (key: string, value: unknown) => filter("eq", key, value),
        is: (key: string, value: unknown) => filter("is", key, value),
        neq: (key: string, value: unknown) => filter("neq", key, value),
        in: (key: string, value: unknown[]) => filter("in", key, value),
        lte: (key: string, value: unknown) => filter("lte", key, value),
        or(expression: string) {
          const match = /^ends_at\.is\.null,ends_at\.gt\.(.+)$/.exec(expression);
          if (!match) return fail("or_expression");
          trace.filters.push(["or", "ends_at", [["is", "ends_at", null], ["gt", "ends_at", match[1]]]]); return query;
        },
        limit(value: number) { limit = value; return query; },
        update: (values: Row) => mutate("update", values),
        insert: (values: Row) => mutate("insert", values),
        single() { cardinality = "single"; return query; },
        maybeSingle() { cardinality = "maybe"; return query; },
        then<T, E>(resolve?: (result: Result) => T, reject?: (error: unknown) => E) { return Promise.resolve().then(execute).then(resolve, reject); },
      }, { get(target, key, receiver) {
        if (typeof key === "string" && !Reflect.has(target, key)) return fail(`operator:${key}`);
        return Reflect.get(target, key, receiver);
      } });
      return query;
    },
    async rpc(name: string, args: Row) {
      rpcs.push({ name, args: structuredClone(args) });
      if (!Object.prototype.hasOwnProperty.call(scripts, name)) return fail(`rpc:${name}`);
      return scripts[name](args);
    },
  };
  return { client, tables, queries, rpcs, assertNoUnexpectedIo() { expect(unexpected).toEqual([]); } };
}
function harness(db: ReturnType<typeof database>, options: Partial<Parameters<typeof createEdgeRequestHarness>[0]> = {}) {
  const fixture = createEdgeRequestHarness({ env, createClient: () => db.client, ...options });
  fixtures.push(fixture); return fixture;
}
function producerRequest(name: string, body: unknown, key = env.INTERNAL_API_KEY) {
  return new Request(`${env.SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers: { "x-internal-key": key, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const NOW = Date.UTC(2026, 9, 4, 12);
const outboxIds = { outbox: "00000000-0000-4000-8000-000000000001", reservation: "eeeeeeee-0000-4000-8000-000000000001",
  unitA: "bbbbbbbb-0000-4000-8000-000000000001", unitB: "bbbbbbbb-0000-4000-8000-000000000002" };
const SECRET = "synthetic-datafy-webhook-secret";
// Extracted 2026-10-04 from src/test/whatsapp-provider-core.test.ts:
// "normaliza todos os status ... Meta" (statuses) and "datafy: identidade e
// lote" evento() (complete envelope). Synthetic identities; no capture claim.
const receipt = { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { display_phone_number: "5511988887777", phone_number_id: "123" },
  statuses: [{ id: "wamid.3", status: "read" }],
} }] }] };
async function signedRequest(bodyText = JSON.stringify(receipt), signedText = bodyText) {
  // Actual contract from datafy-signature-core.test.ts, extracted 2026-10-04:
  // signature is sha256=<hex> over timestamp + '.' + exact raw body.
  const timestamp = String(NOW / 1000);
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${signedText}`));
  const signature = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
  return new Request(`${env.SUPABASE_URL}/functions/v1/webhook-whatsapp?channel=channel-a`, { method: "POST", body: bodyText,
    headers: { "content-type": "application/json", "x-datafy-timestamp": timestamp, "x-datafy-signature-256": `sha256=${signature}` } });
}
function receiptDb(asyncEnabled = false, flag = false, scripts: Parameters<typeof database>[1] = {}) {
  const notification = { unit_id: "unit-a", whatsapp_provider: "datafy", whatsapp_channel_id: "channel-a", provider_message_id: "wamid.3", delivered_at: null, read_at: null };
  return database({
    whatsapp_channels: [{ id: "channel-a", unit_id: "unit-a", provider: "datafy", credentials: { phone_number_id: "123" }, webhook_secret: SECRET,
      status: "connected", is_active: true, async_ingestion_enabled: asyncEnabled, template_credential_revision: 2, external_instance_id: null }],
    whatsapp_automation_adoptions: [],
    platform_flags: [{ key: "whatsapp_async_ingestion", value: flag }],
    notifications_sent: [notification, { ...notification, unit_id: "unit-b" }, { ...notification, whatsapp_channel_id: "channel-b" }, { ...notification, whatsapp_provider: "official" }, { ...notification, provider_message_id: "different-id" }],
    webhook_executions: [], whatsapp_inbound_events: [],
  }, scripts);
}

describe("actual Edge Request harness foundation", () => {
  it("runs actual internal auth before producer I/O and accepts only the configured key", async () => {
    const reads: string[] = [];
    const fixture = createEdgeRequestHarness({ env, createClient: () => ({
      from(table: string) {
        reads.push(table);
        return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
      },
    }) });
    fixtures.push(fixture);
    for (const key of [undefined, "wrong-synthetic-key"]) {
      const response = await fixture.request("send-confirmation", new Request(`${env.SUPABASE_URL}/functions/v1/send-confirmation`, {
        method: "POST", headers: key ? { "x-internal-key": key } : {}, body: JSON.stringify({ record: { id: "missing" } }),
      }));
      expect(response.status).toBe(401);
      expect(reads).toEqual([]);
    }
    const response = await fixture.request("send-confirmation", new Request(`${env.SUPABASE_URL}/functions/v1/send-confirmation`, {
      method: "POST", headers: { "x-internal-key": env.INTERNAL_API_KEY }, body: JSON.stringify({ record: { id: "missing" } }),
    }));
    expect(response.status).toBe(404);
    expect(reads).toEqual(["reservations"]);
    fixture.assertNoUnexpectedIo();
  });

  it("executes signed receipt through real parser and four-field correlation without chat effects", async () => {
    const db = receiptDb(); const fixture = harness(db, { now: NOW });
    expect((await fixture.request("webhook-whatsapp", await signedRequest())).status).toBe(200);
    expect(db.tables.notifications_sent[0]).toMatchObject({ delivered_at: new Date(NOW).toISOString(), read_at: new Date(NOW).toISOString() });
    expect(db.tables.notifications_sent.slice(1).every((row) => row.delivered_at === null && row.read_at === null)).toBe(true);
    expect(db.queries.filter((query) => query.op === "update").map((query) => query.filters.slice(0, 4))).toEqual([
      [["eq", "unit_id", "unit-a"], ["eq", "whatsapp_provider", "datafy"], ["eq", "whatsapp_channel_id", "channel-a"], ["eq", "provider_message_id", "wamid.3"]],
      [["eq", "unit_id", "unit-a"], ["eq", "whatsapp_provider", "datafy"], ["eq", "whatsapp_channel_id", "channel-a"], ["eq", "provider_message_id", "wamid.3"]],
    ]);
    expect(db.tables.webhook_executions).toHaveLength(1);
    expect(db.tables.webhook_executions[0]).toMatchObject({ outcome: "status_callback", unit_id: "unit-a", channel_id: "channel-a", meta: { statuses: ["read"], ids: ["wamid.3"] } });
    expect(db.rpcs).toEqual([]); expect(fixture.pendingBackground).toBe(0);
    expect(new Set(db.queries.map((query) => query.table))).toEqual(new Set(["whatsapp_channels", "whatsapp_automation_adoptions", "platform_flags", "notifications_sent", "webhook_executions"]));
    expect(db.queries.filter(query => query.table === "whatsapp_automation_adoptions")).toHaveLength(1);
    expect(db.rpcs).toEqual([]);
    expect([...fixture.manifest].filter((name) => name.startsWith("https:"))).toEqual(expect.arrayContaining([
      "https://deno.land/std@0.168.0/http/server.ts", "https://esm.sh/@supabase/supabase-js@2", "https://esm.sh/@anthropic-ai/sdk@0.27.3",
    ]));
    fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("refuses a single changed raw byte before domain mutation or background work", async () => {
    const db = receiptDb(true, true); const fixture = harness(db, { now: NOW });
    const original = JSON.stringify(receipt); const modified = original.replace("wamid.3", "wamid.4");
    expect((await fixture.request("webhook-whatsapp", await signedRequest(modified, original))).status).toBe(401);
    expect(db.queries.map((query) => [query.table, query.op])).toEqual([["whatsapp_channels", "read"], ["webhook_executions", "insert"]]);
    expect(db.tables.webhook_executions[0]).toMatchObject({ outcome: "webhook_unauthorized", meta: { reason: "signature_invalid" } });
    expect(db.tables.notifications_sent.every((row) => row.read_at === null)).toBe(true);
    expect(db.rpcs).toEqual([]); expect(fixture.pendingBackground).toBe(0); expect(fixture.pendingTimers).toBe(0);
    fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("keeps denied egress observable after actual email handler catches it, with redacted diagnostics", async () => {
    const db = database({ reservations: [{ id: "reservation-a", unit_id: null, date: "2026-10-05", time: "18:00", party_size: 2,
      reservation_code: "123456", customer: { name: "Synthetic", phone: "11988887777", email: "synthetic@example.invalid" }, unit: null }], notifications_sent: [] });
    const fixture = harness(db, { env: { ...env, RESEND_API_KEY: "synthetic-email-key", RESEND_FROM_EMAIL: "synthetic@example.invalid" } });
    const response = await fixture.request("send-confirmation", producerRequest("send-confirmation", { record: { id: "reservation-a" } }));
    expect(response.status, fixture.logs.join("\n")).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, email: { sent: false, skipped: false } });
    expect(db.tables.notifications_sent).toEqual([expect.objectContaining({ kind: "confirmation_email", status: "failed" })]);
    expect(() => fixture.assertNoUnexpectedIo()).toThrow("external_fetch");
    expect(fixture.logs.join(" ")).not.toContain("synthetic-email-key");
    expect(fixture.logs.join(" ")).not.toContain("api.resend.com");
    expect(fixture.pendingTimers).toBe(0); db.assertNoUnexpectedIo();
  });

  it("separates actual queued ACK from receipt work and fenced finalize I/O after drain", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const db = receiptDb(true, true, {
      claim_whatsapp_inbound_event: async (args) => {
        expect(args).toEqual({ p_event_id: "queue-event" });
        await barrier;
        return { data: [{ ...db.tables.whatsapp_inbound_events[0], attempts: 0, claim_id: "synthetic-claim" }], error: null };
      },
      finalize_whatsapp_inbound_event: (args) => ({ data: args.p_claim_id === "synthetic-claim" ? 1 : 0, error: null }),
    });
    const fixture = harness(db, { now: NOW });
    const request = await signedRequest(); const raw = await request.clone().text();
    expect((await fixture.request("webhook-whatsapp", request)).status).toBe(200);
    expect(fixture.pendingBackground).toBe(1);
    expect(db.tables.whatsapp_inbound_events).toEqual([expect.objectContaining({ id: "queue-event", unit_id: "unit-a", channel_id: "channel-a", raw_body: `\\x${Buffer.from(raw).toString("hex")}` })]);
    expect(db.tables.notifications_sent.every((row) => row.read_at === null)).toBe(true);
    expect(db.rpcs.map((rpc) => rpc.name)).toEqual(["claim_whatsapp_inbound_event"]);
    await expect(fixture.drainBackground(10)).rejects.toThrow("Background drain bound exceeded");
    release(); await fixture.drainBackground();
    expect(fixture.pendingBackground).toBe(0);
    expect(db.tables.notifications_sent[0].read_at).toBe(new Date(NOW).toISOString());
    expect(db.tables.whatsapp_inbound_events).toHaveLength(1);
    expect(db.rpcs).toEqual([
      { name: "claim_whatsapp_inbound_event", args: { p_event_id: "queue-event" } },
      { name: "finalize_whatsapp_inbound_event", args: { p_event_id: "queue-event", p_claim_id: "synthetic-claim", p_status: "done", p_outcome: "queue_processed", p_error: null, p_retry_delay_seconds: null } },
    ]);
    expect(db.tables.webhook_executions.map((row) => row.outcome)).toEqual(["queued", "status_callback"]);
    expect(db.tables.webhook_executions[1].meta).toMatchObject({ queued_event_id: "queue-event" });
    fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("observes real warm flag cache and a fresh fixture reads changed flag", async () => {
    const db = receiptDb(true, false, { claim_whatsapp_inbound_event: () => ({ data: [], error: null }) });
    const warm = harness(db, { now: NOW });
    await warm.request("webhook-whatsapp", await signedRequest());
    db.tables.platform_flags[0].value = true;
    await warm.request("webhook-whatsapp", await signedRequest());
    expect(db.queries.filter((query) => query.table === "platform_flags")).toHaveLength(1);
    expect(db.tables.whatsapp_inbound_events).toHaveLength(0);
    const fresh = harness(db, { now: NOW });
    await fresh.request("webhook-whatsapp", await signedRequest()); await fresh.drainBackground();
    expect(db.queries.filter((query) => query.table === "platform_flags")).toHaveLength(2);
    expect(db.tables.whatsapp_inbound_events).toHaveLength(1);
    warm.assertNoUnexpectedIo(); fresh.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("observes a caught background claim failure as preserved queue I/O and actual log", async () => {
    const db = receiptDb(true, true, { claim_whatsapp_inbound_event: () => ({ data: null, error: { message: "scripted claim read failure" } }) });
    const fixture = harness(db, { now: NOW });
    expect((await fixture.request("webhook-whatsapp", await signedRequest())).status).toBe(200);
    const persisted = structuredClone(db.tables.whatsapp_inbound_events);
    await fixture.drainBackground();
    expect(db.tables.whatsapp_inbound_events).toEqual(persisted);
    expect(persisted).toHaveLength(1);
    expect(db.rpcs).toEqual([{ name: "claim_whatsapp_inbound_event", args: { p_event_id: "queue-event" } }]);
    expect(db.tables.notifications_sent.every((row) => row.read_at === null)).toBe(true);
    expect(fixture.logs.map((line) => JSON.parse(line)).find((line) => line.evt === "queued_event_claim_failed"))
      .toMatchObject({ eventId: "queue-event", err: "scripted claim read failure" });
    expect(fixture.pendingBackground).toBe(0); fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("routes outbox internal hop to an actual authenticated confirmation Request", async () => {
    const db = database({ notification_outbox: [{ id: outboxIds.outbox, reservation_id: outboxIds.reservation, unit_id: outboxIds.unitB,
      kind: "confirmation", attempts: 0, status: "pending", next_attempt_at: new Date(NOW - 1).toISOString(), automation_job_id: null, automation_initial_token: null }],
      reservations: [{ id: outboxIds.reservation, unit_id: outboxIds.unitA, date: "2026-10-05", time: "18:00:00", status: "pending" }], notifications_sent: [], units: [],
      whatsapp_automation_jobs: [], whatsapp_automation_adoptions: [], whatsapp_template_bindings: [],
      platform_flags: [{ key: "whatsapp_automation_dispatch", value: false }],
    }, { recover_delegated_notification_outbox: () => ({ data: [], error: null }), mark_outbox_failed: () => ({ data: null, error: null }) });
    const fixture = harness(db, { now: NOW, internalHops: [{ from: "process-notification-outbox", to: "send-confirmation" }] });
    const response = await fixture.request("process-notification-outbox", producerRequest("process-notification-outbox", {}));
    expect(await response.json()).toMatchObject({ processed: 1, failed: 1, succeeded: 0 });
    expect(fixture.internalRequests).toHaveLength(1);
    const hop = fixture.internalRequests[0];
    expect(hop.request).toBeInstanceOf(Request);
    expect(hop.request.headers.get("x-internal-key")).toBe(env.INTERNAL_API_KEY);
    expect(await hop.request.clone().json()).toEqual({ record: { id: outboxIds.reservation, unit_id: outboxIds.unitB }, outbox_id: outboxIds.outbox });
    expect(db.rpcs).toEqual([{ name: "recover_delegated_notification_outbox", args: { p_limit: 20 } },
      { name: "mark_outbox_failed", args: { p_id: outboxIds.outbox, p_error: "http_404: {\"error\":\"Reserva não encontrada\"}" } }]);
    expect(db.queries.filter(query => ["whatsapp_automation_jobs", "whatsapp_automation_adoptions", "whatsapp_template_bindings", "platform_flags"].includes(query.table))
      .map(({ table, select, filters }) => ({ table, select, filters }))).toEqual([
      { table: "whatsapp_automation_jobs", select: "*", filters: [["eq", "unit_id", outboxIds.unitB], ["eq", "reservation_id", outboxIds.reservation], ["eq", "kind", "confirmation"]] },
      { table: "whatsapp_automation_adoptions", select: "adopted_at", filters: [["eq", "unit_id", outboxIds.unitB]] },
      { table: "platform_flags", select: "value", filters: [["eq", "key", "whatsapp_automation_dispatch"]] },
      { table: "whatsapp_template_bindings", select: "dispatch_enabled,adopted_at", filters: [["eq", "unit_id", outboxIds.unitB]] },
    ]);
    expect(db.queries.at(-1)).toMatchObject({ table: "reservations", filters: [["eq", "id", outboxIds.reservation], ["eq", "unit_id", outboxIds.unitB]] });
    expect((await fixture.request("send-confirmation", producerRequest("send-confirmation", { record: { id: outboxIds.reservation } }, "wrong"))).status).toBe(401);
    expect(fixture.pendingTimers).toBe(0); fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("gives separate endpoints separate module caches while sharing only explicit DB I/O", async () => {
    const db = database({
      units: [{ id: outboxIds.unitA, organization_id: "org-a", name: "Synthetic" }],
      organizations: [{ id: "org-a", billing_status: "blocked", whatsapp_legacy_grandfathered: false, whatsapp_grandfather_revoked_at: null }],
      organization_entitlement_overrides: [], billing_subscriptions: [],
      platform_flags: [{ key: "whatsapp_service_enforcement", value: false }, { key: "whatsapp_automation_dispatch", value: false }],
      waitlist: [{ id: outboxIds.reservation, unit_id: outboxIds.unitA, status: "waiting", customer_phone: "11988887777", customer_name: "Synthetic", party_size: 2, code: 1, created_at: new Date(NOW).toISOString() }],
      settings: [{ unit_id: outboxIds.unitA, key: "waitlist_entered_enabled", value: false }], waitlist_message_templates: [],
      notification_outbox: [{ id: outboxIds.outbox, unit_id: outboxIds.unitA, reservation_id: outboxIds.reservation, attempts: 0,
        status: "pending", kind: "confirmation", next_attempt_at: new Date(NOW - 1).toISOString(), automation_job_id: null, automation_initial_token: null }],
      whatsapp_automation_jobs: [], whatsapp_automation_adoptions: [], whatsapp_template_bindings: [],
    }, { recover_delegated_notification_outbox: () => ({ data: [], error: null }) });
    const fixture = harness(db, { now: NOW });
    const runWaitlist = () => fixture.request("process-waitlist-entered", producerRequest("process-waitlist-entered", { waitlist_id: outboxIds.reservation }));
    expect(await (await runWaitlist()).json()).toEqual({ skipped: "disabled" });
    db.tables.platform_flags[0].value = true;
    expect(await (await runWaitlist()).json()).toEqual({ skipped: "disabled" });
    expect(db.queries.filter((query) => query.table === "platform_flags" && query.filters.some(([, key, value]) => key === "key" && value === "whatsapp_service_enforcement"))).toHaveLength(1);
    expect(db.queries.filter((query) => query.table === "platform_flags" && query.filters.some(([, key, value]) => key === "key" && value === "whatsapp_automation_dispatch"))).toHaveLength(2);
    const response = await fixture.request("process-notification-outbox", producerRequest("process-notification-outbox", {}));
    expect(await response.json()).toMatchObject({ parked: 1, succeeded: 0, failed: 0 });
    expect(db.tables.notification_outbox[0]).toMatchObject({ status: "pending", last_error: "whatsapp_service_suspended" });
    expect(db.queries.filter((query) => query.table === "platform_flags" && query.filters.some(([, key, value]) => key === "key" && value === "whatsapp_service_enforcement"))).toHaveLength(2);
    expect(db.queries.filter((query) => query.table === "platform_flags")).toHaveLength(5);
    expect(db.rpcs).toEqual([{ name: "recover_delegated_notification_outbox", args: { p_limit: 20 } }]);
    fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("denies an undeclared internal hop even when its destination is an allowed Edge name", async () => {
    const db = database({ notification_outbox: [{ id: outboxIds.outbox, reservation_id: outboxIds.reservation, unit_id: outboxIds.unitA, kind: "confirmation", attempts: 0,
      status: "pending", next_attempt_at: new Date(NOW - 1).toISOString(), automation_job_id: null, automation_initial_token: null }],
      reservations: [{ id: outboxIds.reservation, unit_id: outboxIds.unitA, date: "2026-10-05", time: "18:00:00", status: "pending" }],
      notifications_sent: [], units: [],
      whatsapp_automation_jobs: [], whatsapp_automation_adoptions: [], whatsapp_template_bindings: [],
      platform_flags: [{ key: "whatsapp_automation_dispatch", value: false }],
    }, { recover_delegated_notification_outbox: () => ({ data: [], error: null }), mark_outbox_failed: () => ({ data: null, error: null }) });
    let cannedCalls = 0;
    const fixture = harness(db, { now: NOW, internalHops: [{ from: "process-waitlist-entered", to: "send-confirmation" }],
      transport: [{ method: "POST", url: `${env.SUPABASE_URL}/functions/v1/send-confirmation`, respond: () => { cannedCalls++; return Response.json({ ok: true }); } }] });
    const response = await fixture.request("process-notification-outbox", producerRequest("process-notification-outbox", {}));
    expect(await response.json()).toMatchObject({ failed: 1, succeeded: 0 });
    expect(fixture.internalRequests).toEqual([]);
    expect(db.rpcs).toEqual([{ name: "recover_delegated_notification_outbox", args: { p_limit: 20 } },
      { name: "mark_outbox_failed", args: { p_id: outboxIds.outbox, p_error: "Unexpected fixture I/O: internal_hop" } }]);
    expect(cannedCalls).toBe(0);
    expect(() => fixture.assertNoUnexpectedIo()).toThrow("internal_hop"); db.assertNoUnexpectedIo();
  });

  it("aborts scripted pending transport when actual email timeout elapses", async () => {
    const db = database({ reservations: [{ id: "reservation-a", unit_id: null, date: "2026-10-05", time: "18:00", party_size: 2,
      reservation_code: "123456", customer: { name: "Synthetic", phone: "11988887777", email: "synthetic@example.invalid" }, unit: null }], notifications_sent: [] });
    let started!: () => void; const barrier = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    const fixture = harness(db, { env: { ...env, RESEND_API_KEY: "synthetic-email-key", RESEND_FROM_EMAIL: "synthetic@example.invalid" },
      transport: [{ method: "POST", url: "https://api.resend.com/emails", respond: (request) => {
        signal = request.signal; started(); return new Promise<Response>(() => undefined);
      } }] });
    const response = fixture.request("send-confirmation", producerRequest("send-confirmation", { record: { id: "reservation-a" } }));
    await barrier; await fixture.advanceTime(14_999);
    expect(signal?.aborted).toBe(false); expect(fixture.pendingTimers).toBe(1);
    await fixture.advanceTime(1);
    expect(signal?.aborted).toBe(true);
    expect(await (await response).json()).toMatchObject({ success: false, email: { sent: false } });
    expect(db.tables.notifications_sent[0]).toMatchObject({ status: "failed", error: "Fixture transport aborted" });
    expect(fixture.pendingTimers).toBe(0); fixture.assertNoUnexpectedIo(); db.assertNoUnexpectedIo();
  });

  it("rejects unsupported constructs and escapes while allowing awaits inside functions", () => {
    expect(() => validateEdgeSource("import('https://unknown.invalid/code.ts')")).toThrow("dynamic import");
    expect(() => validateEdgeSource("await Promise.resolve()" )).toThrow("top-level await");
    expect(() => validateEdgeSource("for await (const x of xs) {}" )).toThrow("top-level await");
    expect(() => validateEdgeSource("console.log(import.meta.url)" )).toThrow("import.meta");
    expect(() => validateEdgeSource("async function f() { await Promise.resolve(); }" )).not.toThrow();
    expect(() => resolveEdgeModule("../../../package.json")).toThrow("escapes canonical source root");
    expect(() => resolveEdgeModule("../functions-evil/entry.ts")).toThrow("escapes canonical source root");
    expect(() => resolveEdgeModule("node:fs", resolveEdgeModule("send-confirmation/index.ts"))).toThrow("Unsupported runtime import");
  });

  it("mechanically surfaces uncaught background rejection through the same waitUntil collector", async () => {
    // This is a runtime-observer control, not a claimed provider/handler case.
    const fixture = harness(database({}));
    expect(typeof fixture.captureBackground).toBe("function");
    const failure = new Error("synthetic background failure");
    fixture.captureBackground(Promise.reject(failure));
    await expect(fixture.drainBackground()).rejects.toBe(failure);
    expect(fixture.pendingBackground).toBe(0);
    fixture.assertNoUnexpectedIo();
    fixture.dispose();
    await expect(fixture.request("send-confirmation", producerRequest("send-confirmation", {}))).rejects.toThrow("disposed");
  });

  it("structural I/O honors cardinality/count and zero-row update.select without SQL authority", async () => {
    const db = database({ notifications_sent: [{ id: "one", unit_id: "unit-a" }, { id: "two", unit_id: "unit-b" }] });
    expect(await db.client.from("notifications_sent").select("id", { count: "exact", head: true }).eq("unit_id", "unit-a")).toEqual({ data: null, error: null, count: 1 });
    expect(await db.client.from("notifications_sent").update({ status: "sent" }).eq("unit_id", "absent").select("id")).toEqual({ data: [], error: null });
    expect(await db.client.from("notifications_sent").select("id").single()).toMatchObject({ data: null, error: { code: "PGRST116" } });
    expect(await db.client.from("notifications_sent").select("id").eq("id", "absent").maybeSingle()).toEqual({ data: null, error: null });
    expect(() => db.client.from("unknown")).toThrow("Unexpected DB fixture I/O");
    expect(() => db.client.from("notifications_sent").select("unknown")).toThrow("projection");
    expect(() => db.client.from("notifications_sent").update({ unknown: "value" })).toThrow("mutation_columns");
    expect(() => Reflect.get(db.client.from("notifications_sent"), "unknownOperator")).toThrow("operator");
  });

  it("structural SELECT id excludes unselected authority fields for list/single/mutation results", async () => {
    const db = database({
      whatsapp_channels: [{ id: "channel-a", unit_id: "unit-a", provider: "datafy", credentials: { phone_number_id: "123" }, webhook_secret: SECRET }],
      notifications_sent: [{ id: "notification-a", unit_id: "unit-a", whatsapp_provider: "datafy", provider_message_id: "wamid.3", read_at: null }],
      whatsapp_inbound_events: [],
    });
    expect(await db.client.from("whatsapp_channels").select("id")).toEqual({ data: [{ id: "channel-a" }], error: null });
    expect(await db.client.from("whatsapp_channels").select("id").single()).toEqual({ data: { id: "channel-a" }, error: null });
    expect(await db.client.from("whatsapp_channels").select("id").maybeSingle()).toEqual({ data: { id: "channel-a" }, error: null });
    expect(await db.client.from("notifications_sent").update({ read_at: "synthetic-time" }).eq("id", "notification-a").select("id"))
      .toEqual({ data: [{ id: "notification-a" }], error: null });
    expect(await db.client.from("whatsapp_inbound_events").insert({ provider: "datafy", channel_id: "channel-a", unit_id: "unit-a", raw_body: "synthetic-raw" }).select("id").maybeSingle())
      .toEqual({ data: { id: "queue-event" }, error: null });
    expect(db.tables.whatsapp_channels[0]).toMatchObject({ unit_id: "unit-a", credentials: { phone_number_id: "123" }, webhook_secret: SECRET });
    expect(db.tables.notifications_sent[0]).toMatchObject({ unit_id: "unit-a", read_at: "synthetic-time" });
    expect(db.tables.whatsapp_inbound_events[0]).toMatchObject({ unit_id: "unit-a", raw_body: "synthetic-raw" });
    db.assertNoUnexpectedIo();
  });

  it("bounds explicit relation projections without exposing unselected nested fields", async () => {
    const db = database({
      reservations: [{ id: "reservation-a", unit_id: "unit-a", customer: { name: "Synthetic", phone: "11988887777" },
        unit: { name: "Synthetic restaurant", phone: "11988887777", organization_id: "org-a", credentials: "synthetic-related-secret" } }],
      billing_subscriptions: [{ id: "subscription-a", organization_id: "org-a", status: "active", canceled_at: null, suspended_at: null,
        billing_plans: [{ category: "SYSTEM_SUBSCRIPTION", included_features: ["whatsapp"], private_field: "synthetic-private" }] }],
    });
    expect(await db.client.from("reservations").select("*, customer:customers(*), unit:units(name, phone, instagram, website, address)").single())
      .toEqual({ data: { id: "reservation-a", unit_id: "unit-a", customer: { name: "Synthetic", phone: "11988887777" },
        unit: { name: "Synthetic restaurant", phone: "11988887777" } }, error: null });
    expect(await db.client.from("billing_subscriptions").select("id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features)"))
      .toEqual({ data: [{ id: "subscription-a", status: "active", canceled_at: null, suspended_at: null,
        billing_plans: [{ category: "SYSTEM_SUBSCRIPTION", included_features: ["whatsapp"] }] }], error: null });
    db.assertNoUnexpectedIo();
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";
import { chatSdkMessage } from "../test/fixtures/whatsapp-automation-fixtures";
import { GLOBAL_PERSONA_BASELINE } from "../../supabase/functions/_shared/agent/global-prompt-core";
import { INSTAGRAM_CHANNEL_RULES } from "../../supabase/functions/_shared/instagram-format";
import { MEDIA_REPLY_TEXT, mediaNoticeText } from "../../supabase/functions/_shared/media-reply-text";

/**
 * Request do `process-instagram-inbound` (Task 4.1) no harness, com o SDK
 * Anthropic falso e o `fetch` do Graph falso. O banco é um fake relacional em
 * memória: as RPCs reproduzem o CONTRATO observável (o que gravam e devolvem),
 * não provam lock, RLS nem ACL — isso é do pré-voo SQL 79.
 *
 * Nenhuma chamada real à Meta nem a LLM: rota não declarada é `external_fetch`
 * e falha o teste.
 */

type Row = Record<string, unknown>;

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id("aaaaaaaa", 1), ORG_B = id("aaaaaaaa", 2);
const UNIT_A = id("bbbbbbbb", 1), UNIT_B = id("bbbbbbbb", 2);
const ACC_A = id("cccccccc", 1), ACC_B = id("cccccccc", 2);
const IG_A = "17841400000000001", IG_B = "17841400000000002";
const IGSID = "6600000000000001", IGSID_B = "6600000000000002";
const EVENT_1 = id("eeeeeeee", 1), EVENT_2 = id("eeeeeeee", 2);
const TOKEN_A = "synthetic-ig-token-a";
const CONNECTED_AT = "2026-10-01T12:00:00.123456+00:00";
const RECONNECTED_AT = "2026-10-04T09:00:00.654321+00:00";
const NOW_ISO = "2026-10-05T15:00:00Z"; // segunda-feira, 12h BRT
const env = {
  SUPABASE_URL: "https://supabase.fixture.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
  INTERNAL_API_KEY: "synthetic-internal",
  APP_BASE_URL: "https://app.fixture.invalid",
};
const WORKER_URL = `${env.SUPABASE_URL}/functions/v1/process-instagram-inbound`;
const PAGE_A = "104500000000001";
const GRAPH = "https://graph.facebook.com/v26.0";
const SEND_URL_A = `${GRAPH}/${PAGE_A}/messages`;

const harnesses: { dispose(): void }[] = [];
afterEach(() => harnesses.splice(0).forEach((h) => h.dispose()));

const textMsg = (mid: string, text: string, ts = 1_000, sender = IGSID, recipient = IG_A) =>
  ({ sender: { id: sender }, recipient: { id: recipient }, timestamp: ts, message: { mid, text } });
const entry = (igId: string, ...messaging: unknown[]) => ({ id: igId, time: 1, messaging });
const igBody = (...entries: unknown[]) => ({ object: "instagram", entry: entries });
const hex = (value: unknown) => `\\x${Buffer.from(JSON.stringify(value), "utf8").toString("hex")}`;

const sdkText = (text: string) => chatSdkMessage([{ type: "text", text }]);
const sdkTool = (name: string, input: Record<string, unknown>, toolId = `tool-${name}`) =>
  chatSdkMessage([{ type: "tool_use", id: toolId, name, input }], "tool_use");

function world() {
  const tables: Record<string, Row[]> = {
    organizations: [
      { id: ORG_A, billing_status: "active", trial_ends_at: null },
      { id: ORG_B, billing_status: "active", trial_ends_at: null },
    ],
    units: [
      { id: UNIT_A, organization_id: ORG_A, name: "Loja A", slug: "loja-a", timezone: "America/Sao_Paulo", address: null, price_range_max: null },
      { id: UNIT_B, organization_id: ORG_B, name: "Loja B", slug: "loja-b", timezone: "America/Sao_Paulo", address: null, price_range_max: null },
    ],
    instagram_accounts: [
      { id: ACC_A, unit_id: UNIT_A, organization_id: ORG_A, ig_user_id: IG_A, page_id: PAGE_A, status: "connected", connected_at: CONNECTED_AT },
      { id: ACC_B, unit_id: UNIT_B, organization_id: ORG_B, ig_user_id: IG_B, status: "connected", connected_at: CONNECTED_AT },
    ],
    unit_module_grants: [
      { unit_id: UNIT_A, module: "instagram", revoked_at: null },
      { unit_id: UNIT_B, module: "instagram", revoked_at: null },
    ],
    instagram_settings: [{ unit_id: UNIT_A, dm_enabled: true }, { unit_id: UNIT_B, dm_enabled: true }],
    instagram_inbound_events: [],
    instagram_processed_messages: [],
    instagram_contacts: [],
    instagram_contact_reservations: [],
    conversations: [],
    customers: [],
    reservations: [],
    settings: [{ unit_id: UNIT_A, key: "ai_config", value: { provider: "claude" } }],
    ai_provider_credentials: [{ unit_id: UNIT_A, provider: "claude", api_key: "synthetic-byok", active: true }],
    ai_prompt_slots: [{ slot: "global_persona", active_version_id: "gp-1" }],
    ai_prompt_versions: [{ id: "gp-1", slot: "global_persona", body: GLOBAL_PERSONA_BASELINE }],
    halls: [{ id: "hall-a", unit_id: UNIT_A, name: "Salão", description: null, allow_empty_seat: true, active: true, sort_order: 1 }],
    hall_schedules: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      hall_id: "hall-a", day_of_week: d, open_time: "12:00:00", close_time: "23:00:00", is_closed: false,
      min_advance_minutes: null, discount_percent: null, charge_enabled: false, charge_amount_cents: null,
    })),
    tables: [{ id: "table-a1", hall_id: "hall-a", unit_id: UNIT_A, name: "1", min_capacity: 1, max_capacity: 4, active: true }],
  };
  const trace: { op: string; value?: unknown }[] = [];
  const graphCalls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const sdkRequests: Row[] = [];
  const controls = {
    sdk: [] as unknown[],
    /** Respostas do POST de envio, uma por chamada (padrão: sucesso). */
    send: [] as Array<{ status: number; body: unknown } | "throw">,
    profile: { status: 200, body: { name: "Ana do Insta", username: "ana.ig" } } as { status: number; body: unknown },
    beforeQuery: (_q: { table: string; op: string; columns: string; filters: unknown[][]; patch: Row | null }) => {},
    rpcError: {} as Record<string, { code: string; message?: string }>,
    reservationLimit: false,
  };
  let seq = 0;
  const newId = (p: string) => id(p, ++seq + 100);

  const matches = (row: Row, filters: unknown[][]) => filters.every(([op, col, val]) => {
    const cur = row[col as string] ?? null;
    switch (op) {
      case "eq": return cur === val;
      case "neq": return cur !== val;
      case "is": return cur === val;
      case "not.is": return cur !== val;
      case "in": return Array.isArray(val) && val.includes(cur);
      case "gt": return cur !== null && (cur as string) > (val as string);
      case "gte": return cur !== null && (cur as string) >= (val as string);
      case "lt": return cur !== null && (cur as string) < (val as string);
      case "lte": return cur !== null && (cur as string) <= (val as string);
      case "ilike": {
        const re = new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
        return typeof cur === "string" && re.test(cur);
      }
      case "or": return true;
      default: throw new Error(`filtro não suportado ${String(op)}`);
    }
  });
  const project = (row: Row, columns: string): Row => {
    if (!columns || columns.trim() === "*") return structuredClone(row);
    const out: Row = {};
    for (const raw of columns.split(/,(?![^()]*\))/)) {
      const c = raw.trim();
      if (!c || c.includes("(")) continue;
      out[c] = structuredClone(row[c] ?? null);
    }
    return out;
  };

  const db = {
    from(table: string) {
      const q = { table, op: "select", columns: "", filters: [] as unknown[][], patch: null as Row | null };
      let head = false, max = Infinity, start = 0;
      const orders: [string, boolean][] = [];
      const exec = async (single: boolean, required = false): Promise<{ data: unknown; error: unknown; count?: number }> => {
        try { controls.beforeQuery(q); } catch (e) {
          trace.push({ op: `${q.op}:${table}:error` });
          // `reject:` simula exceção (rede); o resto vira `{ error }` como o PostgREST.
          if (String((e as Error).message).startsWith("reject:")) throw e;
          return { data: null, error: { code: "08006", message: String(e) } };
        }
        trace.push({ op: `${q.op}:${table}`, value: structuredClone({ filters: q.filters, patch: q.patch }) });
        const rows = (tables[table] ??= []);
        if (q.op === "insert") {
          const row = { id: newId("dddddddd"), ...q.patch };
          rows.push(row);
          return { data: q.columns ? project(row, q.columns) : null, error: null };
        }
        let found = rows.filter((r) => matches(r, q.filters));
        found = [...found].sort((a, b) => {
          for (const [col, asc] of orders) {
            const x = a[col] as string, y = b[col] as string;
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        }).slice(start, start + max);
        if (q.op === "update") for (const r of found) Object.assign(r, q.patch);
        if (head) return { data: null, error: null, count: found.length };
        if (!q.columns) return { data: null, error: null };
        if (single) {
          if (found.length > 1 || (required && found.length !== 1)) return { data: null, error: { code: "PGRST116" } };
          return { data: found[0] ? project(found[0], q.columns) : null, error: null };
        }
        return { data: found.map((r) => project(r, q.columns)), error: null };
      };
      const f = (op: string, col: string, val: unknown) => { q.filters.push([op, col, val]); return b; };
      const b = {
        select(columns: string, opts?: { head?: boolean }) { q.columns = columns; head = opts?.head === true; return b; },
        insert(patch: Row) { q.op = "insert"; q.patch = patch; return b; },
        update(patch: Row) { q.op = "update"; q.patch = patch; return b; },
        eq: (c: string, v: unknown) => f("eq", c, v), neq: (c: string, v: unknown) => f("neq", c, v),
        is: (c: string, v: unknown) => f("is", c, v), in: (c: string, v: unknown) => f("in", c, v),
        gt: (c: string, v: unknown) => f("gt", c, v), gte: (c: string, v: unknown) => f("gte", c, v),
        lt: (c: string, v: unknown) => f("lt", c, v), lte: (c: string, v: unknown) => f("lte", c, v),
        ilike: (c: string, v: unknown) => f("ilike", c, v),
        not: (c: string, op: string, v: unknown) => f(`not.${op}`, c, v),
        or: (expr: string) => f("or", expr, null),
        order(c: string, o?: { ascending?: boolean }) { orders.push([c, o?.ascending ?? true]); return b; },
        limit(n: number) { max = n; return b; },
        range(a: number, z: number) { start = a; max = z - a + 1; return b; },
        single: () => exec(true, true), maybeSingle: () => exec(true),
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return exec(false).then(res, rej); },
      };
      return b;
    },
    async rpc(name: string, args: Row = {}) {
      trace.push({ op: `rpc:${name}`, value: structuredClone(args) });
      const forced = controls.rpcError[name];
      if (forced) return { data: null, error: forced };
      const T = tables;
      switch (name) {
        case "claim_instagram_inbound_event": {
          const e = T.instagram_inbound_events.find((r) => r.id === args.p_event_id);
          if (!e || !(e.status === "received")) return { data: [], error: null };
          Object.assign(e, { status: "processing", claim_id: newId("ffffffff") });
          return { data: [{ id: e.id, instagram_account_id: e.instagram_account_id, unit_id: e.unit_id, raw_body: e.raw_body, attempts: e.attempts, claim_id: e.claim_id }], error: null };
        }
        case "finalize_instagram_inbound_event": {
          const e = T.instagram_inbound_events.find((r) => r.id === args.p_event_id && r.claim_id === args.p_claim_id);
          if (!e) return { data: 0, error: null };
          Object.assign(e, { status: args.p_status, outcome: args.p_outcome, last_error: args.p_error, claim_id: null,
            attempts: (e.attempts as number) + (args.p_status === "received" || args.p_status === "dead" ? 1 : 0),
            retry_delay_seconds: args.p_retry_delay_seconds });
          return { data: 1, error: null };
        }
        case "select_due_instagram_inbound_events":
          return { data: T.instagram_inbound_events.filter((r) => r.status === "received").map((r) => r.id), error: null };
        case "get_instagram_account_token":
          return { data: args.p_account_id === ACC_A ? TOKEN_A : "synthetic-ig-token-b", error: null };
        case "set_instagram_account_status": {
          // CAS fiel à 20261103120800: geração ausente 22023; divergente `false` sem efeito.
          const a = T.instagram_accounts.find((r) => r.id === args.p_account_id)!;
          if (typeof args.p_expected_connected_at !== "string") return { data: null, error: { code: "22023" } };
          if (args.p_expected_connected_at !== a.connected_at) return { data: false, error: null };
          Object.assign(a, { status: args.p_status, last_error_code: args.p_error_code });
          return { data: true, error: null };
        }
        case "upsert_instagram_contact": {
          const acc = T.instagram_accounts.find((r) => r.id === args.p_account_id)!;
          let c = T.instagram_contacts.find((r) => r.instagram_account_id === acc.id && r.igsid === args.p_igsid);
          if (!c) {
            c = { id: newId("99999999"), organization_id: acc.organization_id, unit_id: acc.unit_id, instagram_account_id: acc.id,
              igsid: args.p_igsid, username: args.p_username, name: args.p_name, customer_id: null, anonymized_at: null };
            T.instagram_contacts.push(c);
          }
          return { data: c.id, error: null };
        }
        case "get_or_create_instagram_conversation": {
          const c = T.instagram_contacts.find((r) => r.id === args.p_contact_id)!;
          let cv = T.conversations.find((r) => r.instagram_contact_id === c.id);
          if (!cv) {
            cv = { id: newId("88888888"), unit_id: c.unit_id, customer_id: c.customer_id, channel: "instagram", instagram_contact_id: c.id,
              messages: [], status: "ai_active", ai_lock_token: null, handoff_reason: null, handoff_at: null, last_silenced_reply_at: null,
              contact_name: c.name ?? (c.username ? `@${c.username}` : null) };
            T.conversations.push(cv);
          }
          return { data: cv.id, error: null };
        }
        case "claim_instagram_message": {
          const acc = T.instagram_accounts.find((r) => r.id === args.p_account_id)!;
          const m = T.instagram_processed_messages.find((r) => r.instagram_account_id === acc.id && r.mid === args.p_mid);
          // Takeover só de `processing` liberado (lease vencido): o fake não tem relógio de lease.
          if (m && m.status === "processing" && m.claim_id === null) {
            m.claim_id = newId("77777777");
            return { data: m.claim_id, error: null };
          }
          if (m) return { data: null, error: null };
          const claim = newId("77777777");
          T.instagram_processed_messages.push({ instagram_account_id: acc.id, unit_id: acc.unit_id, mid: args.p_mid, status: "processing", claim_id: claim, outcome: null, meta: {} });
          return { data: claim, error: null };
        }
        case "release_instagram_message_claim": {
          // Cerca da 20261103120900: conta, mid, claim vigente e `processing`.
          const m = T.instagram_processed_messages.find((r) => r.instagram_account_id === args.p_account_id && r.mid === args.p_mid
            && r.claim_id === args.p_claim_id && r.status === "processing");
          if (!m) return { data: false, error: null };
          m.claim_id = null;
          return { data: true, error: null };
        }
        case "complete_instagram_message": {
          const m = T.instagram_processed_messages.find((r) => r.instagram_account_id === args.p_account_id && r.mid === args.p_mid
            && r.claim_id === args.p_claim_id && r.status === "processing");
          if (!m) return { data: false, error: null };
          Object.assign(m, { status: "done", outcome: args.p_outcome, error: args.p_error, meta: args.p_meta, claim_id: null });
          return { data: true, error: null };
        }
        case "record_instagram_message_outcome": {
          const acc = T.instagram_accounts.find((r) => r.id === args.p_account_id)!;
          if (!T.instagram_processed_messages.some((r) => r.instagram_account_id === acc.id && r.mid === args.p_mid)) {
            T.instagram_processed_messages.push({ instagram_account_id: acc.id, unit_id: acc.unit_id, mid: args.p_mid, status: "done", outcome: args.p_outcome, meta: args.p_meta });
          }
          return { data: null, error: null };
        }
        case "check_rate_limit": return { data: true, error: null };
        case "append_conversation_message": {
          const cv = T.conversations.find((r) => r.id === args.p_conversation_id);
          if (!cv) return { data: null, error: { code: "P0001", message: "conversation_not_found" } };
          const msg = structuredClone(args.p_message) as Row;
          const list = cv.messages as Row[];
          if (!list.some((m) => m.event_id === msg.event_id)) list.push(msg);
          return { data: null, error: null };
        }
        // Emulação das RPCs do aviso de mídia (semântica da migration 20261105120000).
        case "record_conversation_media": {
          const cv = T.conversations.find((r) => r.id === args.p_conversation_id);
          if (!cv) return { data: null, error: { code: "P0001", message: "conversation_not_found" } };
          const message = structuredClone(args.p_message) as Row;
          const messages = cv.messages as Row[];
          const eventId = typeof message.event_id === "string" ? message.event_id.trim() : "";
          if (eventId && messages.some((m) => m.event_id === eventId)) return { data: { decision: "duplicate", variant: false }, error: null };
          const now = Date.parse(NOW_ISO);
          const burst = Number(args.p_burst_seconds) * 1000;
          const grace = Number(args.p_debounce_grace_seconds) * 1000;
          const arrival = (m: Row) => Date.parse(String(m.received_at ?? m.timestamp));
          let lastReply = -1;
          messages.forEach((m, i) => { if (m.role === "assistant" || m.role === "human") lastReply = i; });
          const isText = (m: Row) => m.role === "user" && !m.media_kind;
          const unanswered = messages.slice(lastReply + 1).filter((m) => isText(m) && String(m.content ?? "").trim());
          const newest = unanswered.length ? Math.max(...unanswered.map(arrival)) : null;
          const variant = messages.some((m) => isText(m) && arrival(m) >= now - burst);
          let decision: string;
          let notice: string;
          if (!args.p_notice_allowed) { decision = "suppressed"; notice = "none"; }
          else if (newest !== null && newest >= now - burst && newest >= now - grace) { decision = "deferred"; notice = "deferred"; }
          else { decision = "notice_now"; notice = "claimed"; }
          messages.push({ ...message, media_notice: notice });
          return { data: { decision, variant }, error: null };
        }
        case "claim_conversation_media_notices": {
          const cv = T.conversations.find((r) => r.id === args.p_conversation_id);
          const since = Date.parse(String(args.p_since));
          const claimed: string[] = [];
          for (const m of (cv?.messages ?? []) as Row[]) {
            if (m.media_notice === "deferred" && Date.parse(String(m.received_at ?? m.timestamp)) >= since) {
              m.media_notice = "claimed";
              claimed.push(String(m.media_kind));
            }
          }
          return { data: claimed, error: null };
        }
        case "try_claim_conversation_for_ai": {
          const cv = T.conversations.find((r) => r.id === args.p_conv)!;
          if (cv.ai_lock_token && cv.ai_lock_token !== args.p_token) return { data: false, error: null };
          cv.ai_lock_token = args.p_token;
          return { data: true, error: null };
        }
        case "release_conversation_ai_claim": {
          const cv = T.conversations.find((r) => r.id === args.p_conv);
          if (cv && cv.ai_lock_token === args.p_token) cv.ai_lock_token = null;
          return { data: true, error: null };
        }
        case "link_instagram_contact_customer": {
          const c = T.instagram_contacts.find((r) => r.id === args.p_contact_id);
          const cu = T.customers.find((r) => r.id === args.p_customer_id);
          if (!c || !cu || cu.organization_id !== c.organization_id || cu.deleted_at) {
            return { data: null, error: { code: "42501", message: "instagram_contact_link_forbidden" } };
          }
          c.customer_id = cu.id;
          for (const cv of T.conversations.filter((r) => r.instagram_contact_id === c.id)) cv.customer_id = cu.id;
          return { data: null, error: null };
        }
        case "create_instagram_contact_reservation": {
          const c = T.instagram_contacts.find((r) => r.id === args.p_contact_id);
          const r = args.p_reservation as Row;
          if (!c || !c.customer_id || r.customer_id !== c.customer_id || r.unit_id !== c.unit_id || r.source !== "instagram") {
            return { data: null, error: { code: "42501", message: "instagram_contact_reservation_forbidden" } };
          }
          if (controls.reservationLimit) return { data: null, error: { code: "P0001", message: "instagram_contact_reservation_limit" } };
          const rid = newId("12121212");
          T.reservations.push({ id: rid, ...r, payment_status: null });
          T.instagram_contact_reservations.push({ reservation_id: rid, instagram_contact_id: c.id, unit_id: c.unit_id });
          return { data: [{ id: rid, status: r.status, payment_status: null }], error: null };
        }
        default:
          throw new Error(`rpc inesperada ${name}`);
      }
    },
  };

  const harness = createEdgeRequestHarness({
    env,
    now: Date.parse(NOW_ISO),
    createClient: () => db,
    anthropicMessagesCreate: async (input) => {
      sdkRequests.push(structuredClone(input) as Row);
      trace.push({ op: "sdk:messages.create" });
      const next = controls.sdk.shift();
      if (next === undefined) throw new Error("roteiro do SDK esgotado");
      if (next instanceof Error) throw next;
      return next;
    },
    transport: [
      {
        from: "process-instagram-inbound", method: "POST", url: SEND_URL_A,
        respond: async (request) => {
          const body = await request.json();
          graphCalls.push({ method: "POST", url: request.url, body, auth: request.headers.get("authorization") });
          trace.push({ op: "graph:send", value: body });
          const next = controls.send.shift() ?? { status: 200, body: { recipient_id: IGSID, message_id: `mid.out.${graphCalls.filter((c) => c.method === "POST").length}` } };
          if (next === "throw") throw new TypeError("rede caiu");
          return Response.json(next.body, { status: next.status });
        },
      },
      ...[IGSID, IGSID_B].map((igsid) => ({
        from: "process-instagram-inbound" as const, method: "GET", url: `${GRAPH}/${igsid}?fields=name,username`,
        respond: async (request: Request) => {
          graphCalls.push({ method: "GET", url: request.url, body: null, auth: request.headers.get("authorization") });
          trace.push({ op: "graph:profile" });
          return Response.json(controls.profile.body, { status: controls.profile.status });
        },
      })),
    ],
  });
  harnesses.push(harness);

  const enqueue = (body: unknown, opts: { eventId?: string; account?: string; unit?: string; attempts?: number } = {}) => {
    const row = { id: opts.eventId ?? EVENT_1, instagram_account_id: opts.account ?? ACC_A, unit_id: opts.unit ?? UNIT_A,
      raw_body: hex(body), status: "received", attempts: opts.attempts ?? 0, claim_id: null, outcome: null };
    tables.instagram_inbound_events.push(row);
    return row;
  };

  async function settle(pending: Promise<Response>) {
    let done = false;
    const p = pending.finally(() => { done = true; });
    const deadline = Date.now() + 20_000;
    for (let i = 0; !done && i < 400 && Date.now() < deadline;) {
      await new Promise<void>((r) => setImmediate(r));
      if (!done) {
        if (harness.pendingTimers) { await harness.advanceTime(1000); i++; }
        else await new Promise<void>((r) => setTimeout(r, 1));
      }
    }
    if (!done) throw new Error(`worker não terminou; trace: ${JSON.stringify(trace.slice(-6))}; logs: ${harness.logs.slice(-4).join(" | ")}`);
    return p;
  }

  const kick = (eventId = EVENT_1, headers: Record<string, string> = { "x-internal-key": env.INTERNAL_API_KEY }) =>
    settle(harness.request("process-instagram-inbound", new Request(WORKER_URL, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ event_id: eventId }),
    })));
  const sweep = () => settle(harness.request("process-instagram-inbound", new Request(`${WORKER_URL}?sweep=1`, {
    method: "POST", headers: { "x-internal-key": env.INTERNAL_API_KEY }, body: "{}",
  })));

  const ops = () => trace.map((t) => t.op);
  const messageOutcomes = () => Object.fromEntries(tables.instagram_processed_messages.map((m) => [m.mid, m.outcome]));
  const conversation = () => tables.conversations.find((c) => c.instagram_contact_id === tables.instagram_contacts[0]?.id);
  const systemPrompt = (i = 0) => JSON.stringify(sdkRequests[i]?.system ?? "");
  const toolNames = (i = 0) => ((sdkRequests[i]?.tools ?? []) as { name: string }[]).map((t) => t.name);
  const logEvents = () => harness.logs.map((l) => { try { return JSON.parse(l).evt as string; } catch { return l; } });

  return { tables, trace, graphCalls, sdkRequests, controls, harness, enqueue, kick, sweep, ops, messageOutcomes, conversation,
    systemPrompt, toolNames, logEvents };
}

function expectCleanIo(w: ReturnType<typeof world>) {
  expect(() => w.harness.assertNoUnexpectedIo()).not.toThrow();
}

describe("process-instagram-inbound: entrada", () => {
  it("sem x-internal-key dá 401 antes de qualquer leitura", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    const res = await w.kick(EVENT_1, {});
    expect(res.status).toBe(401);
    expect(w.trace).toEqual([]);
  });

  it("corpo sem event_id válido dá 400 sem tocar a fila", async () => {
    const w = world();
    const res = await w.kick("não-é-uuid");
    expect(res.status).toBe(400);
    expect(w.trace).toEqual([]);
  });
});

describe("process-instagram-inbound: turno do Direct", () => {
  it("DM sem telefone: a IA pede o WhatsApp", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "Quero reservar uma mesa"))));
    w.controls.sdk = [sdkText("Claro! Qual é o seu WhatsApp com DDD?")];
    const res = await w.kick();
    expect(res.status).toBe(200);
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(1);
    expect(w.systemPrompt()).toContain(JSON.stringify(INSTAGRAM_CHANNEL_RULES).slice(1, -1));
    expect(w.systemPrompt()).toContain("O cliente fala pelo Instagram (@ana.ig, Ana do Insta); o WhatsApp ainda não foi informado.");
    expect(w.toolNames().at(-1)).toBe("link_customer_phone");
    // Envio pelo Graph, com token só no header.
    expect(w.graphCalls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", url: SEND_URL_A, body: { recipient: { id: IGSID }, message: { text: "Claro! Qual é o seu WhatsApp com DDD?" } }, auth: `Bearer ${TOKEN_A}` },
    ]);
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
    const conv = w.conversation()!;
    expect(conv.unit_id).toBe(UNIT_A);
    expect((conv.messages as Row[]).map((m) => [m.role, m.content, m.provider_message_ids ?? null])).toEqual([
      ["user", "Quero reservar uma mesa", null],
      ["assistant", "Claro! Qual é o seu WhatsApp com DDD?", ["mid.out.1"]],
    ]);
    expect(conv.ai_lock_token).toBeNull();
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done", outcome: "processed" });
    expect(w.harness.logs.join("\n")).not.toContain(TOKEN_A);
    expect(w.harness.logs.join("\n")).not.toContain("Quero reservar");
  });
});

const CONTACT_A = id("99999999", 1);
const CONV_A = id("88888888", 1);
const CUSTOMER_A = id("cdcdcdcd", 1);

/** Contato já conhecido (sem chamada de perfil) e a conversa dele. */
function seedContact(w: ReturnType<typeof world>, opts: { customer?: Row | null; conv?: Row; contact?: Row } = {}) {
  if (opts.customer) w.tables.customers.push(opts.customer);
  w.tables.instagram_contacts.push({ id: CONTACT_A, organization_id: ORG_A, unit_id: UNIT_A, instagram_account_id: ACC_A,
    igsid: IGSID, username: "ana.ig", name: "Ana do Insta", customer_id: opts.customer ? opts.customer.id : null, anonymized_at: null,
    link_changes_count: 0, link_changes_window_started_at: null, ...opts.contact });
  w.tables.conversations.push({ id: CONV_A, unit_id: UNIT_A, customer_id: opts.customer ? opts.customer.id : null, channel: "instagram",
    instagram_contact_id: CONTACT_A, messages: [], status: "ai_active", ai_lock_token: null, handoff_reason: null, handoff_at: null,
    last_silenced_reply_at: null, ...opts.conv });
}

const LINKED_CUSTOMER = { id: CUSTOMER_A, organization_id: ORG_A, name: "Fulana Cadastrada", phone: "11988887777", email: "fulana@exemplo.invalid",
  emails: ["fulana@exemplo.invalid"], birthday: "1990-10-08", allergies: "ALERGIA_A_CAMARAO", dietary_restrictions: "SEM_LACTOSE_PRIVADO",
  vip_notes: "VIP_NOTA_PRIVADA", preferred_table_location: "MESA_JANELA_PRIVADA", deleted_at: null };

describe("process-instagram-inbound: identidade declarada", () => {
  it("DM com telefone: link → reserva instagram (ledger pela RPC atômica e customer_id na conversa)", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "Sou a Ana, 11 98888-7777. Mesa pra 2 quarta 20h"))));
    w.controls.sdk = [
      sdkTool("link_customer_phone", { phone: "(11) 98888-7777", name: "Ana <script>‮Silva" }),
      sdkTool("create_reservation", { customer_name: "Ana", customer_email: "atacante@exemplo.invalid", date: "2026-10-07", time: "20:00", party_size: 2 }),
      sdkText("Reserva feita! Te mando a confirmação pelo WhatsApp."),
    ];
    const res = await w.kick();
    expect(res.status).toBe(200);
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(3);
    // Cadastro novo: nome limpo pela allowlist, sem e-mail; telefone canônico.
    expect(w.tables.customers).toHaveLength(1);
    expect(w.tables.customers[0]).toMatchObject({ organization_id: ORG_A, phone: "11988887777", name: "Ana scriptSilva", email: null, emails: [] });
    const customerId = w.tables.customers[0].id;
    // Reserva pela RPC atômica: source instagram, cliente ligado, ledger junto.
    const create = w.trace.filter((t) => t.op === "rpc:create_instagram_contact_reservation");
    expect(create).toHaveLength(1);
    expect((create[0].value as Row).p_reservation).toMatchObject({ source: "instagram", customer_id: customerId, unit_id: UNIT_A, status: "confirmed" });
    expect(w.tables.reservations).toHaveLength(1);
    expect(w.tables.reservations[0]).toMatchObject({ source: "instagram", customer_id: customerId, unit_id: UNIT_A, date: "2026-10-07" });
    expect(w.tables.instagram_contact_reservations).toEqual([
      { reservation_id: w.tables.reservations[0].id, instagram_contact_id: w.tables.instagram_contacts[0].id, unit_id: UNIT_A },
    ]);
    expect(w.trace.some((t) => t.op === "insert:reservations"), "INSERT direto em reservations").toBe(false);
    expect(w.conversation()!.customer_id).toBe(customerId);
    expect(JSON.stringify(w.tables)).not.toContain("atacante@exemplo.invalid");
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
  });

  it("link para cadastro existente não sobrescreve nome nem grava e-mail; telefone inválido não liga", async () => {
    const w = world();
    w.tables.customers.push({ ...LINKED_CUSTOMER });
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "meu zap"))));
    w.controls.sdk = [
      sdkTool("link_customer_phone", { phone: "123", name: "Outro Nome" }, "t1"),
      sdkTool("link_customer_phone", { phone: "+55 11 98888-7777", name: "Outro Nome" }, "t2"),
      sdkText("Anotado!"),
    ];
    await w.kick();
    expectCleanIo(w);
    expect(JSON.stringify(w.sdkRequests[1])).toContain("invalid_phone");
    expect(w.tables.customers).toHaveLength(1);
    expect(w.tables.customers[0]).toMatchObject({ name: "Fulana Cadastrada", email: "fulana@exemplo.invalid", emails: ["fulana@exemplo.invalid"] });
    expect(w.trace.filter((t) => t.op === "rpc:link_instagram_contact_customer")).toHaveLength(1);
    expect(w.tables.instagram_contacts[0].customer_id).toBe(CUSTOMER_A);
    // O que volta ao LLM não revela o cadastro.
    expect(JSON.stringify(w.sdkRequests[2])).not.toContain("Fulana");
  });

  it("recusa do link (teto de trocas) vira unavailable, sem revelar o motivo", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "meu zap 11988887777"))));
    w.controls.rpcError.link_instagram_contact_customer = { code: "P0001", message: "instagram_contact_link_limit" };
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "11988887777", name: "Ana" }), sdkText("Tente mais tarde.")];
    await w.kick();
    expectCleanIo(w);
    const toolResult = JSON.stringify(w.sdkRequests[1]);
    expect(toolResult).toContain("unavailable");
    expect(toolResult).not.toContain("link_limit");
    expect(w.tables.instagram_contacts[0].customer_id).toBeNull();
  });

  it("teto de reservas ativas: mensagem própria ao LLM (R4-h), nada criado", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER } });
    w.controls.reservationLimit = true;
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "mais uma mesa"))));
    w.controls.sdk = [
      sdkTool("create_reservation", { customer_name: "Ana", date: "2026-10-07", time: "20:00", party_size: 2 }),
      sdkText("Você já tem o máximo de reservas."),
    ];
    await w.kick();
    expectCleanIo(w);
    expect(JSON.stringify(w.sdkRequests[1])).toContain("Este contato já tem o número máximo de reservas ativas. Ofereça alterar ou cancelar uma reserva existente.");
    expect(w.tables.reservations).toEqual([]);
    expect(w.tables.instagram_contact_reservations).toEqual([]);
  });

  it("contato ligado a cliente com vouchers e alergias: o prompt não os contém", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER } });
    w.tables.voucher_rules = [{ id: "rule-b", unit_id: UNIT_A, trigger_type: "birthday", discount_percent: 10, validity_days: 7, active: true, created_at: "2026-09-01T00:00:00Z" }];
    w.tables.vouchers = [{ id: "v1", unit_id: UNIT_A, customer_id: CUSTOMER_A, rule_id: "rule-b", code: "VOUCHER_SECRETO10", discount_percent: 10,
      status: "active", issued_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-31T23:59:59Z" }];
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Oi! Como posso ajudar?")];
    await w.kick();
    expectCleanIo(w);
    const prompt = JSON.stringify(w.sdkRequests[0]);
    for (const secret of ["VOUCHER_SECRETO10", "ALERGIA_A_CAMARAO", "SEM_LACTOSE_PRIVADO", "VIP_NOTA_PRIVADA", "MESA_JANELA_PRIVADA", "Fulana", "fulana@", "1990-10-08"]) {
      expect(prompt, secret).not.toContain(secret);
    }
    expect(w.systemPrompt()).toContain("o WhatsApp informado é (11) 98888-7777.");
  });

  it("identityLine remontada a cada turno: turno 1 sem telefone, link, turno 2 com o telefone ligado", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "meu zap é 11988887777", 1_000))));
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "11988887777", name: "Ana" }), sdkText("Anotado!")];
    await w.kick();
    w.enqueue(igBody(entry(IG_A, textMsg("m2", "quero reservar", 2_000))), { eventId: EVENT_2 });
    w.controls.sdk = [sdkText("Para quando?")];
    await w.kick(EVENT_2);
    expectCleanIo(w);
    expect(w.systemPrompt(0)).toContain("o WhatsApp ainda não foi informado.");
    expect(w.systemPrompt(2)).toContain("o WhatsApp informado é (11) 98888-7777.");
    expect(w.messageOutcomes()).toEqual({ m1: "success", m2: "success" });
  });
});

describe("process-instagram-inbound: teto de trocas antes de criar cadastro (R4-l)", () => {
  const capped = { link_changes_count: 3, link_changes_window_started_at: "2026-10-04T15:00:00Z" };

  it("contato no teto declarando telefone novo: unavailable e zero inserts em customers", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER }, contact: capped });
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "agora é 21 99999-8888"))));
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "21999998888", name: "Terceiro" }), sdkText("Não consegui registrar.")];
    await w.kick();
    expectCleanIo(w);
    expect(w.ops().filter((o) => o === "insert:customers")).toEqual([]);
    expect(w.tables.customers).toHaveLength(1);
    expect(w.ops()).not.toContain("rpc:link_instagram_contact_customer");
    expect(JSON.stringify(w.sdkRequests[1])).toContain("unavailable");
    expect(w.tables.instagram_contacts[0].customer_id).toBe(CUSTOMER_A);
  });

  it("no teto, religar o MESMO telefone segue (não é troca)", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER }, contact: capped });
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "meu zap 11988887777"))));
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "(11) 98888-7777", name: "Ana" }), sdkText("Ok!")];
    await w.kick();
    expectCleanIo(w);
    expect(w.ops().filter((o) => o === "insert:customers")).toEqual([]);
    expect(w.ops()).toContain("rpc:link_instagram_contact_customer");
    expect(JSON.stringify(w.sdkRequests[1])).toContain("Número registrado.");
  });

  it("janela vencida: o teto zera e o telefone novo liga", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER }, contact: { link_changes_count: 3, link_changes_window_started_at: "2026-09-01T00:00:00Z" } });
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "agora é 21 99999-8888"))));
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "21999998888", name: "Ana" }), sdkText("Ok!")];
    await w.kick();
    expectCleanIo(w);
    expect(w.ops().filter((o) => o === "insert:customers")).toHaveLength(1);
    expect(w.tables.instagram_contacts[0].customer_id).not.toBe(CUSTOMER_A);
  });

  it("erro na releitura do contato: unavailable sem escrita", async () => {
    const w = world();
    seedContact(w, { customer: { ...LINKED_CUSTOMER } });
    w.controls.beforeQuery = (q) => {
      if (q.table === "instagram_contacts" && q.columns === "customer_id, link_changes_count, link_changes_window_started_at") throw new Error("db down");
    };
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "agora é 21 99999-8888"))));
    w.controls.sdk = [sdkTool("link_customer_phone", { phone: "21999998888", name: "Ana" }), sdkText("Tente depois.")];
    await w.kick();
    expectCleanIo(w);
    expect(w.ops()).not.toContain("insert:customers");
    expect(w.ops()).not.toContain("rpc:link_instagram_contact_customer");
    expect(JSON.stringify(w.sdkRequests[1])).toContain("unavailable");
  });
});

describe("process-instagram-inbound: tenant, dedupe e gates", () => {
  it("M-3: a conversa é lida com o filtro de unidade na própria query", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    const read = w.trace.find((t) => t.op === "select:conversations"
      && (t.value as { filters: unknown[][] }).filters.some(([op, col]) => op === "eq" && col === "id"));
    expect((read!.value as { filters: unknown[][] }).filters).toContainEqual(["eq", "unit_id", UNIT_A]);
  });

  it("worker ignora entradas de outra conta (outra organização) no mesmo corpo", async () => {
    const w = world();
    w.enqueue(igBody(
      entry(IG_B, textMsg("m-b", "sou da loja B", 500, IGSID_B, IG_B)),
      entry(IG_A, textMsg("m-a", "sou da loja A", 1_000)),
    ));
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(1);
    expect(JSON.stringify(w.sdkRequests[0])).not.toContain("sou da loja B");
    expect(w.tables.instagram_contacts.map((c) => [c.instagram_account_id, c.unit_id, c.igsid])).toEqual([[ACC_A, UNIT_A, IGSID]]);
    expect(w.tables.conversations.every((c) => c.unit_id === UNIT_A)).toBe(true);
    expect(w.tables.instagram_processed_messages.map((m) => [m.mid, m.unit_id])).toEqual([["m-a", UNIT_A]]);
    expect(w.tables.instagram_contact_reservations).toEqual([]);
    expect(w.graphCalls.some((c) => c.url.includes(IGSID_B))).toBe(false);
    expect(JSON.stringify(w.tables.conversations)).not.toContain("sou da loja B");
  });

  it("mesmo mid em dois corpos diferentes roda um turno", async () => {
    const w = world();
    w.enqueue({ ...igBody(entry(IG_A, textMsg("m1", "oi"))), extra: 1 });
    w.enqueue({ ...igBody(entry(IG_A, textMsg("m1", "oi"))), extra: 2 }, { eventId: EVENT_2 });
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick(EVENT_1);
    await w.kick(EVENT_2);
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(1);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(w.tables.instagram_inbound_events.map((e) => [e.status, e.outcome])).toEqual([["done", "processed"], ["done", "processed"]]);
  });

  for (const [nome, apply, outcome] of [
    ["grant revogado", (w: ReturnType<typeof world>) => { w.tables.unit_module_grants[0].revoked_at = "2026-10-05T14:00:00Z"; }, "discarded_no_grant"],
    ["Direct desligado", (w: ReturnType<typeof world>) => { w.tables.instagram_settings[0].dm_enabled = false; }, "discarded_dm_disabled"],
    ["conta em reauth_required", (w: ReturnType<typeof world>) => { w.tables.instagram_accounts[0].status = "reauth_required"; }, "discarded_account_not_connected"],
  ] as const) {
    it(`revogação depois do ACK descarta sem LLM: ${nome}`, async () => {
      const w = world();
      w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
      apply(w);
      await w.kick();
      expectCleanIo(w);
      expect(w.sdkRequests).toHaveLength(0);
      expect(w.graphCalls).toHaveLength(0);
      expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done", outcome });
      expect(w.tables.instagram_processed_messages).toEqual([]);
      expect(w.tables.instagram_contacts).toEqual([]);
    });
  }

  it("erro de leitura do grant reagenda pela escada (sem LLM)", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.beforeQuery = (q) => { if (q.table === "unit_module_grants") throw new Error("db down"); };
    await w.kick();
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "received", outcome: "grant_read_failed", attempts: 1, retry_delay_seconds: 30 });
  });

  it("attempts estourado fecha como dead logo depois do claim", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))), { attempts: 3 });
    await w.kick();
    expect(w.ops().filter((o) => !o.startsWith("rpc:"))).toEqual([]);
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "dead", outcome: "attempts_exhausted" });
    expect(w.logEvents()).toContain("instagram_inbound_dead_letter");
  });

  it("org bloqueada dá org_billing_blocked, sem LLM e sem envio, com o inbound no histórico", async () => {
    const w = world();
    w.tables.organizations[0].billing_status = "blocked";
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ m1: "org_billing_blocked" });
    expect((w.conversation()!.messages as Row[]).map((m) => m.content)).toEqual(["oi"]);
  });

  it("billing ilegível NÃO bloqueia (mesma polaridade aberta do WhatsApp)", async () => {
    const w = world();
    w.controls.beforeQuery = (q) => { if (q.table === "organizations" && q.columns === "billing_status") throw new Error("db down"); };
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
  });

  it("invalid_channel_context é terminal com alerta: sem LLM, mensagem completada, evento finalizado", async () => {
    const w = world();
    // Dado corrompido: organização vazia na conta e na unidade.
    w.tables.instagram_accounts[0].organization_id = "";
    w.tables.units[0].organization_id = "";
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ m1: "invalid_channel_context" });
    expect(w.logEvents()).toContain("instagram_agent_context_invalid_alert");
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done", outcome: "processed" });
  });

  it("conversa de outra unidade: terminal com alerta, sem LLM", async () => {
    const w = world();
    seedContact(w, { conv: { unit_id: UNIT_B } });
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ m1: "conversation_tenant_mismatch" });
    expect(w.logEvents()).toContain("instagram_conversation_tenant_mismatch_alert");
  });
});

describe("process-instagram-inbound: eco, mídia e story", () => {
  it("eco dá echo_own ou echo_unknown, sem append", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    const before = structuredClone(w.conversation()!.messages);
    const echo = (mid: string, ts: number) => ({ sender: { id: IG_A }, recipient: { id: IGSID }, timestamp: ts, message: { mid, text: "x", is_echo: true } });
    w.enqueue(igBody(entry(IG_A, echo("mid.out.1", 2_000), echo("mid.alheio", 3_000))), { eventId: EVENT_2 });
    await w.kick(EVENT_2);
    expectCleanIo(w);
    expect(w.messageOutcomes()).toMatchObject({ "mid.out.1": "echo_own", "mid.alheio": "echo_unknown" });
    expect(w.conversation()!.messages).toEqual(before);
    expect(w.sdkRequests).toHaveLength(1);
  });

  it("story_mention é ignorado; mídia recebe MEDIA_REPLY_TEXT", async () => {
    const w = world();
    const att = (mid: string, type: string, ts: number) => ({ sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: ts,
      message: { mid, attachments: [{ type, payload: { url: "https://cdn.invalid/x" } }] } });
    w.enqueue(igBody(entry(IG_A, att("story", "story_mention", 1_000), att("img", "image", 2_000))));
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ story: "ignored_story_mention", img: "media_response" });
    expect(w.graphCalls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ recipient: { id: IGSID }, message: { text: MEDIA_REPLY_TEXT } }]);
    expect((w.conversation()!.messages as Row[]).map((m) => [m.role, m.content, m.provider_message_ids ?? null])).toEqual([
      ["user", "[mídia]", null], ["assistant", MEDIA_REPLY_TEXT, ["mid.out.1"]],
    ]);
  });

  it("mídia grava media_kind no histórico", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 2_000, message: { mid: "img", attachments: [{ type: "image" }] } })));
    await w.kick();
    expect((w.conversation()!.messages as Row[])[0]).toMatchObject({ role: "user", content: "[mídia]", media_kind: "media", author: "customer" });
  });

  it("mídia com texto da rajada sem resposta: aviso adiado, sem envio", async () => {
    const w = world();
    seedContact(w, { conv: { messages: [{ event_id: "t0", role: "user", content: "oi", timestamp: NOW_ISO, received_at: NOW_ISO, author: "customer" }] } });
    w.enqueue(igBody(entry(IG_A, { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 2_000, message: { mid: "img", attachments: [{ type: "image" }] } })));
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ img: "media_notice_deferred" });
  });

  it("notice_now com variante: envia mediaNoticeText(['media'])", async () => {
    const w = world();
    seedContact(w, { conv: { messages: [
      { event_id: "t0", role: "user", content: "oi", timestamp: NOW_ISO, received_at: NOW_ISO, author: "customer" },
      { event_id: "a0", role: "assistant", content: "Olá!", timestamp: NOW_ISO, author: "automation" },
    ] } });
    w.enqueue(igBody(entry(IG_A, { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 2_000, message: { mid: "img", attachments: [{ type: "image" }] } })));
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { recipient: { id: IGSID }, message: { text: mediaNoticeText(["media"]) } },
    ]);
    expect(w.messageOutcomes()).toEqual({ img: "media_response" });
    expect((w.conversation()!.messages as Row[]).at(-1)).toMatchObject({ role: "assistant", content: mediaNoticeText(["media"]) });
  });

  it("mesma entrega: texto responde e a mídia avisa 'seu arquivo' depois da resposta", async () => {
    const w = world();
    w.controls.sdk = [sdkText("Oi! Como posso ajudar?")];
    w.enqueue(igBody(entry(IG_A,
      textMsg("m1", "Oi", 1_000),
      { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 2_000, message: { mid: "img", attachments: [{ type: "image" }] } },
    )));
    await w.kick();
    expectCleanIo(w);
    expect(w.messageOutcomes()).toEqual({ m1: "success", img: "media_response" });
    expect(w.graphCalls.filter((c) => c.method === "POST").map((c) => (c.body as { message: { text: string } }).message.text)).toEqual([
      "Oi! Como posso ajudar?", mediaNoticeText(["media"]),
    ]);
    expect(mediaNoticeText(["media"])).toContain("seu arquivo");
  });

  it("mídia repetida (mesmo event_id na conversa): duplicate, sem envio", async () => {
    const w = world();
    seedContact(w, { conv: { messages: [{ event_id: `ig-in:${ACC_A}:img`, role: "user", content: "[mídia]", timestamp: NOW_ISO, author: "customer", media_kind: "media" }] } });
    w.enqueue(igBody(entry(IG_A, { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 2_000, message: { mid: "img", attachments: [{ type: "image" }] } })));
    await w.kick();
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ img: "duplicate" });
  });

  it("mídia durante handoff humano: registra e não responde", async () => {
    const w = world();
    seedContact(w, { conv: { status: "human_active", handoff_at: "2026-10-05T14:00:00Z" } });
    w.enqueue(igBody(entry(IG_A, { sender: { id: IGSID }, recipient: { id: IG_A }, timestamp: 1, message: { mid: "img", attachments: [{ type: "image" }] } })));
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ img: "media_during_handoff" });
  });
});

describe("process-instagram-inbound: envio", () => {
  const LONG = "a".repeat(900) + "\n\n" + "b".repeat(598);

  it("resposta de 1500 bytes sai em duas mensagens, com os dois messageId no histórico", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "me conta tudo"))));
    w.controls.sdk = [sdkText(LONG)];
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST").map((c) => (c.body as { message: { text: string } }).message.text))
      .toEqual(["a".repeat(900), "b".repeat(598)]);
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
    expect((w.conversation()!.messages as Row[]).at(-1)!.provider_message_ids).toEqual(["mid.out.1", "mid.out.2"]);
  });

  it("falha na segunda parte dá send_error, sem append da resposta", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "me conta tudo"))));
    w.controls.sdk = [sdkText(LONG)];
    w.controls.send = [{ status: 200, body: { message_id: "mid.out.1" } }, { status: 400, body: { error: { code: 100 } } }];
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(w.messageOutcomes()).toEqual({ m1: "send_error" });
    expect((w.conversation()!.messages as Row[]).map((m) => m.role)).toEqual(["user"]);
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done" });
    // M-1: a parte que saiu fica rastreável no meta do desfecho, sem conteúdo.
    const meta = w.tables.instagram_processed_messages[0].meta as Row;
    expect(meta.sent_message_ids).toEqual(["mid.out.1"]);
    expect(JSON.stringify(meta)).not.toContain("aaaa");
  });

  it("controle M-1: envio completo não leva sent_message_ids no meta", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    expect(w.tables.instagram_processed_messages[0].meta as Row).not.toHaveProperty("sent_message_ids");
  });

  for (const [nome, pageId] of [["nulo", null], ["não numérico", "12ab"]] as const) {
    it(`page_id ${nome}: marca reauth_required (page_missing), sem Graph, e finaliza o evento`, async () => {
      const w = world();
      w.tables.instagram_accounts[0].page_id = pageId;
      w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
      await w.kick();
      expectCleanIo(w);
      expect(w.graphCalls).toHaveLength(0);
      expect(w.sdkRequests).toHaveLength(0);
      expect(w.trace.find((t) => t.op === "rpc:set_instagram_account_status")?.value)
        .toEqual({ p_account_id: ACC_A, p_status: "reauth_required", p_error_code: "page_missing", p_expected_connected_at: CONNECTED_AT });
      expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done", outcome: "discarded_page_missing" });
      expect(w.harness.logs.join(" | ")).toContain("instagram_account_page_missing");
    });
  }

  it("erro 190 no envio marca reauth_required", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    w.controls.send = [{ status: 400, body: { error: { code: 190, message: "token vencido" } } }];
    await w.kick();
    expectCleanIo(w);
    expect(w.tables.instagram_accounts[0]).toMatchObject({ status: "reauth_required", last_error_code: "190" });
    expect(w.messageOutcomes()).toEqual({ m1: "send_error" });
    expect(w.harness.logs.join("\n")).not.toContain("token vencido");
    const mark = w.trace.find((t) => t.op === "rpc:set_instagram_account_status");
    expect(mark?.value).toEqual({ p_account_id: ACC_A, p_status: "reauth_required", p_error_code: "190", p_expected_connected_at: CONNECTED_AT });
  });

  it("erro 190 depois de uma reconexão no meio do turno: CAS recusa, a conexão nova segue connected", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    w.controls.send = [{ status: 400, body: { error: { code: 190, message: "token vencido" } } }];
    // O dono reconecta depois da leitura dos gates (a conta lida fica com o connected_at antigo).
    let reconnected = false;
    w.controls.beforeQuery = (q) => {
      if (!reconnected && q.table === "instagram_contacts") {
        reconnected = true;
        w.tables.instagram_accounts[0].connected_at = RECONNECTED_AT;
      }
    };
    await w.kick();
    expectCleanIo(w);
    expect(reconnected).toBe(true);
    expect(w.tables.instagram_accounts[0]).toMatchObject({ status: "connected", connected_at: RECONNECTED_AT });
    expect(w.trace.find((t) => t.op === "rpc:set_instagram_account_status")?.value)
      .toMatchObject({ p_expected_connected_at: CONNECTED_AT });
    expect(w.harness.logs.join("\n")).toContain("instagram_account_reauth_stale");
    expect(w.messageOutcomes()).toEqual({ m1: "send_error" });
  });

  it("send nunca lança: fetch que lança termina o turno como desfecho desconhecido, sem exceção escapando", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    w.controls.send = ["throw"];
    const res = await w.kick();
    expect(res.status).toBe(200);
    expectCleanIo(w);
    expect(w.messageOutcomes()).toEqual({ m1: "send_outcome_unknown" });
    expect(w.tables.instagram_processed_messages[0].error).toBe("provider_timeout");
    expect(w.logEvents()).not.toContain("instagram_turn_error");
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done", outcome: "processed" });
  });
});

describe("process-instagram-inbound: handoff", () => {
  const OLD = "2026-10-04T15:00:00Z"; // 24h antes: auto-resolve
  const RECENT = "2026-10-05T14:00:00Z"; // 1h antes: lembrete

  it("handoff_state_changed sem envio: a conversa vira humano no meio do turno → zero POST", async () => {
    const w = world();
    seedContact(w, { conv: { status: "human_active", handoff_at: OLD } });
    w.controls.beforeQuery = (q) => {
      if (q.table === "conversations" && q.op === "update" && q.patch?.status === "ai_active") {
        w.tables.conversations[0].status = "awaiting_human";
      }
    };
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.sdkRequests).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ m1: "handoff_state_changed" });
  });

  it("lembrete com desfecho desconhecido (provider_timeout) NÃO devolve a janela", async () => {
    const w = world();
    seedContact(w, { conv: { status: "human_active", handoff_at: RECENT } });
    w.controls.send = ["throw"];
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "alguém aí?"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(w.tables.conversations[0].last_silenced_reply_at).not.toBeNull();
    expect(w.logEvents()).toContain("handoff_reminder_outcome_unknown");
    expect(w.messageOutcomes()).toEqual({ m1: "human_active_reminded" });
  });

  it("controle: lembrete com falha definitiva (400) devolve a janela", async () => {
    const w = world();
    seedContact(w, { conv: { status: "human_active", handoff_at: RECENT } });
    w.controls.send = [{ status: 400, body: { error: { code: 100 } } }];
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "alguém aí?"))));
    await w.kick();
    expectCleanIo(w);
    expect(w.tables.conversations[0].last_silenced_reply_at).toBeNull();
  });
});

describe("process-instagram-inbound: catch do turno", () => {
  it("turno que lança depois do lock: liquida, solta o lock e só então completa a mensagem e fecha o evento", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    // A cerca do envio (depois do LLM, efeito externo já marcado) falha.
    w.controls.beforeQuery = (q) => {
      if (q.table === "conversations" && q.op === "select" && q.columns === "status, ai_lock_token") throw new Error("db down");
    };
    const res = await w.kick();
    expect(res.status).toBe(200);
    expectCleanIo(w);
    const ops = w.ops();
    const iLock = ops.indexOf("rpc:try_claim_conversation_for_ai");
    const iRelease = ops.indexOf("rpc:release_conversation_ai_claim");
    const iComplete = ops.indexOf("rpc:complete_instagram_message");
    const iFinalize = ops.indexOf("rpc:finalize_instagram_inbound_event");
    expect(iLock).toBeGreaterThan(-1);
    expect(iRelease, "o lock não foi solto").toBeGreaterThan(iLock);
    expect(iComplete, "completou a mensagem antes de soltar o lock").toBeGreaterThan(iRelease);
    expect(iFinalize, "fechou o evento antes de completar a mensagem").toBeGreaterThan(iComplete);
    expect(w.graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(w.messageOutcomes()).toEqual({ m1: "webhook_error" });
    expect(w.conversation()!.ai_lock_token).toBeNull();
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done" });
  });

  it("turno que lança depois do lock e ANTES de efeito externo: solta o lock, a mensagem fica para a nova tentativa", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    // `menus` só é lido na carga do prompt: depois do lock, antes do LLM.
    w.controls.beforeQuery = (q) => { if (q.table === "menus") throw new Error("reject: db down"); };
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(0);
    const ops = w.ops();
    expect(ops.indexOf("rpc:release_conversation_ai_claim")).toBeGreaterThan(ops.indexOf("rpc:try_claim_conversation_for_ai"));
    expect(ops).not.toContain("rpc:complete_instagram_message");
    expect(w.tables.instagram_processed_messages[0]).toMatchObject({ mid: "m1", status: "processing" });
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "received", outcome: "item_retry", attempts: 1 });
    // R4-k: o claim é liberado com a MESMA cerca do claim, depois de soltar o lock
    // e antes de fechar o evento — a nova tentativa não espera o lease de 90 s.
    const releaseArgs = w.trace.find((t) => t.op === "rpc:release_instagram_message_claim")?.value as Record<string, unknown> | undefined;
    expect(releaseArgs).toMatchObject({ p_account_id: ACC_A, p_mid: "m1" });
    expect(typeof releaseArgs?.p_claim_id).toBe("string");
    const iUnlock = ops.indexOf("rpc:release_conversation_ai_claim");
    const iRelease = ops.indexOf("rpc:release_instagram_message_claim");
    const iFinalize = ops.indexOf("rpc:finalize_instagram_inbound_event");
    expect(iRelease, "não liberou o claim da mensagem").toBeGreaterThan(iUnlock);
    expect(iFinalize, "fechou o evento antes de liberar o claim").toBeGreaterThan(iRelease);
    expect(w.tables.instagram_processed_messages[0]).toMatchObject({ claim_id: null });

    // Nova tentativa: o claim liberado é reassumido na hora e o turno roda.
    w.controls.beforeQuery = () => {};
    w.controls.sdk = [sdkText("Olá!")];
    await w.kick();
    expectCleanIo(w);
    expect(w.sdkRequests).toHaveLength(1);
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "done" });
  });

  it("efeito externo já feito: o claim NÃO é liberado (a mensagem fecha webhook_error)", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    w.controls.beforeQuery = (q) => {
      if (q.table === "conversations" && q.op === "select" && q.columns === "status, ai_lock_token") throw new Error("db down");
    };
    await w.kick();
    expect(w.ops()).not.toContain("rpc:release_instagram_message_claim");
    expect(w.messageOutcomes()).toEqual({ m1: "webhook_error" });
  });

  it("falha na liberação do claim não muda o desfecho: o evento reagenda e o lease cobre", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.beforeQuery = (q) => { if (q.table === "menus") throw new Error("reject: db down"); };
    w.controls.rpcError.release_instagram_message_claim = { code: "08006", message: "synthetic" };
    await w.kick();
    expectCleanIo(w);
    expect(w.ops()).toContain("rpc:release_instagram_message_claim");
    expect(w.tables.instagram_processed_messages[0]).toMatchObject({ mid: "m1", status: "processing" });
    expect(w.tables.instagram_processed_messages[0].claim_id).not.toBeNull();
    expect(w.tables.instagram_inbound_events[0]).toMatchObject({ status: "received", outcome: "item_retry", attempts: 1 });
    expect(w.harness.logs.join("\n")).toContain("instagram_message_claim_release_failed");
  });
});

describe("process-instagram-inbound: varredura", () => {
  it("?sweep=1 lê só a tabela e processa as linhas devidas", async () => {
    const w = world();
    w.enqueue(igBody(entry(IG_A, textMsg("m1", "oi"))));
    w.controls.sdk = [sdkText("Olá!")];
    const res = await w.sweep();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ selected: 1, processed: 1, skipped: 0 });
    expect(w.messageOutcomes()).toEqual({ m1: "success" });
  });
});

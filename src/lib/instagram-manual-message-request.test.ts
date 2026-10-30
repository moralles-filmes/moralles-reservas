// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";

/**
 * `send-manual-message` (Task 4.2) com conversa do Instagram, no harness, com
 * banco falso e `fetch` do Graph falso. Nenhuma chamada real à Meta nem ao
 * WhatsApp: rota não declarada vira `external_fetch` e reprova o teste.
 */

const NOW = Date.parse("2026-10-16T15:00:00.000Z");
const UNIT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_UNIT = "aaaaaaaa-0000-4000-8000-000000000002";
const CONV = "bbbbbbbb-0000-4000-8000-000000000001";
const CONTACT = "cccccccc-0000-4000-8000-000000000001";
const ACCOUNT = "dddddddd-0000-4000-8000-000000000001";
const IG_USER = "17841400000000001";
const IGSID = "6600000000000001";
const TOKEN = "synthetic-ig-token-manual";
const CONNECTED_AT = "2026-10-01T12:00:00.123456+00:00";
const CALLER = "eeeeeeee-0000-4000-8000-000000000001";
const SEND_URL = `https://graph.instagram.com/v26.0/${IG_USER}/messages`;
const WA_SEND_URL = "https://cloud.datafyapi.com.br/v1/synthetic-phone-id/messages";
const RECENT_INBOUND = [{ role: "user", timestamp: "2026-10-16T14:00:00.000Z", content: "oi" }];

type GraphReply = { status: number; body: unknown; beforeReply?: () => Promise<void> };
const ok = (mid: string): GraphReply => ({ status: 200, body: { recipient_id: IGSID, message_id: mid } });

const opened: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => {
  for (const harness of opened.splice(0)) harness.dispose();
});

function setup(options: {
  channel?: string;
  memberUnit?: string;
  accountStatus?: string;
  accountUnit?: string;
  accountReadError?: boolean;
  messages?: unknown;
  message?: string;
  replies?: GraphReply[];
  recordError?: boolean;
  grant?: "active" | "revoked" | "error";
  dmEnabled?: boolean;
  /** Avança o relógio dentro da leitura do token (entre a janela e o POST). */
  advanceOnToken?: number;
  /** Reconexão depois da leitura da conta: o CAS devolve `false`. */
  reconnected?: boolean;
} = {}) {
  const reads: string[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const posts: { auth: string | null; body: unknown }[] = [];
  const waPosts: unknown[] = [];
  const replies = [...(options.replies ?? [ok("mid-1")])];
  const harnessRef: { current: ReturnType<typeof createEdgeRequestHarness> | null } = { current: null };
  const conv = {
    id: CONV, unit_id: UNIT, status: "human_active",
    channel: options.channel ?? "instagram",
    instagram_contact_id: CONTACT,
    // Cliente ligado com telefone: o ramo IG nunca pode usar isto.
    customer: { phone: "11999999999" },
    instagram_contact: { igsid: IGSID, instagram_account_id: ACCOUNT },
  };
  const account = {
    id: ACCOUNT, unit_id: options.accountUnit ?? UNIT, ig_user_id: IG_USER,
    status: options.accountStatus ?? "connected", connected_at: CONNECTED_AT,
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: CALLER } }, error: null }) },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      if (name === "get_instagram_account_token") {
        if (options.advanceOnToken) await harnessRef.current!.advanceTime(options.advanceOnToken);
        return args.p_account_id === ACCOUNT ? { data: TOKEN, error: null } : { data: null, error: { code: "P0002" } };
      }
      if (name === "set_instagram_account_status") {
        // CAS fiel à 20261029200800.
        if (typeof args.p_expected_connected_at !== "string") return { data: null, error: { code: "22023" } };
        return { data: !options.reconnected && args.p_expected_connected_at === CONNECTED_AT, error: null };
      }
      if (name === "record_whatsapp_human_message") {
        return options.recordError ? { data: null, error: { message: "synthetic" } } : { data: null, error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      let columns = "";
      const filters: Record<string, unknown> = {};
      const query = {
        select(value: string) { columns = value; reads.push(`${table}:${value}`); return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        is(key: string, value: unknown) { filters[`is:${key}`] = value; return query; },
        limit() { return query; },
        order() { return query; },
        async maybeSingle() {
          if (table === "conversations" && columns.includes("unit_id, status")) {
            return { data: filters.id === CONV ? conv : null, error: null };
          }
          if (table === "conversations" && columns === "messages") {
            return filters.id === CONV && filters.unit_id === UNIT
              ? { data: { messages: options.messages ?? RECENT_INBOUND }, error: null }
              : { data: null, error: null };
          }
          if (table === "unit_members") {
            const memberUnit = options.memberUnit ?? UNIT;
            return { data: filters.unit_id === memberUnit && filters.user_id === CALLER ? { user_id: CALLER } : null, error: null };
          }
          if (table === "platform_admins") return { data: null, error: null };
          if (table === "instagram_accounts") {
            if (options.accountReadError) return { data: null, error: { code: "XX000" } };
            return { data: filters.id === account.id && (!("unit_id" in filters) || filters.unit_id === account.unit_id) ? account : null, error: null };
          }
          if (table === "whatsapp_channels" && columns.includes("credentials")) {
            // Canal WhatsApp completo: se o ramo IG faltar, o fluxo WhatsApp chega ao POST do provider.
            return { data: { id: "wa-channel", unit_id: UNIT, provider: "datafy", status: "connected", is_active: true,
              last_health_check_at: new Date(NOW).toISOString(), credentials: { access_token: "synthetic-wa", phone_number_id: "synthetic-phone-id" },
              instance_token_secret_id: null }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === "unit_module_grants") {
            const grant = options.grant ?? "active";
            if (grant === "error") return Promise.resolve(resolve({ data: null, error: { code: "XX000" } }));
            const matches = grant === "active" && filters.unit_id === UNIT && filters.module === "instagram"
              && "is:revoked_at" in filters && filters["is:revoked_at"] === null;
            return Promise.resolve(resolve({ data: matches ? [{ unit_id: UNIT }] : [], error: null }));
          }
          if (table === "instagram_settings") {
            return Promise.resolve(resolve({ data: [{ unit_id: UNIT, dm_enabled: options.dmEnabled ?? true }], error: null }));
          }
          if (table === "whatsapp_channels") {
            return Promise.resolve(resolve(columns === "id" ? { data: null, error: null, count: 1 } : { data: [
              { id: "wa-channel", provider: "datafy", status: "connected", is_active: true, created_at: "2026-10-01T00:00:00Z" },
            ], error: null }));
          }
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return query;
    },
  };
  const harness = createEdgeRequestHarness({
    now: NOW,
    env: { SUPABASE_URL: "https://fixture.supabase.invalid", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" },
    createClient: () => client,
    transport: [{
      // POST do provider WhatsApp (Datafy): só o controle positivo pode chegar aqui.
      from: "send-manual-message", method: "POST", url: WA_SEND_URL,
      respond: async (request) => { waPosts.push(await request.json()); return Response.json({ messages: [{ id: "wamid.synthetic" }] }); },
    }, {
      from: "send-manual-message", method: "POST", url: SEND_URL,
      respond: async (request) => {
        posts.push({ auth: request.headers.get("Authorization"), body: await request.json() });
        const reply = replies.shift();
        if (!reply) throw new Error("POST do Graph não previsto");
        if (reply.beforeReply) await reply.beforeReply();
        return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
      },
    }],
  });
  harnessRef.current = harness;
  opened.push(harness);
  const request = () => harness.request("send-manual-message", new Request("https://fixture.supabase.invalid/functions/v1/send-manual-message", {
    method: "POST", headers: { Authorization: "Bearer synthetic-jwt" },
    body: JSON.stringify({ conversation_id: CONV, message: options.message ?? "Olá, sua mesa está garantida." }),
  }));
  const recorded = () => rpcs.filter((call) => call.name === "record_whatsapp_human_message");
  return { request, reads, rpcs, posts, waPosts, harness, recorded };
}

/** Duas partes: dois parágrafos que juntos passam de 1000 bytes. */
const LONG_A = "A".repeat(700);
const LONG_B = "B".repeat(700);
const LONG_MESSAGE = `${LONG_A}\n\n${LONG_B}`;

describe("send-manual-message pelo Instagram", () => {
  it("envia pelo Graph, grava a mensagem humana com provider_message_ids e nunca toca o WhatsApp", async () => {
    const x = setup();
    const response = await x.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(x.posts).toEqual([{ auth: `Bearer ${TOKEN}`, body: { recipient: { id: IGSID }, message: { text: "Olá, sua mesa está garantida." } } }]);
    expect(x.reads.some((read) => read.startsWith("whatsapp_channels:"))).toBe(false);
    expect(x.waPosts).toHaveLength(0);
    x.harness.assertNoUnexpectedIo();
    const [call] = x.recorded();
    expect(call.args).toMatchObject({ p_conversation_id: CONV, p_unit_id: UNIT });
    expect(call.args.p_message).toMatchObject({
      role: "human", author: "human", content: "Olá, sua mesa está garantida.",
      human_user_id: CALLER, provider_message_ids: ["mid-1"],
    });
    expect(x.reads).toContain("conversations:id, unit_id, status, channel, instagram_contact_id, customer:customers(phone), instagram_contact:instagram_contacts(igsid, instagram_account_id)");
    // Token nunca em log.
    expect(x.harness.logs.join("\n")).not.toContain(TOKEN);
  });

  it("controle positivo: a mesma conversa tratada como WhatsApp tenta o POST do provider", async () => {
    const x = setup({ channel: "whatsapp" });
    await x.request();
    expect(x.reads.some((read) => read.startsWith("whatsapp_channels:"))).toBe(true);
    expect(x.posts).toHaveLength(0);
    // Sem o ramo do Instagram, o fluxo WhatsApp chega ao POST do provider.
    expect(x.waPosts).toHaveLength(1);
  });

  it("membro de outra unidade recebe 403 sem ler conta, token, histórico nem enviar", async () => {
    const x = setup({ memberUnit: OTHER_UNIT });
    const response = await x.request();
    expect(response.status).toBe(403);
    expect(x.posts).toHaveLength(0);
    expect(x.rpcs).toHaveLength(0);
    expect(x.reads.some((read) => read.startsWith("instagram_accounts:"))).toBe(false);
    expect(x.reads).not.toContain("conversations:messages");
    x.harness.assertNoUnexpectedIo();
  });

  it("janela fechada dá 409 OUTSIDE_SERVICE_WINDOW sem ler token nem enviar", async () => {
    const x = setup({ messages: [{ role: "user", timestamp: "2026-10-15T14:00:00.000Z" }] });
    const response = await x.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "OUTSIDE_SERVICE_WINDOW" });
    expect(x.posts).toHaveLength(0);
    expect(x.rpcs.some((call) => call.name === "get_instagram_account_token")).toBe(false);
    expect(x.recorded()).toHaveLength(0);
  });

  it("controle positivo da janela: a mesma conversa com inbound recente envia", async () => {
    const x = setup({ messages: [{ role: "user", timestamp: "2026-10-15T15:00:01.000Z" }] });
    expect((await x.request()).status).toBe(200);
    expect(x.posts).toHaveLength(1);
  });

  it("janela que fecha entre a leitura e o POST dá 409 sem POST", async () => {
    const x = setup({ messages: [{ role: "user", timestamp: "2026-10-15T15:00:01.000Z" }], advanceOnToken: 2_000 });
    const response = await x.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "OUTSIDE_SERVICE_WINDOW" });
    expect(x.posts).toHaveLength(0);
    expect(x.recorded()).toHaveLength(0);
  });

  it("conta não conectada dá 409 INSTAGRAM_NOT_CONNECTED; erro de leitura dá 503", async () => {
    for (const fixture of [setup({ accountStatus: "reauth_required" }), setup({ accountUnit: OTHER_UNIT })]) {
      const response = await fixture.request();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "INSTAGRAM_NOT_CONNECTED" });
      expect(fixture.posts).toHaveLength(0);
    }
    const failed = setup({ accountReadError: true });
    expect((await failed.request()).status).toBe(503);
    expect(failed.posts).toHaveLength(0);
  });

  it("envio manual parcial grava só o que saiu", async () => {
    const x = setup({ message: LONG_MESSAGE, replies: [ok("mid-1"), { status: 400, body: { error: { code: 100 } } }] });
    const response = await x.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "PARTIAL_SEND", code: "PARTIAL_SEND", sent: 1, total: 2, outcome_unknown: false });
    expect(x.posts).toHaveLength(2);
    const [call] = x.recorded();
    expect(call.args.p_message).toMatchObject({ content: LONG_A, provider_message_ids: ["mid-1"] });
  });

  it("desfecho desconhecido na segunda parte: PARTIAL_SEND com sent só das confirmadas, sem reenviar", async () => {
    const x = setup({ message: LONG_MESSAGE, replies: [ok("mid-1"), { status: 200, body: "not-json" }] });
    const response = await x.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "PARTIAL_SEND", sent: 1, total: 2, outcome_unknown: true });
    expect(x.posts).toHaveLength(2);
    expect(x.recorded()[0].args.p_message).toMatchObject({ content: LONG_A, provider_message_ids: ["mid-1"] });
  });

  it("janela que fecha entre as partes para antes da segunda e grava só a primeira", async () => {
    const recent = [{ role: "user", timestamp: "2026-10-15T15:00:01.000Z" }];
    const ref: { harness: ReturnType<typeof createEdgeRequestHarness> | null } = { harness: null };
    const x = setup({
      message: LONG_MESSAGE, messages: recent,
      // O relógio passa do fim da janela enquanto a primeira parte está no ar.
      replies: [{ ...ok("mid-1"), beforeReply: () => ref.harness!.advanceTime(2_000) }, ok("mid-2")],
    });
    ref.harness = x.harness;
    const response = await x.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "PARTIAL_SEND", sent: 1, total: 2, reason: "OUTSIDE_SERVICE_WINDOW", outcome_unknown: false });
    expect(x.posts).toHaveLength(1);
    expect(x.recorded()[0].args.p_message).toMatchObject({ content: LONG_A, provider_message_ids: ["mid-1"] });

    // Controle positivo: sem o avanço do relógio, as duas partes saem.
    const control = setup({ message: LONG_MESSAGE, messages: recent, replies: [ok("mid-1"), ok("mid-2")] });
    expect((await control.request()).status).toBe(200);
    expect(control.posts).toHaveLength(2);
    expect(control.recorded()[0].args.p_message).toMatchObject({ content: LONG_MESSAGE, provider_message_ids: ["mid-1", "mid-2"] });
  });

  it("grant do módulo revogado dá 409 INSTAGRAM_MODULE_DISABLED sem token, janela nem POST", async () => {
    const x = setup({ grant: "revoked" });
    const response = await x.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "INSTAGRAM_MODULE_DISABLED" });
    expect(x.posts).toHaveLength(0);
    expect(x.waPosts).toHaveLength(0);
    expect(x.rpcs).toHaveLength(0);
    expect(x.reads).not.toContain("conversations:messages");
    expect(x.reads).toContain("unit_module_grants:unit_id");
    x.harness.assertNoUnexpectedIo();
  });

  it("erro de leitura do grant fecha com 503 sem POST e sem texto do erro", async () => {
    const x = setup({ grant: "error" });
    const response = await x.request();
    expect(response.status).toBe(503);
    expect(x.posts).toHaveLength(0);
    expect(x.rpcs).toHaveLength(0);
    expect(x.harness.logs.join(" | ")).toContain("manual_instagram_grant_read_failed");
  });

  it("dm_enabled=false não bloqueia o envio manual (controla só a IA)", async () => {
    const x = setup({ dmEnabled: false });
    expect((await x.request()).status).toBe(200);
    expect(x.posts).toHaveLength(1);
    expect(x.reads.some((read) => read.startsWith("instagram_settings:"))).toBe(false);
  });

  it("código 190 marca reauth_required e dá 409 INSTAGRAM_REAUTH_REQUIRED", async () => {
    const x = setup({ replies: [{ status: 400, body: { error: { code: 190 } } }] });
    const response = await x.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "INSTAGRAM_REAUTH_REQUIRED" });
    expect(x.rpcs.find((call) => call.name === "set_instagram_account_status")?.args).toEqual({
      p_account_id: ACCOUNT, p_status: "reauth_required", p_error_code: "190", p_expected_connected_at: CONNECTED_AT,
    });
    expect(x.recorded()).toHaveLength(0);
    expect(x.harness.logs.join(" | ")).toContain("instagram_account_reauth_required");
  });

  it("código 190 depois de uma reconexão: o CAS recusa e nada é marcado como reauth", async () => {
    const x = setup({ replies: [{ status: 400, body: { error: { code: 190 } } }], reconnected: true });
    const response = await x.request();
    expect(response.status).toBe(409);
    expect(x.rpcs.find((call) => call.name === "set_instagram_account_status")?.args)
      .toMatchObject({ p_expected_connected_at: CONNECTED_AT });
    const logs = x.harness.logs.join(" | ");
    expect(logs).toContain("instagram_account_reauth_stale");
    expect(logs).not.toContain("instagram_account_reauth_required");
  });

  it("falha do registro após envio completo devolve 202 de reconciliação", async () => {
    const x = setup({ recordError: true });
    const response = await x.request();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ external_success: true, local_success: false, warning: "CONVERSATION_RECONCILIATION_REQUIRED" });
    expect(x.recorded()).toHaveLength(2);
  });
});

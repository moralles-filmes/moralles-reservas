// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeRequestHarness } from "../test/fixtures/edge-request-harness";

const now = Date.parse("2026-10-16T15:00:00.000Z");
const unit = "aaaaaaaa-0000-0000-0000-000000000001";
const conversation = "bbbbbbbb-0000-0000-0000-000000000001";
const opened: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => {
  for (const harness of opened.splice(0)) {
    harness.assertNoUnexpectedIo();
    harness.dispose();
  }
});

function setup(options: {
  provider?: string;
  member?: boolean;
  channelsError?: boolean;
  historyError?: boolean;
  messages?: unknown;
  expireDuringSelection?: boolean;
} = {}) {
  const reads: string[] = [];
  const provider = options.provider ?? "datafy";
  const messages = options.messages ?? [{ role: "user", timestamp: "2026-10-15T14:00:00.000Z" }];
  const harnessRef: { current: ReturnType<typeof createEdgeRequestHarness> | null } = { current: null };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "caller" } }, error: null }) },
    from(table: string) {
      let columns = "";
      const query = {
        select(value: string) { columns = value; reads.push(`${table}:${value}`); return query; },
        eq() { return query; },
        order() { return query; },
        async maybeSingle() {
          if (table === "conversations" && columns.includes("unit_id, status")) {
            return { data: { id: conversation, unit_id: unit, status: "human_active", customer: { phone: "11999999999" } }, error: null };
          }
          if (table === "conversations" && columns === "messages") {
            return options.historyError ? { data: null, error: { message: "synthetic" } } : { data: { messages }, error: null };
          }
          if (table === "unit_members") return { data: options.member === false ? null : { user_id: "caller" }, error: null };
          if (table === "platform_admins") return { data: null, error: null };
          if (table === "whatsapp_channels" && options.expireDuringSelection && columns.includes("credentials")) {
            await harnessRef.current!.advanceTime(2_000);
            return { data: { id: "channel", unit_id: unit, provider, status: "connected", is_active: true,
              last_health_check_at: new Date(now).toISOString(), credentials: { access_token: "synthetic" },
              instance_token_secret_id: null }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === "whatsapp_channels") return Promise.resolve(resolve(options.channelsError
            ? { data: null, error: { message: "synthetic" } }
            : columns === "id" && options.expireDuringSelection ? { data: null, error: null, count: 1 } : { data: [
              { id: "channel", provider, status: "connected", is_active: true, created_at: "2026-10-01T00:00:00Z" },
              ...(provider === "uazapi" ? [{ id: "inactive-datafy", provider: "datafy", status: "connected", is_active: false, created_at: "2026-10-02T00:00:00Z" }] : []),
            ], error: null }));
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return query;
    },
  };
  const harness = createEdgeRequestHarness({
    now,
    env: { SUPABASE_URL: "https://fixture.supabase.invalid", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" },
    createClient: () => client,
  });
  harnessRef.current = harness;
  opened.push(harness);
  const request = () => harness.request("send-manual-message", new Request("https://fixture.supabase.invalid/functions/v1/send-manual-message", {
    method: "POST", headers: { Authorization: "Bearer synthetic-jwt" },
    body: JSON.stringify({ conversation_id: conversation, message: "Olá" }),
  }));
  return { request, reads, harness };
}

describe("send-manual-message request boundary", () => {
  it("does not read history before authorizing the conversation", async () => {
    const fixture = setup({ member: false });
    expect((await fixture.request()).status).toBe(403);
    expect(fixture.reads).not.toContain("conversations:messages");
    expect(fixture.reads.some(read => read.startsWith("whatsapp_channels:"))).toBe(false);
  });

  it("rejects stale Meta conversations before outbound I/O", async () => {
    const fixture = setup();
    const response = await fixture.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "OUTSIDE_SERVICE_WINDOW" });
    expect(fixture.reads).toContain("conversations:messages");
  });

  it("does not reject a valid recent Meta inbound, but rejects future-only history", async () => {
    const recent = setup({ messages: [{ role: "user", timestamp: "2026-10-16T14:00:00.000Z" }] });
    expect((await recent.request()).status).toBe(502);
    const future = setup({ messages: [{ role: "user", timestamp: "2026-10-17T14:00:00.000Z" }] });
    const response = await future.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "OUTSIDE_SERVICE_WINDOW" });
  });

  it("rejects at the final pre-POST guard when the window expires during channel preparation", async () => {
    const fixture = setup({ expireDuringSelection: true,
      messages: [{ role: "user", timestamp: "2026-10-15T15:00:01.000Z" }] });
    const response = await fixture.request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "OUTSIDE_SERVICE_WINDOW" });
  });

  it("fails closed on channel or history read errors", async () => {
    const channel = setup({ channelsError: true });
    expect((await channel.request()).status).toBe(503);
    expect(channel.reads).not.toContain("conversations:messages");
    const history = setup({ historyError: true });
    expect((await history.request()).status).toBe(503);
  });

  it("does not require a Meta window when UazAPI is active and Datafy is inactive", async () => {
    const fixture = setup({ provider: "uazapi" });
    const response = await fixture.request();
    expect(response.status).toBe(502);
    expect(fixture.reads).not.toContain("conversations:messages");
  });
});

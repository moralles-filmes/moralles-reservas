import { describe, expect, it, vi } from "vitest";
import {
  type ChannelReadQuery,
  type ChannelServiceDependencies,
  createWhatsAppChannelService,
} from "../../supabase/functions/_shared/whatsapp-channel-service.ts";
import {
  type ChannelCredentials,
  type OutboundMessage,
  PROVIDER_CAPABILITIES,
  type WhatsAppProviderName,
} from "../../supabase/functions/_shared/whatsapp-provider-core.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const row = (extra = {}) => ({
  id: "channel-a",
  unit_id: "unit-a",
  provider: "zapi",
  credentials: { token: "synthetic-token" },
  instance_token_secret_id: null,
  status: "connected",
  last_health_check_at: new Date(NOW).toISOString(),
  is_active: true,
  created_at: "2026-01-01",
  template_credential_revision: 3,
  ...extra,
});

/** The fixture evaluates real query predicates; it never chooses the production route. */
function setup(channels = [row()]) {
  const bindings: Array<Record<string, unknown>> = [{
    id: "binding-a",
    channel_id: "channel-a",
    unit_id: "unit-a",
    provider: "zapi",
    account_id: null,
    generation: 7,
    channel_credential_revision: 3,
  }];
  const queries: Array<
    {
      table: string;
      columns: string;
      filters: Array<[string, unknown]>;
      order?: string;
      ascending?: boolean;
      limit?: number;
      head?: boolean;
    }
  > = [];
  let readError: string | null = null;
  let beforeRead: ((query: typeof queries[number]) => void) | undefined;
  const db = {
    from(table: string) {
      return {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          const query = {
            table,
            columns,
            filters: [] as Array<[string, unknown]>,
            head: options?.head,
            order: undefined as string | undefined,
            ascending: true,
            limit: undefined as number | undefined,
          };
          queries.push(query);
          const builder: ChannelReadQuery = {
            eq(key: string, value: unknown) {
              query.filters.push([key, value]);
              return builder;
            },
            is(key: string, value: null) {
              query.filters.push([key, value]);
              return builder;
            },
            order(key: string, options: { ascending: boolean }) {
              query.order = key;
              query.ascending = options?.ascending ?? true;
              return builder;
            },
            limit(value: number) {
              query.limit = value;
              return builder;
            },
            async maybeSingle() {
              return evaluate();
            },
            then: (fulfilled, rejected) =>
              Promise.resolve(evaluate()).then(fulfilled, rejected),
          };
          function evaluate() {
            beforeRead?.(query);
            const rows: Array<Record<string, unknown>> =
              table === "whatsapp_channels" ? channels : bindings;
            let matches = rows.filter((ch) =>
              query.filters.every(([key, value]) => ch[key] === value)
            );
            if (query.order) {
              matches = [...matches].sort((a, b) =>
                String(a[query.order as keyof typeof a]).localeCompare(
                  String(b[query.order as keyof typeof b]),
                ) * (query.ascending ? 1 : -1)
              );
            }
            const count = matches.length;
            if (query.limit) matches = matches.slice(0, query.limit);
            return {
              data: query.head ? null : matches[0] ?? null,
              error: readError ? { message: readError } : null,
              count,
            };
          }
          return builder;
        },
      };
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  const sendText = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    providerMessageId: "native-id",
    bodySnippet: "synthetic",
    missingCreds: [],
  });
  const sendTemplate = vi.fn();
  const status = vi.fn().mockResolvedValue({
    status: "connected",
    connected: true,
    qrRequired: false,
    nativeStatus: "synthetic",
  });
  const resolveCredentials = vi.fn<
    ChannelServiceDependencies["resolveCredentials"]
  >(async (_db, channel) => {
    return { ...channel.credentials };
  });
  const resolveServiceGate = vi.fn().mockResolvedValue(null);
  let provider: WhatsAppProviderName | null = "zapi";
  const clearServiceGateCache = vi.fn();
  const sendOutbound = vi.fn(
    async (
      _provider: WhatsAppProviderName,
      creds: ChannelCredentials,
      message: OutboundMessage,
      options?: { retryPolicy: "none" },
    ) => {
      if (!provider) {
        return { ok: false, error: `unknown_provider:${_provider}` };
      }
      return options
        ? sendText(creds, message, options)
        : sendText(creds, message);
    },
  );
  const service = createWhatsAppChannelService({
    db,
    resolveCredentials,
    resolveServiceGate,
    clearServiceGateCache,
    getProvider: () =>
      provider
        ? ({
          name: provider,
          label: provider,
          capabilities: PROVIDER_CAPABILITIES[provider],
          parseInbound: () => null,
          parseOwnMessageEchoes: () => [],
          peekInboundMedia: () => null,
          parseStatusCallback: () => null,
          sendText,
          ...(provider === "datafy" ? { sendTemplate } : {}),
          getConnectionStatus: status,
        })
        : null,
    sendOutbound,
    now: () => NOW,
    log: vi.fn(),
  });
  return {
    service,
    db,
    queries,
    channels,
    bindings,
    sendText,
    sendOutbound,
    sendTemplate,
    status,
    resolveCredentials,
    resolveServiceGate,
    clearServiceGateCache,
    failRead: (value: string | null) => {
      readError = value;
    },
    beforeRead: (fn: typeof beforeRead) => {
      beforeRead = fn;
    },
    provider: (value: typeof provider) => {
      provider = value;
    },
  };
}

describe("legacy actual channel routing characterization", () => {
  it("runs an optional final outbound guard after awaited preparation and before adapter POST", async () => {
    const f = setup([row({ provider: "datafy" })]);
    let now = NOW;
    f.resolveCredentials.mockImplementation(async (_db, channel) => {
      now += 2_000; // The service window expires during this await.
      return { ...channel.credentials };
    });
    const result = await f.service.sendWhatsApp("11999990000", "Olá", {
      channel_id: "channel-a",
      unit_id: "unit-a",
      beforeOutbound: () => now >= NOW + 1_000 ? "OUTSIDE_SERVICE_WINDOW" : null,
    });
    expect(result).toMatchObject({ ok: false, error: "OUTSIDE_SERVICE_WINDOW", channelId: "channel-a" });
    expect(f.sendOutbound).not.toHaveBeenCalled();
  });

  it("passes a manual Meta no-retry policy to the outbound adapter without changing other sends", async () => {
    const f = setup([row({ provider: "datafy" })]);
    expect((await f.service.sendWhatsApp("11999990000", "Olá", {
      channel_id: "channel-a", unit_id: "unit-a", beforeOutbound: () => null,
      outboundOptions: { retryPolicy: "none" },
    })).ok).toBe(true);
    expect(f.sendOutbound).toHaveBeenCalledWith("datafy", expect.anything(),
      { toPhone: "11999990000", text: "Olá" }, { retryPolicy: "none" });
  });

  it.each(["explicit", "active", "legacy"])(
    "%s route preserves raw payload and the complete result",
    async (route) => {
      const f = setup([row({ is_active: route === "legacy" ? null : true })]);
      const selector = route === "explicit"
        ? { channel_id: "channel-a", unit_id: "unit-a" }
        : { unit_id: "unit-a" };
      expect(await f.service.sendWhatsApp("11999990000", "Olá\n  ", selector))
        .toEqual({
          ok: true,
          status: 200,
          providerMessageId: "native-id",
          bodySnippet: "synthetic",
          missingCreds: [],
          provider: "zapi",
          channelId: "channel-a",
        });
      expect(f.sendText).toHaveBeenCalledWith({ token: "synthetic-token" }, {
        toPhone: "11999990000",
        text: "Olá\n  ",
      });
      expect(f.sendTemplate).not.toHaveBeenCalled();
      expect(f.resolveCredentials).toHaveBeenCalledOnce();
      expect(f.status).not.toHaveBeenCalled();
      if (route === "legacy") {
        expect(f.queries.at(-1)).toMatchObject({
          filters: [["unit_id", "unit-a"], ["is_active", null], [
            "status",
            "connected",
          ]],
          order: "created_at",
          limit: 1,
        });
      }
    },
  );
  it.each([
    {
      name: "foreign explicit",
      rows: [row({ unit_id: "unit-b" })],
      selector: { channel_id: "channel-a", unit_id: "unit-a" },
      error: "channel_mismatch",
    },
    {
      name: "false explicit",
      rows: [row({ is_active: false })],
      selector: { channel_id: "channel-a" },
      error: "whatsapp_channel_inactive",
    },
    {
      name: "NULL loses to true",
      rows: [row({ is_active: null }), row({ id: "channel-b" })],
      selector: { channel_id: "channel-a" },
      error: "whatsapp_channel_inactive",
    },
    {
      name: "active down never fallback",
      rows: [
        row({ status: "disconnected" }),
        row({ id: "channel-b", is_active: null }),
      ],
      selector: { unit_id: "unit-a" },
      error: "whatsapp_not_connected",
    },
    {
      name: "false unit",
      rows: [row({ is_active: false })],
      selector: { unit_id: "unit-a" },
      error: "whatsapp_not_configured",
    },
    {
      name: "NULL down unit",
      rows: [
        row({
          is_active: null,
          status: "disconnected",
          last_health_check_at: null,
        }),
      ],
      selector: { unit_id: "unit-a" },
      error: "whatsapp_not_configured",
    },
    {
      name: "missing",
      rows: [],
      selector: { unit_id: "unit-a" },
      error: "whatsapp_not_configured",
    },
    {
      name: "no identifiers",
      rows: [row()],
      selector: undefined,
      error: "whatsapp_not_configured",
    },
  ])("$name refuses without POST", async ({ rows, selector, error }) => {
    const f = setup(rows);
    expect(await f.service.sendWhatsApp("raw", "raw", selector)).toMatchObject({
      ok: false,
      error,
    });
    expect(f.sendText).not.toHaveBeenCalled();
  });
  it("oldest connected NULL wins, with false/down/other-tenant excluded", async () => {
    const f = setup([
      row({ id: "new", is_active: null, created_at: "2026-02-01" }),
      row({ id: "old", is_active: null }),
      row({ id: "false", is_active: false, created_at: "2025" }),
      row({
        id: "down",
        is_active: null,
        status: "disconnected",
        created_at: "2025",
      }),
      row({ id: "foreign", unit_id: "unit-b", created_at: "2025" }),
    ]);
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toMatchObject({ ok: true, channelId: "old" });
  });
  it("ordering fixture exposes an unsafe descending fallback and defaults to ascending", async () => {
    const channels = [row({ id: "new", is_active: null, created_at: "2026-02-01" }), row({ id: "old", is_active: null })];
    const f = setup(channels);
    f.beforeRead(query => { if (query.order === "created_at") query.ascending = false; });
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" })).toMatchObject({ channelId: "new" });
    const sorted = f.db.from("whatsapp_channels").select("id").order("created_at", undefined).limit(1);
    f.beforeRead(undefined);
    expect((await sorted.maybeSingle()).data).toMatchObject({ id: "old" });
  });
  it("count race blocks NULL fallback", async () => {
    const f = setup([row({ is_active: null })]);
    f.beforeRead((query) => {
      if (query.head) f.channels.push(row({ id: "race" }));
    });
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toEqual({ ok: false, error: "whatsapp_not_configured" });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(2);
  });
  it("gate and Vault failure lack route metadata; gate precedes all I/O", async () => {
    const f = setup();
    f.resolveServiceGate.mockResolvedValueOnce({ enforced: { sending: true } });
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toEqual({ ok: false, error: "whatsapp_service_suspended" });
    expect(f.queries).toHaveLength(0);
    f.resolveCredentials.mockRejectedValueOnce(new Error("synthetic"));
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toEqual({ ok: false, error: "whatsapp_credentials_unavailable" });
    expect(f.status).not.toHaveBeenCalled();
    expect(f.sendText).not.toHaveBeenCalled();
  });
  it("returned read errors refuse and unexpected gate/DB promises still reject", async () => {
    const f = setup();
    f.failRead("synthetic");
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toEqual({ ok: false, error: "whatsapp_channel_unavailable" });
    f.failRead(null);
    f.resolveServiceGate.mockRejectedValueOnce(new Error("synthetic-gate"));
    await expect(f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .rejects.toThrow("synthetic-gate");
    f.beforeRead(() => {
      throw new Error("synthetic-query");
    });
    await expect(f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .rejects.toThrow("synthetic-query");
  });
  it("service readFailed with unenforced sending remains fail-open", async () => {
    const f = setup();
    f.resolveServiceGate.mockResolvedValue({
      readFailed: true,
      enforced: { sending: false },
    });
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toMatchObject({ ok: true });
  });
  it.each([
    null,
    "invalid",
    new Date(NOW + 1).toISOString(),
    new Date(NOW - 300_001).toISOString(),
  ])("stale/missing/future %s rechecks before send", async (timestamp) => {
    const f = setup([
      row({ last_health_check_at: timestamp, status: "disconnected" }),
    ]);
    expect(
      await f.service.sendWhatsApp("raw", "raw", {
        channel_id: "channel-a",
        unit_id: "unit-a",
      }),
    ).toMatchObject({ ok: true });
    expect(f.status).toHaveBeenCalledWith({ token: "synthetic-token" });
    expect(f.db.rpc).toHaveBeenCalledWith(
      "record_whatsapp_channel_status",
      expect.objectContaining({
        p_unit_id: "unit-a",
        p_channel_id: "channel-a",
        p_status: "connected",
      }),
    );
    expect(f.status.mock.invocationCallOrder[0]).toBeLessThan(
      f.sendText.mock.invocationCallOrder[0],
    );
  });
  it.each([
    "disconnected",
    "error",
    "provider_error",
    "throw",
    "persist_throw",
    "persist_error",
  ])(
    "status %s preserves existing persistence/result behavior",
    async (outcome) => {
      const f = setup([row({ last_health_check_at: null })]);
      if (outcome === "throw") {
        f.status.mockRejectedValue(
          new Error("synthetic"),
        );
      } else if (outcome === "persist_throw") {
        f.db.rpc.mockRejectedValue(
          new Error("synthetic"),
        );
      } else if (outcome === "persist_error") {
        f.db.rpc.mockResolvedValue({
          data: null,
          error: { message: "synthetic" },
        });
      } else f.status.mockResolvedValue({ status: outcome, connected: true });
      const result = await f.service.sendWhatsApp("raw", "raw", {
        unit_id: "unit-a",
      });
      expect(result).toMatchObject(
        outcome === "persist_error" ? { ok: true } : {
          ok: false,
          error: "whatsapp_not_connected",
          provider: "zapi",
          channelId: "channel-a",
        },
      );
      expect(f.sendText).toHaveBeenCalledTimes(
        outcome === "persist_error" ? 1 : 0,
      );
      if (["error", "provider_error"].includes(outcome)) {
        expect(f.db.rpc).toHaveBeenCalledWith(
          "record_whatsapp_channel_status",
          expect.objectContaining({ p_error_code: "SEND_STATUS_CHECK" }),
        );
      }
    },
  );
  it("positive cache precedes changed projection but clearing exposes disconnect; refusal never cached", async () => {
    const f = setup();
    await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" });
    f.channels[0].status = "disconnected";
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toMatchObject({ ok: true });
    expect(f.resolveCredentials).toHaveBeenCalledTimes(2);
    f.service.clearChannelConnectivityCache();
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toMatchObject({ error: "whatsapp_not_connected" });
    f.channels[0].status = "connected";
    expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
      .toMatchObject({ ok: true });
  });
  it.each(["connected", "disconnected", "stale"])(
    "unknown provider diagnostic ordering %s stays legacy-only",
    async (state) => {
      const f = setup([
        row({
          provider: "unknown",
          status: state === "stale" ? "connected" : state,
          last_health_check_at: state === "stale"
            ? null
            : new Date(NOW).toISOString(),
        }),
      ]);
      f.provider(null);
      expect(await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" }))
        .toMatchObject({
          ok: false,
          error: state === "disconnected"
            ? "whatsapp_not_connected"
            : "unknown_provider:unknown",
          provider: "unknown",
          channelId: "channel-a",
        });
    },
  );
  it.each(["failure", "vault-current"])(
    "credential I/O %s is passed through without reusing JSONB token",
    async (vault) => {
      const f = setup([
        row({
          provider: "uazapi",
          instance_token_secret_id: "synthetic-pointer",
          credentials: { instance_token: "forged-jsonb" },
        }),
      ]);
      f.provider("uazapi");
      if (vault === "failure") {
        f.resolveCredentials.mockRejectedValue(new Error("synthetic-vault"));
      } else {
        f.resolveCredentials.mockResolvedValue({
          instance_token: "vault-current",
          base_url: "",
        });
      }
      const result = await f.service.sendWhatsApp("raw", "raw", {
        unit_id: "unit-a",
      });
      expect(result).toMatchObject(
        vault === "vault-current"
          ? { ok: true }
          : { ok: false, error: "whatsapp_credentials_unavailable" },
      );
      if (vault === "vault-current") {
        expect(f.sendText).toHaveBeenCalledWith({
          instance_token: "vault-current",
          base_url: "",
        }, { toPhone: "raw", text: "raw" });
      } else expect(f.sendText).not.toHaveBeenCalled();
    },
  );
});

describe("scheduled preparation reloads exact pins and private transport", () => {
  it("returns real text pins without raw credentials and single-attempt facade only when invoked", async () => {
    const f = setup();
    const resolved = await f.service.resolveScheduledChannel("unit-a");
    expect(resolved).toMatchObject({
      ok: true,
      channel: {
        id: "channel-a",
        unitId: "unit-a",
        provider: "zapi",
        transport: "text",
        bindingId: "binding-a",
        generation: 7,
        credentialRevision: 3,
        accountId: null,
      },
    });
    expect(f.sendText).not.toHaveBeenCalled();
    if (resolved.ok === false || resolved.channel.transport !== "text") {
      throw new Error("expected text");
    }
    expect(resolved.channel).not.toHaveProperty("credentials");
    await resolved.channel.sendText({ toPhone: "raw", text: "raw" });
    expect(f.sendOutbound).toHaveBeenCalledWith(
      "zapi",
      { token: "synthetic-token" },
      { toPhone: "raw", text: "raw" },
      { retryPolicy: "none" },
    );
  });
  it.each([
    "inactive",
    "new-active",
    "disconnect",
    "revision",
    "binding-missing",
    "foreign",
    "service",
    "read",
  ])("final prepare observes %s and zero POST", async (change) => {
    const f = setup();
    expect(await f.service.resolveScheduledChannel("unit-a")).toMatchObject({
      ok: true,
    });
    if (change === "inactive") f.channels[0].is_active = false;
    if (change === "new-active") {
      f.channels[0].is_active = null;
      f.channels.push(row({ id: "other" }));
    }
    if (change === "disconnect") f.channels[0].status = "disconnected";
    if (change === "revision") f.channels[0].template_credential_revision++;
    if (change === "binding-missing") f.bindings.length = 0;
    if (change === "foreign") f.channels[0].unit_id = "unit-b";
    if (change === "service") {
      f.resolveServiceGate.mockResolvedValue({ enforced: { sending: true } });
    }
    if (change === "read") f.failRead("synthetic");
    expect(await f.service.prepareScheduledChannel("channel-a", "unit-a"))
      .toMatchObject({ ok: false });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendTemplate).not.toHaveBeenCalled();
    expect(f.clearServiceGateCache).toHaveBeenCalledTimes(2);
  });
  it("changed generation is projected for final SQL comparison, never inferred", async () => {
    const f = setup();
    expect(await f.service.resolveScheduledChannel("unit-a")).toMatchObject({
      channel: { generation: 7 },
    });
    f.bindings[0].generation = 8;
    expect(await f.service.prepareScheduledChannel("channel-a", "unit-a"))
      .toMatchObject({ channel: { generation: 8 } });
    expect(f.sendText).not.toHaveBeenCalled();
  });
  it("prepare reloads credential I/O, even within the same invocation", async () => {
    const f = setup([
      row({
        provider: "uazapi",
        instance_token_secret_id: "synthetic-pointer",
      }),
    ]);
    f.provider("uazapi");
    f.bindings[0].provider = "uazapi";
    f.resolveCredentials.mockResolvedValueOnce({
      instance_token: "old-vault",
      base_url: "",
    })
      .mockResolvedValueOnce({ instance_token: "new-vault", base_url: "" });
    expect(await f.service.resolveScheduledChannel("unit-a")).toMatchObject({
      ok: true,
    });
    const final = await f.service.prepareScheduledChannel(
      "channel-a",
      "unit-a",
    );
    if (final.ok === false || final.channel.transport !== "text") {
      throw new Error("expected text");
    }
    await final.channel.sendText({ toPhone: "raw", text: "raw" });
    expect(f.sendOutbound).toHaveBeenCalledWith(
      "uazapi",
      expect.objectContaining({ instance_token: "new-vault" }),
      { toPhone: "raw", text: "raw" },
      { retryPolicy: "none" },
    );
  });
  it.each(["official", "unknown"])(
    "%s cannot fall back to text",
    async (provider) => {
      const f = setup([row({ provider })]);
      f.provider(provider === "official" ? "official" : null);
      expect(await f.service.resolveScheduledChannel("unit-a")).toEqual({
        ok: false,
        error: "scheduled_provider_unsupported",
      });
      expect(f.sendText).not.toHaveBeenCalled();
    },
  );
  it("Datafy requires real account and sends only template using last preparation", async () => {
    const f = setup([row({ provider: "datafy" })]);
    f.provider("datafy");
    f.bindings[0].provider = "datafy";
    expect(await f.service.resolveScheduledChannel("unit-a")).toMatchObject({
      ok: false,
      error: "scheduled_binding_unavailable",
    });
    f.bindings[0].account_id = "account-a";
    const final = await f.service.prepareScheduledChannel(
      "channel-a",
      "unit-a",
    );
    if (final.ok === false || final.channel.transport !== "template") {
      throw new Error("expected template");
    }
    expect(f.sendTemplate).not.toHaveBeenCalled();
    expect(final.channel).not.toHaveProperty("sendText");
    const input = {
      phoneNumberId: "123456789",
      toPhone: "11999990000",
      name: "res_confirmacao_v1",
      language: "pt_BR",
      parameters: ["synthetic"],
    };
    await final.channel.sendTemplate(input);
    expect(f.sendTemplate).toHaveBeenCalledWith(
      { token: "synthetic-token" },
      input,
    );
    expect(f.sendText).not.toHaveBeenCalled();
  });
  it.each([
    "generation",
    "revision",
    "account",
    "vault-error",
    "foreign-binding",
  ])("malformed/current %s blocks new preparation", async (reason) => {
    const f = setup([row({ provider: "uazapi" })]);
    f.provider("uazapi");
    f.bindings[0].provider = "uazapi";
    if (reason === "generation") f.bindings[0].generation = NaN;
    if (reason === "revision") f.bindings[0].channel_credential_revision = 4;
    if (reason === "account") f.bindings[0].account_id = "unexpected-account";
    if (reason === "foreign-binding") f.bindings[0].unit_id = "unit-b";
    if (reason === "vault-error") {
      f.channels[0].instance_token_secret_id = "synthetic-pointer";
      f.resolveCredentials.mockRejectedValue(new Error("synthetic-vault"));
    }
    expect(await f.service.resolveScheduledChannel("unit-a")).toMatchObject({
      ok: false,
    });
    expect(f.sendText).not.toHaveBeenCalled();
  });
  it("stale provider down blocks scheduled flow, regardless of initial cached positive proof", async () => {
    const f = setup();
    await f.service.sendWhatsApp("raw", "raw", { unit_id: "unit-a" });
    f.channels[0].last_health_check_at = null;
    f.status.mockResolvedValue({ status: "disconnected", connected: false });
    expect(await f.service.prepareScheduledChannel("channel-a", "unit-a"))
      .toEqual({ ok: false, error: "whatsapp_not_connected" });
    expect(f.status).toHaveBeenCalledOnce();
    expect(f.sendText).toHaveBeenCalledTimes(1); // Only the earlier legacy send.
  });
});

describe("four actual handler wiring contracts (not HTTP execution)", () => {
  it.each([
    "send-whatsapp",
    "send-confirmation",
    "send-cancellation",
    "send-manual-message",
  ])("%s keeps both invocational clears and legacy import", (handler) => {
    const source = readFileSync(
      resolve(process.cwd(), `supabase/functions/${handler}/index.ts`),
      "utf8",
    );
    expect(source).toMatch(
      /import[\s\S]*sendWhatsApp[\s\S]*from ["']\.\.\/_shared\/whatsapp-send.ts["']/,
    );
    expect(source.indexOf("clearChannelConnectivityCache();")).toBeGreaterThan(
      source.indexOf('req.method === "OPTIONS"'),
    );
    expect(source.indexOf("clearWhatsAppGateCache();")).toBeGreaterThan(
      source.indexOf('req.method === "OPTIONS"'),
    );
    expect(source.indexOf("clearChannelConnectivityCache();")).toBeLessThan(
      source.indexOf("await req.json()"),
    );
    expect(source).not.toContain("resolveScheduledChannel");
    expect(source).not.toContain("prepareScheduledChannel");
  });
});

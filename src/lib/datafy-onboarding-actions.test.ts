import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDatafyOnboardingActions, type DatafyOperationalEvent } from "../../supabase/functions/_shared/datafy-onboarding-actions";
import type { DatafyChannelSnapshot, DatafyAdminClient } from "../../supabase/functions/_shared/datafy-admin-client";

type Row = Record<string, unknown>;
const unitId = "unit-a", actor = "actor", channelId = "reserved-a";
const GRANTS = "whatsapp_official_connection_grants", ONBOARDINGS = "whatsapp_datafy_onboardings";
const grant = () => ({ id: "grant-a", unit_id: unitId, revoked_at: null, consumed_at: null, consumed_channel_id: null });
const onboarding = (state = "webhook_ready") => ({ id: "onboarding-a", unit_id: unitId, organization_id: "org-a",
  grant_id: "grant-a", reserved_channel_id: channelId, datafy_channel_id: state === "open" ? null : "remote-a", datafy_webhook_id: "hook-a",
  channel_token: "synthetic-channel-token", webhook_secret: "synthetic-webhook-secret", state, uncertain_steps: [], claim_id: null, claim_step: null });
const channel = () => ({ id: channelId, unit_id: unitId, provider: "datafy", external_instance_id: "remote-a",
  credentials: { phone_number_id: "number-a", business_account_id: "waba-a", access_token: "synthetic-channel-token" },
  webhook_secret: "synthetic-webhook-secret", is_active: false, status: "connected", provider_subscribed_at: null,
  template_credential_revision: 0,
  manual_echo_verified_at: null, activation_requested_at: null, units: { organization_id: "org-a" } });
const snapshot = (): DatafyChannelSnapshot => ({ id: "remote-a", name: channelId, subscribed: false, onTrial: true,
  trialEndsAt: null, paused: false, phoneNumberId: "number-a", wabaId: "waba-a", businessId: "business-a",
  token: "synthetic-channel-token", webhookSecret: "synthetic-webhook-secret", displayPhone: null, webhooks: [] });
const echoSource = readFileSync(resolve(__dirname, "../../supabase/functions/webhook-whatsapp/index.ts"), "utf8");
const echoBegin = echoSource.indexOf("    const ownMessageEchoes = parseOwnMessageEchoes(provider, payload);");
const echoEnd = echoSource.indexOf("    // Eco das mensagens da loja", echoBegin);
if (echoBegin < 0 || echoEnd <= echoBegin) throw new Error("datafy_echo_test_bounds_invalid");
const executeEcho = new Function("supabase", "channel", `return (async () => {
  const provider = "datafy", payload = {}, credentials = {}, unitId = "${unitId}", channelId = "${channelId}", requestId = "request";
  const parseOwnMessageEchoes = () => [{source:"manual_device"}], manualEchoMatchesConfiguredChannel = () => true;
  const jsonLog = () => {}, finish = async () => {};
  ${ts.transpile(echoSource.slice(echoBegin, echoEnd), { target: ts.ScriptTarget.ES2022 })}
})();`);

function harness(options: { state?: string; withChannel?: boolean; noOnboarding?: boolean; noGrant?: boolean; gates?: boolean; busy?: boolean; uncertain?: boolean; subscribed?: boolean; echo?: boolean; channelReadError?: boolean; productionClient?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    [GRANTS]: options.noGrant ? [] : [grant()],
    [ONBOARDINGS]: options.noOnboarding ? [] : [onboarding(options.state)],
    whatsapp_channels: options.withChannel ? [{ ...channel(), manual_echo_verified_at: options.echo ? "proof" : null }] : [],
    whatsapp_template_accounts: [], whatsapp_automation_adoptions: [],
  };
  const calls: string[] = [], filters: { table: string; keys: string[] }[] = [];
  const events: DatafyOperationalEvent[] = [];
  const unknownResponses: unknown[] = [];
  let sequence = 0;
  const remote = snapshot(); remote.subscribed = options.subscribed ?? false;
  let createFailure: null | "transport" = null, subscribeFailure: null | "transport" | "payment_declined" = null;
  let revokeDuringSubscribe = false, missingWrite: string | null = null, accountUnavailable = false, malformedClaim = false;
  let beforeClaim: (() => Promise<void>) | null = null, duringPost: (() => Promise<void>) | null = null;
  let beforeProjection: (() => Promise<void>) | null = null, secondClaimBusy = false;
  let monotonic = 0, beforeAuthorization: (() => Promise<void>) | null = null;
  let releaseFailureStep: string | null = null, releaseFailures = 0;
  const db = {
    from(table: string) {
      const predicates: ((row: Row) => boolean)[] = [];
      const seen = { table, keys: [] as string[] }; filters.push(seen);
      let patch: Row | null = null, inserted: Row | null = null, single = false, slice = [0, Infinity];
      const getResult = () => {
        if (table === "whatsapp_channels" && options.channelReadError && !patch && !inserted) return { data: null, count: 0, error: { code: "synthetic_read_error" } };
        const data = tables[table] ?? [];
        if (inserted) {
          const row = { ...inserted };
          if (table === ONBOARDINGS) Object.assign(row, { id: "onboarding-a", reserved_channel_id: channelId,
            state: "open", datafy_channel_id: null, datafy_webhook_id: null, channel_token: null, webhook_secret: null, uncertain_steps: [], claim_id: null });
          if (table === "whatsapp_channels") Object.assign(row, { provider_subscribed_at: null, manual_echo_verified_at: null,
            template_credential_revision: 0,
            activation_requested_at: null, units: { organization_id: "org-a" } });
          data.push(row); calls.push(`insert:${table}`);
        }
        const selected = data.filter((row) => predicates.every((test) => test(row))).slice(slice[0], slice[1]);
        if (patch) {
          calls.push(`update:${table}:${Object.keys(patch).join(",")}`);
          if (missingWrite === table) { missingWrite = null; return { data: single ? null : [], error: null }; }
          selected.forEach((row) => Object.assign(row, patch));
        }
        return { data: single ? selected[0] ? { ...selected[0] } : null : selected.map((row) => ({ ...row })), count: selected.length, error: null };
      };
      const query = {
        select(_projection: string) { return query; },
        eq(key: string, value: unknown) { seen.keys.push(`${key}:${value}`); predicates.push((row) => row[key] === value); return query; },
        neq(key: string, value: unknown) { seen.keys.push(`${key}!=${value}`); predicates.push((row) => row[key] !== value); return query; },
        is(key: string, value: unknown) { seen.keys.push(`${key}:${value}`); predicates.push((row) => (row[key] ?? null) === value); return query; },
        in(key: string, values: unknown[]) { predicates.push((row) => values.includes(row[key])); return query; },
        order(_key: string, _opts: unknown) { return query; },
        limit(value: number) { slice[1] = value; return query; },
        range(from: number, to: number) { slice = [from, to + 1]; return query; },
        update(value: Row) { patch = value; return query; },
        insert(value: Row) { inserted = value; return query; },
        maybeSingle() { single = true; return Promise.resolve(getResult()); },
        async then(fulfilled: (value: ReturnType<typeof getResult>) => unknown) {
          if (table === "whatsapp_channels" && patch?.provider_subscribed_at && beforeProjection) {
            const hook = beforeProjection; beforeProjection = null; await hook();
          }
          return fulfilled(getResult());
        },
      };
      return query;
    },
    async rpc(name: string, args: Row) {
      calls.push(`rpc:${name}:${args.p_outcome ?? args.p_step ?? ""}`);
      expect(args.p_unit_id).toBe(unitId);
      const o = tables[ONBOARDINGS].find((row) => row.id === args.p_onboarding_id);
      const c = tables.whatsapp_channels.find((row) => row.id === args.p_channel_id);
      if (name === "authorize_datafy_mutation") {
        if (beforeAuthorization) { const hook = beforeAuthorization; beforeAuthorization = null; await hook(); }
        const owned = o ?? c;
        const g = tables[GRANTS].find((row) => row.id === args.p_grant_id);
        return { data: !!owned && (o ? o.claim_id : c!.datafy_subscription_claim_id) === args.p_claim_id
          && (o ? (o.uncertain_steps as string[]).length === 0 : !c!.datafy_subscription_uncertain)
          && !owned.expired && (!["create_channel", "subscribe"].includes(String(args.p_operation)) || (!!g && !g.revoked_at && !g.consumed_at)), error: null };
      }
      if (name === "claim_datafy_onboarding_step") {
        if (beforeClaim) { const hook = beforeClaim; beforeClaim = null; await hook(); }
        if (malformedClaim) return { data: [{ claimed: true, claim_id: "claim-malformed" }], error: null };
        if (options.busy || (o!.claim_id && !o!.expired) || (secondClaimBusy && sequence > 0)
          || tables.whatsapp_channels.some((row) => row.id === o!.reserved_channel_id && (row.datafy_subscription_claim_id || row.datafy_subscription_uncertain))) return { data: [{ claimed: false, claim_id: null }], error: null };
        const pending = !!o!.claim_id;
        if (pending && !(o!.uncertain_steps as string[]).includes(String(o!.claim_step))) o!.uncertain_steps = [...o!.uncertain_steps as string[], o!.claim_step];
        const claimId = `claim-${++sequence}`; o!.claim_id = claimId; o!.claim_actor_id = args.p_actor_id; o!.claim_step = args.p_step; o!.expired = false;
        return { data: [{ claimed: true, claim_id: claimId, must_reconcile: pending || (o!.uncertain_steps as string[]).includes(String(args.p_step)) || options.uncertain === true }], error: null };
      }
      if (name === "claim_datafy_channel_operation") {
        if (beforeClaim) { const hook = beforeClaim; beforeClaim = null; await hook(); }
        const history = tables[ONBOARDINGS].find((row) => row.reserved_channel_id === args.p_channel_id);
        const live = history && !["completed", "abandoned"].includes(String(history.state)) ? history : null;
        const terminalPending = history && !live && (history.claim_id || (history.uncertain_steps as string[]).length > 0);
        if (options.busy || (history?.claim_id && !history.expired) || (c!.datafy_subscription_claim_id && !c!.expired)) return { data: [{ claimed: false, source: "onboarding", claim_id: null }], error: null };
        if ((live && args.p_operation === "relink") || (terminalPending && args.p_operation !== "subscribe")) return { data: null, error: { code: "23514" } };
        const useOnboarding = args.p_operation === "subscribe" && (live || terminalPending);
        const channelPending = !!c!.datafy_subscription_claim_id || !!c!.datafy_subscription_uncertain;
        const priorOperation = channelPending ? c!.datafy_subscription_uncertain_operation ?? c!.datafy_subscription_operation : null;
        const claimId = `claim-${++sequence}`;
        c!.expired = false;
        if (useOnboarding) {
          if (history!.claim_id && !(history!.uncertain_steps as string[]).includes(String(history!.claim_step))) history!.uncertain_steps = [...history!.uncertain_steps as string[], history!.claim_step ?? "subscribe"];
          history!.claim_id = claimId; history!.claim_actor_id = args.p_actor_id; history!.claim_step = "subscribe"; history!.expired = false;
        }
        else { c!.datafy_subscription_claim_id = claimId; c!.datafy_subscription_claim_actor_id = args.p_actor_id; c!.datafy_subscription_operation = args.p_operation;
          c!.datafy_subscription_uncertain = channelPending; c!.datafy_subscription_uncertain_operation = priorOperation; }
        return { data: [{ claimed: true, claim_id: claimId, must_reconcile: !!terminalPending || channelPending || (useOnboarding && (history!.uncertain_steps as string[]).includes("subscribe")) || options.uncertain === true,
          source: useOnboarding ? "onboarding" : "channel", onboarding_id: useOnboarding ? history!.id : null,
          external_instance_id: c!.external_instance_id, template_credential_revision: c!.template_credential_revision,
          reconcile_operation: terminalPending ? "subscribe" : priorOperation ?? (options.uncertain ? "subscribe" : null) }], error: null };
      }
      if (name.startsWith("release_datafy_")) {
        if (args.p_step === releaseFailureStep && releaseFailures-- > 0) return { data: null, error: { code: "synthetic_release_failure" } };
        const owned = o ?? c;
        const claimKey = o ? "claim_id" : "datafy_subscription_claim_id";
        if (owned?.[claimKey] !== args.p_claim_id || (o && o.claim_step !== args.p_step)) return { data: null, error: { code: "40001" } };
        owned![claimKey] = null;
        if (o) {
          if (args.p_outcome === "uncertain") o.uncertain_steps = [...new Set([...o.uncertain_steps as string[], args.p_step])];
          if (["succeeded", "reconciled_present", "reconciled_absent"].includes(String(args.p_outcome))) o.uncertain_steps = (o.uncertain_steps as string[]).filter((step) => step !== args.p_step);
          o.claim_step = null; o.claim_actor_id = null;
        }
        if (c) {
          if (args.p_outcome === "uncertain") { c.datafy_subscription_uncertain = true; c.datafy_subscription_uncertain_operation ??= c.datafy_subscription_operation; }
          if (["succeeded", "reconciled_present", "reconciled_absent"].includes(String(args.p_outcome))) { c.datafy_subscription_uncertain = false; c.datafy_subscription_uncertain_operation = null; }
          c.datafy_subscription_operation = null;
        }
        return { data: true, error: null };
      }
      if (name === "apply_datafy_channel_relink") {
        if (c!.datafy_subscription_claim_id !== args.p_claim_id || c!.external_instance_id !== args.p_expected_external_id
          || c!.template_credential_revision !== args.p_expected_revision) return { data: null, error: { code: "40001" } };
        Object.assign(c!, { external_instance_id: args.p_external_id, credentials: { ...(c!.credentials as Row), access_token: args.p_channel_token },
          webhook_secret: args.p_webhook_secret, template_credential_revision: Number(c!.template_credential_revision) + 1,
          manual_echo_verified_at: null, is_active: false, activation_requested_at: null, provider_subscribed_at: null,
          datafy_subscription_claim_id: null, datafy_subscription_operation: null });
        return { data: [{ id: c!.id, external_instance_id: c!.external_instance_id, template_credential_revision: c!.template_credential_revision }], error: null };
      }
      if (name === "finalize_datafy_channel_subscription") {
        if ((o?.claim_id ?? c!.datafy_subscription_claim_id) !== args.p_claim_id || c!.external_instance_id !== args.p_external_id
          || c!.template_credential_revision !== args.p_revision) return { data: null, error: { code: "40001" } };
        if (missingWrite === ONBOARDINGS) { missingWrite = null; return { data: null, error: { code: "finalize_failed" } }; }
        const g = tables[GRANTS].find((row) => row.id === args.p_grant_id);
        if (g?.revoked_at) return { data: "grant_revoked", error: null };
        if (g) Object.assign(g, { consumed_channel_id: c!.id, consumed_at: "consumed" });
        if (c!.provider_subscribed_at && !c!.provider_subscription_canceled_at && !c!.provider_paused_at) {
          c!.activation_requested_at = "intent"; calls.push("rpc:request_whatsapp_channel_activation:");
          if (c!.manual_echo_verified_at) { c!.is_active = true; c!.activation_requested_at = null; calls.push("rpc:activate_whatsapp_channel:"); }
        }
        if (o && !["completed", "abandoned"].includes(String(o.state))) Object.assign(o, { state: "completed", channel_token: null, webhook_secret: null });
        return { data: "finalized", error: null };
      }
      if (name === "record_datafy_channel_state") {
        if (beforeProjection) { const hook = beforeProjection; beforeProjection = null; await hook(); }
        if ((o?.claim_id ?? c!.datafy_subscription_claim_id) !== args.p_claim_id
          || (o?.claim_actor_id ?? c!.datafy_subscription_claim_actor_id) !== args.p_actor_id || c!.external_instance_id !== args.p_external_id
          || c!.template_credential_revision !== args.p_revision) return { data: null, error: { code: "40001" } };
        if (missingWrite === "whatsapp_channels") { missingWrite = null; return { data: false, error: null }; }
        Object.assign(c!, { provider_subscribed_at: args.p_subscribed ? c!.provider_subscribed_at ?? "subscribed" : null,
          provider_subscription_canceled_at: args.p_subscribed ? null : "canceled", provider_paused_at: args.p_paused ? "paused" : null });
        if (!args.p_subscribed || args.p_paused) Object.assign(c!, { is_active: false, activation_requested_at: null });
        return { data: true, error: null };
      }
      if (name === "request_whatsapp_channel_activation") { c!.activation_requested_at = "intent"; return { data: [{ channel_id: c!.id }], error: null }; }
      if (name === "activate_whatsapp_channel") {
        expect(c!.manual_echo_verified_at).toBeTruthy(); expect(c!.provider_subscribed_at).toBeTruthy();
        c!.is_active = true; c!.activation_requested_at = null; return { data: [], error: null };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const client: DatafyAdminClient = {
    getChannel: vi.fn(async (id) => { calls.push(`get:${id}`); return { ok: true as const, value: { ...remote, id, webhooks: [...remote.webhooks] } }; }),
    listChannels: vi.fn(async () => { calls.push("list"); return { ok: true as const, value: { accountSubscription: null, channels: [{ ...remote }] } }; }),
    createChannel: vi.fn(async () => {
      calls.push("create");
      if (createFailure) return { ok: false as const, kind: createFailure, httpStatus: null, code: "DATAFY_TRANSPORT" };
      remote.phoneNumberId = null;
      return { ok: true as const, value: { id: remote.id, token: remote.token!, webhookSecret: remote.webhookSecret!, subscribed: false } };
    }),
    createWebhook: vi.fn(async (_id, input) => { calls.push("webhook"); remote.webhooks.push({ id: "hook-a", ...input, enabled: true }); return { ok: true as const, value: { webhookId: "hook-a" } }; }),
    createConnectLink: vi.fn(async () => { calls.push("link"); return { ok: true as const, value: { url: "https://app.datafyapi.com.br/synthetic", expiresInSeconds: 60 } }; }),
    subscribe: vi.fn(async () => {
      calls.push("subscribe");
      if (duringPost) { const hook = duringPost; duringPost = null; await hook(); }
      if (revokeDuringSubscribe) { tables[GRANTS][0].revoked_at = "revoked"; tables[ONBOARDINGS][0].state = "abandoned"; }
      if (subscribeFailure) return { ok: false as const, kind: subscribeFailure, httpStatus: null, code: subscribeFailure === "transport" ? "DATAFY_TRANSPORT" : "DATAFY_PAYMENT_DECLINED" };
      remote.subscribed = true; return { ok: true as const, value: { subscribed: true } };
    }),
    cancel: vi.fn(async () => { if (duringPost) { const hook = duringPost; duringPost = null; await hook(); } return { ok: true as const, value: { acknowledged: true as const } }; }),
    pause: vi.fn(async () => ({ ok: true as const, value: { acknowledged: true as const } })),
    resume: vi.fn(async () => ({ ok: true as const, value: { acknowledged: true as const } })),
    deleteChannel: vi.fn(async () => { calls.push("delete"); return { ok: true as const, value: { deleted: true as const } }; }),
  };
  const tokenReader = vi.fn(async () => accountUnavailable ? { ok: false as const, reason: "unavailable" as const }
    : { ok: true as const, token: "synthetic-account-token" });
  const gates = vi.fn(async () => options.gates !== false);
  const actions = createDatafyOnboardingActions({ supabase: db as unknown as SupabaseClient, getAccountToken: tokenReader,
    getOrganizationId: async () => "org-a", gatesAllowed: gates, projectUrl: "https://project.test", createClient: options.productionClient ? undefined : () => client,
    emitEvent: (event) => { events.push(event); }, monotonicNow: () => monotonic,
    logUnrecognized: (info) => { unknownResponses.push(info); } });
  return { tables, calls, filters, events, unknownResponses, client, remote, tokenReader, gates,
    failCreate() { createFailure = "transport"; }, failSubscribe(kind: "transport" | "payment_declined") { subscribeFailure = kind; },
    unavailableAccount() { accountUnavailable = true; },
    malformedClaim() { malformedClaim = true; },
    beforeClaim(hook: () => Promise<void>) { beforeClaim = hook; },
    duringPost(hook: () => Promise<void>) { duringPost = hook; },
    beforeProjection(hook: () => Promise<void>) { beforeProjection = hook; },
    beforeAuthorization(hook: () => Promise<void>) { beforeAuthorization = hook; },
    advance(ms: number) { monotonic += ms; },
    failRelease(step: string, crash = false) { releaseFailureStep = step; releaseFailures = crash ? 2 : 1; },
    secondClaimBusy() { secondClaimBusy = true; },
    runEcho() { return executeEcho(db, { ...tables.whatsapp_channels[0] }); },
    revokeDuringSubscribe() { revokeDuringSubscribe = true; }, missWrite(table: string) { missingWrite = table; },
    run(action: string, body: Row = {}) { return actions.handle(action, unitId, actor, "request", body); } };
}

describe("Datafy onboarding: I/O com decisões reais", () => {
  it.each([
    ["create_channel", false], ["create_channel", true], ["create_webhook", false], ["create_webhook", true],
  ] as const)("FWR001 recupera %s persistido após release falhar (crash=%s)", async (step, crash) => {
    const h = harness({ state: "open" }); h.failRelease(step, crash);
    expect((await h.run("official_connect_start")).status).toBe(503);
    const o = h.tables[ONBOARDINGS][0];
    expect(o.state).toBe(step === "create_channel" ? "channel_created" : "webhook_ready");
    expect(crash ? o.claim_step : (o.uncertain_steps as string[])[0]).toBe(step);
    const identity = { datafy_channel_id: o.datafy_channel_id, channel_token: o.channel_token, webhook_secret: o.webhook_secret };
    o.expired = true;
    if (step === "create_webhook") h.remote.phoneNumberId = "number-a";
    const resumed = await h.run(step === "create_channel" ? "official_connect_start" : "official_connect_confirm");
    expect(resumed.status).toBe(200);
    expect(h.client.createChannel).toHaveBeenCalledTimes(1);
    expect(h.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(o.uncertain_steps).toEqual([]);
    expect(o.datafy_channel_id).toBe(identity.datafy_channel_id);
    const reconciled = h.calls.indexOf("rpc:release_datafy_onboarding_step:reconciled_present");
    expect(reconciled).toBeGreaterThan(-1);
    if (step === "create_channel") {
      expect(o).toMatchObject(identity); expect(o.state).toBe("webhook_ready");
      expect(reconciled).toBeLessThan(h.calls.indexOf("webhook"));
      expect(h.client.subscribe).not.toHaveBeenCalled();
    } else {
      expect(h.client.subscribe).toHaveBeenCalledTimes(1);
      expect(reconciled).toBeLessThan(h.calls.indexOf("subscribe")); expect(o.state).toBe("completed");
    }
  });
  it.each(["create_channel", "create_webhook"])("FWR001 timeout da recuperação %s preserva pendência e não posta", async (step) => {
    const h = harness({ state: step === "create_channel" ? "channel_created" : "webhook_ready" });
    h.tables[ONBOARDINGS][0].uncertain_steps = [step];
    vi.mocked(h.client.getChannel).mockResolvedValue({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect((await h.run(step === "create_channel" ? "official_connect_start" : "official_connect_confirm")).status).toBe(503);
    expect(h.tables[ONBOARDINGS][0].uncertain_steps).toEqual([step]);
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.createWebhook).not.toHaveBeenCalled(); expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it.each(["create_channel", "create_webhook"])("FWR001 takeover durante GET de %s recusa liberação stale", async (step) => {
    const h = harness({ state: step === "create_channel" ? "channel_created" : "webhook_ready" });
    h.tables[ONBOARDINGS][0].uncertain_steps = [step];
    h.remote.webhooks.push({ id: "hook-a", url: `https://project.test/functions/v1/webhook-whatsapp?channel=${channelId}`, enabled: true, events: ["messages", "smb_message_echoes"] });
    vi.mocked(h.client.getChannel).mockImplementation(async () => {
      h.tables[ONBOARDINGS][0].claim_id = "successor"; return { ok: true, value: h.remote };
    });
    expect((await h.run(step === "create_channel" ? "official_connect_start" : "official_connect_confirm")).status).toBeGreaterThanOrEqual(400);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ claim_id: "successor", uncertain_steps: [step] });
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.createWebhook).not.toHaveBeenCalled(); expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("FWR001 webhook ausente sem canal publicado volta ao reparo cercado", async () => {
    const h = harness(); h.tables[ONBOARDINGS][0].uncertain_steps = ["create_webhook"];
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ datafy_channel_id: "remote-a", state: "webhook_ready", uncertain_steps: [] });
  });
  it("FWR001 404 antes de publicar reconcilia todas as etapas antes de recriar", async () => {
    const h = harness(); h.tables[ONBOARDINGS][0].uncertain_steps = ["create_channel", "create_webhook"];
    vi.mocked(h.client.getChannel).mockResolvedValueOnce({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" })
      .mockResolvedValueOnce({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" });
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createChannel).toHaveBeenCalledTimes(1); expect(h.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(h.tables[ONBOARDINGS][0].uncertain_steps).toEqual([]);
    expect(h.calls.filter((call) => call === "rpc:release_datafy_onboarding_step:reconciled_absent")).toHaveLength(2);
  });
  it.each([false, true])("FWR001 ausência com canal publicado preserva identidade para relink (404=%s)", async (missingChannel) => {
    const h = harness({ state: "connected", withChannel: true });
    h.tables[ONBOARDINGS][0].uncertain_steps = ["create_channel", "create_webhook"];
    if (missingChannel) vi.mocked(h.client.getChannel).mockResolvedValue({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" });
    expect((await h.run("official_connect_confirm")).status).toBe(409);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "connected", datafy_channel_id: "remote-a", uncertain_steps: [] });
    expect(h.tables.whatsapp_channels[0].external_instance_id).toBe("remote-a");
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.createWebhook).not.toHaveBeenCalled(); expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("FWR001 crash após reset cercado para open também permite retomar", async () => {
    const h = harness(); h.tables[ONBOARDINGS][0].uncertain_steps = ["create_webhook"];
    h.failRelease("create_webhook", true);
    vi.mocked(h.client.getChannel).mockResolvedValueOnce({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" });
    expect((await h.run("official_connect_start")).status).toBe(503);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "open", datafy_channel_id: null });
    h.tables[ONBOARDINGS][0].expired = true;
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createChannel).toHaveBeenCalledTimes(1); expect(h.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(h.tables[ONBOARDINGS][0].uncertain_steps).toEqual([]);
  });
  it.each([false, true])("WBR002 takeover após GET/grant permite só o POST do sucessor (channel=%s)", async (channelSource) => {
    const h = harness({ state: "connected", withChannel: true, noOnboarding: channelSource });
    h.gates.mockImplementationOnce(async () => {
      if (channelSource) h.tables.whatsapp_channels[0].expired = true;
      else h.tables[ONBOARDINGS][0].expired = true;
      expect((await h.run("datafy_subscribe")).status).toBe(200);
      return true;
    });
    expect((await h.run("datafy_subscribe")).status).toBeGreaterThanOrEqual(400);
    expect(h.client.subscribe).toHaveBeenCalledTimes(1);
    expect(h.tables[GRANTS][0].consumed_channel_id).toBe(channelId);
  });
  it("WBR002 deadline vencido durante a última autorização também impede POST", async () => {
    const h = harness({ state: "connected", withChannel: true });
    h.beforeAuthorization(async () => { h.advance(96_000); });
    expect((await h.run("official_connect_confirm")).status).toBe(409);
    expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("WBR002 configure_webhook após relink também revalida a cerca", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    h.beforeAuthorization(async () => { h.tables.whatsapp_channels[0].datafy_subscription_claim_id = "successor"; });
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBeGreaterThanOrEqual(400);
    expect(h.client.createWebhook).not.toHaveBeenCalled();
  });
  it.each(["create", "webhook", "cancel", "pause", "resume"])("WBR002 %s revalida a cerca depois dos awaits", async (operation) => {
    const start = ["create", "webhook"].includes(operation);
    const h = harness({ state: operation === "create" ? "open" : start ? "channel_created" : "completed", withChannel: !start });
    h.beforeAuthorization(async () => {
      if (start) h.tables[ONBOARDINGS][0].claim_id = "successor";
      else h.tables.whatsapp_channels[0].datafy_subscription_claim_id = "successor";
    });
    expect((await h.run(start ? "official_connect_start" : `datafy_${operation}`)).status).toBeGreaterThanOrEqual(400);
    const method = operation === "create" ? "createChannel" : operation === "webhook" ? "createWebhook" : operation;
    expect(h.client[method as keyof DatafyAdminClient]).not.toHaveBeenCalled();
  });
  it("WBR006 timeout mantém subscribe incerto terminal e bloqueia relink", async () => {
    const h = harness({ state: "abandoned", withChannel: true });
    h.tables[ONBOARDINGS][0].uncertain_steps = ["subscribe"];
    vi.mocked(h.client.getChannel).mockResolvedValue({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect((await h.run("datafy_subscribe")).status).toBe(503);
    expect(h.tables[ONBOARDINGS][0].uncertain_steps).toEqual(["subscribe"]);
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(409);
    expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("WBR007 factory real emite somente operation/status/shape para 2xx malformado", async () => {
    const h = harness({ state: "open", productionClient: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "private-canary", "secret-key-canary": "private-value" }), { status: 200 })));
    try {
      expect((await h.run("official_connect_start")).status).toBe(503);
      expect(h.unknownResponses).toHaveLength(1);
      expect(h.unknownResponses[0]).toMatchObject({ operation: "createChannel", httpStatus: 200 });
      expect(JSON.stringify(h.unknownResponses)).not.toMatch(/private-canary|secret-key-canary|private-value/);
      expect(readFileSync(resolve(__dirname, "../../supabase/functions/manage-channels/index.ts"), "utf8"))
        .toContain('logUnrecognized: (info) => jsonLog("warn", { evt: "datafy_admin_unrecognized", ...info })');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([true, null])("WBR001 confirm recusa outro provider que apareceu depois de start (%s)", async (isActive) => {
    const h = harness();
    h.tables.whatsapp_channels.push({ ...channel(), id: "other", provider: "zapi", is_active: isActive });
    expect(await h.run("official_connect_confirm")).toMatchObject({ status: 409, body: { code: "DATAFY_MIGRATION_NOT_SUPPORTED" } });
    expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("WBR004 revalida create após claim quando concorrente já terminou webhook", async () => {
    const h = harness({ state: "open" });
    Object.assign(h.tables[ONBOARDINGS][0], { datafy_channel_id: null, datafy_webhook_id: null });
    h.beforeClaim(async () => { Object.assign(h.tables[ONBOARDINGS][0], onboarding()); });
    expect(await h.run("official_connect_start")).toMatchObject({ body: { next: "confirm" } });
    expect(h.client.createChannel).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ datafy_channel_id: "remote-a", state: "webhook_ready" });
  });
  it("WBR004 dois starts reais intercalados preservam canal e link do primeiro", async () => {
    const h = harness({ state: "open" });
    let firstResponse: unknown;
    h.beforeClaim(async () => { firstResponse = await h.run("official_connect_start"); });
    const secondResponse = await h.run("official_connect_start");
    expect(secondResponse).toEqual(firstResponse);
    expect(secondResponse.status).toBe(200);
    expect(h.client.createChannel).toHaveBeenCalledTimes(1);
    expect(h.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ datafy_channel_id: "remote-a", state: "webhook_ready" });
  });
  it("WBR004 webhook não regride snapshot que avançou durante claim", async () => {
    const h = harness({ state: "channel_created" });
    h.beforeClaim(async () => { h.tables[ONBOARDINGS][0].state = "connected"; });
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createWebhook).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0].state).toBe("connected");
  });
  it("WBR006 404 encerra subscribe incerto terminal sem POST ou reabertura", async () => {
    const h = harness({ state: "abandoned", withChannel: true });
    h.tables[ONBOARDINGS][0].uncertain_steps = ["subscribe"];
    vi.mocked(h.client.getChannel).mockResolvedValue({ ok: false, kind: "not_found", httpStatus: 404, code: "DATAFY_NOT_FOUND" });
    expect(await h.run("datafy_subscribe")).toMatchObject({ body: { code: "REMOTE_CHANNEL_MISSING" } });
    expect(h.client.subscribe).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "abandoned", uncertain_steps: [], claim_id: null });
    h.remote.id = "remote-b";
    vi.mocked(h.client.getChannel).mockResolvedValue({ ok: true, value: h.remote });
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].external_instance_id).toBe("remote-b");
    expect(h.tables[ONBOARDINGS][0].state).toBe("abandoned");
  });
  it.each([
    { is_active: true, status: "disconnected" },
    { is_active: null, status: "connected" },
  ])("start recusa binding operacional existente, inclusive legado: %j", async (binding) => {
    const h = harness(); h.tables.whatsapp_channels.push({ ...channel(), ...binding, provider: "zapi" });
    expect(await h.run("official_connect_start")).toMatchObject({ status: 409, body: { code: "UNIT_ALREADY_ACTIVE" } });
    expect(h.client.getChannel).not.toHaveBeenCalled(); expect(h.client.createChannel).not.toHaveBeenCalled();
  });
  it.each([
    { is_active: false, status: "connected" },
    { is_active: null, status: "disconnected" },
  ])("start permite canal sem binding operacional: %j", async (binding) => {
    const h = harness(); h.tables.whatsapp_channels.push({ ...channel(), ...binding, provider: "zapi" });
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.getChannel).toHaveBeenCalled();
    expect(h.filters.filter((filter) => filter.table === "whatsapp_channels").every((filter) => filter.keys.includes(`unit_id:${unitId}`))).toBe(true);
  });
  it("start recusa erro de leitura do binding antes de chamar Datafy", async () => {
    const h = harness({ channelReadError: true });
    expect(await h.run("official_connect_start")).toMatchObject({ status: 503, body: { code: "CHANNEL_READ_FAILED" } });
    expect(h.client.getChannel).not.toHaveBeenCalled(); expect(h.client.createChannel).not.toHaveBeenCalled();
  });
  it("start percorre open → canal → webhook → link efêmero sem expor credenciais", async () => {
    const h = harness({ noOnboarding: true });
    const response = await h.run("official_connect_start", { phone_number_id: "forged", channel_id: "forged" });
    expect(response.status).toBe(200); expect(response.headers).toEqual({ "Cache-Control": "no-store" });
    expect(h.calls.indexOf("create")).toBeGreaterThan(h.calls.indexOf("rpc:claim_datafy_onboarding_step:create_channel"));
    expect(h.client.createChannel).toHaveBeenCalledWith({ name: channelId, description: `unit:${unitId}` });
    expect(h.tables[ONBOARDINGS][0].state).toBe("webhook_ready");
    expect(JSON.stringify(response)).not.toContain("synthetic-channel-token");
  });
  it("canal remoto com número nunca recebe link; webhook atrasado é preparado antes de confirm", async () => {
    const h = harness({ state: "channel_created" });
    const response = await h.run("official_connect_start");
    expect(response.body).toEqual({ next: "confirm" });
    expect(h.client.createConnectLink).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0].state).toBe("webhook_ready");
  });
  it("confirm verifica gates antes de GET, mesmo com corpo forjado", async () => {
    const h = harness({ gates: false });
    const response = await h.run("official_connect_confirm", { datafy_channel_id: "forged", waba_id: "forged" });
    expect(response.status).toBe(409); expect(h.client.getChannel).not.toHaveBeenCalled(); expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("confirm grava identidade do GET, assina, consome liberação e aguarda eco", async () => {
    const h = harness();
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    const stored = h.tables.whatsapp_channels[0];
    expect(stored.credentials).toMatchObject({ phone_number_id: "number-a", business_account_id: "waba-a" });
    expect(stored.is_active).toBe(false); expect(stored.activation_requested_at).toBe("intent");
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "completed", channel_token: null, webhook_secret: null });
    expect(h.tables[GRANTS][0].consumed_channel_id).toBe(channelId);
    const claim = h.calls.indexOf("rpc:claim_datafy_onboarding_step:subscribe");
    expect(h.calls.slice(claim, claim + 5)).toEqual(["rpc:claim_datafy_onboarding_step:subscribe", "get:remote-a", "rpc:authorize_datafy_mutation:", "subscribe", "get:remote-a"]);
  });
  it("assinatura que chega depois do eco também ativa e confirm concluído é idempotente", async () => {
    const h = harness({ state: "connected", withChannel: true, echo: true });
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].is_active).toBe(true);
    const count = vi.mocked(h.client.subscribe).mock.calls.length;
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.client.subscribe).toHaveBeenCalledTimes(count);
  });
  it("pagamento recusado preserva conexão sem intenção de ativação e emite evento seguro", async () => {
    const h = harness(); h.failSubscribe("payment_declined");
    expect((await h.run("official_connect_confirm")).body).toMatchObject({ step: "subscription_pending" });
    expect(h.tables.whatsapp_channels[0].activation_requested_at).toBeNull();
    expect(h.tables[ONBOARDINGS][0].state).toBe("connected");
    expect(h.events).toEqual([{ evt: "datafy_subscription_failed", unitId, channelId, reason: "DATAFY_PAYMENT_DECLINED" }]);
  });
  it("POST incerto nunca é repetido quando GET seguinte confirma assinatura", async () => {
    const h = harness({ state: "connected", withChannel: true }); h.failSubscribe("transport");
    expect((await h.run("official_connect_confirm")).status).toBe(503);
    h.remote.subscribed = true;
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.client.subscribe).toHaveBeenCalledTimes(1);
  });
  it("GET de reconciliação sem assinatura libera absent e reivindica outra cerca antes do POST", async () => {
    const h = harness({ state: "connected", withChannel: true });
    h.tables[ONBOARDINGS][0].uncertain_steps = ["subscribe"];
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    const posting = h.calls.indexOf("subscribe");
    expect(h.calls.slice(0, posting)).toContain("rpc:release_datafy_onboarding_step:reconciled_absent");
    expect(h.calls.slice(0, posting).filter((call) => call === "rpc:claim_datafy_onboarding_step:subscribe")).toHaveLength(2);
  });
  it("busy impede create e subscribe", async () => {
    const h = harness({ state: "open", busy: true });
    expect((await h.run("official_connect_start")).status).toBe(409);
    expect(h.client.createChannel).not.toHaveBeenCalled();
    const admin = harness({ state: "connected", withChannel: true, busy: true });
    expect((await admin.run("datafy_subscribe")).status).toBe(409); expect(admin.client.subscribe).not.toHaveBeenCalled();
  });
  it("RPC de claim com shape incompleta falha fechado antes de criar ou assinar", async () => {
    const h = harness({ state: "open" }); h.malformedClaim();
    expect((await h.run("official_connect_start")).body).toMatchObject({ code: "ONBOARDING_CLAIM_FAILED" });
    expect(h.client.createChannel).not.toHaveBeenCalled();
    const confirm = harness({ state: "connected", withChannel: true }); confirm.malformedClaim();
    expect((await confirm.run("official_connect_confirm")).body).toMatchObject({ code: "ONBOARDING_CLAIM_FAILED" });
    expect(confirm.client.subscribe).not.toHaveBeenCalled();
  });
  it("revogação durante subscribe registra custo remoto, sem consumir grant nem ativar", async () => {
    const h = harness({ state: "connected", withChannel: true }); h.revokeDuringSubscribe();
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].provider_subscribed_at).toBeTruthy();
    expect(h.tables.whatsapp_channels[0].activation_requested_at).toBeNull();
    expect(h.tables[GRANTS][0].consumed_at).toBeNull();
    expect(h.tables[ONBOARDINGS][0].state).toBe("abandoned");
    expect(h.events[0].reason).toBe("GRANT_REQUIRED");
  });
  it("colisão de número normaliza com a mesma régua do índice e exclui a própria linha", async () => {
    const h = harness(); h.tables.whatsapp_channels.push({ ...channel(), id: "other", unit_id: "unit-b",
      credentials: { phone_number_id: " \tnumber-a\r\n" }, units: { organization_id: "org-b" } });
    expect((await h.run("official_connect_confirm")).body).toMatchObject({ code: "PHONE_NUMBER_ALREADY_BOUND" });
    expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("UPDATE zero-row falha antes de consumir liberação ou ativar", async () => {
    const h = harness({ state: "connected", withChannel: true }); h.missWrite("whatsapp_channels");
    expect((await h.run("official_connect_confirm")).status).toBe(503);
    expect(h.tables[GRANTS][0].consumed_at).toBeNull();
    expect(h.calls).not.toContain("rpc:request_whatsapp_channel_activation:");
  });
  it.each(["completed", "abandoned"])("admin assina canal com onboarding %s sem reabrir histórico", async (state) => {
    const h = harness({ state, withChannel: true });
    expect((await h.run("datafy_subscribe")).status).toBe(200);
    expect(h.tables[ONBOARDINGS][0].state).toBe(state);
    expect(h.calls).toContain("rpc:release_datafy_existing_subscription:succeeded");
  });
  it("admin sem liberação não cria custo em canal legado", async () => {
    const h = harness({ noOnboarding: true, withChannel: true, noGrant: true });
    expect((await h.run("datafy_subscribe")).status).toBe(409); expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("lease do canal não fecha onboarding de outro canal na mesma unidade", async () => {
    const h = harness({ state: "open", withChannel: true });
    h.tables[ONBOARDINGS][0].reserved_channel_id = "different-channel";
    expect((await h.run("datafy_subscribe")).status).toBe(200);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "open", reserved_channel_id: "different-channel" });
    expect(h.calls).toContain("rpc:release_datafy_existing_subscription:succeeded");
  });
  it("preview é read-only, link exige candidato da listagem nova e invalida eco", async () => {
    const h = harness({ noOnboarding: true, withChannel: true, echo: true, subscribed: true });
    const preview = await h.run("datafy_link_existing");
    expect(preview.body).toMatchObject({ candidates: [{ name: channelId, idPrefix: "remote-a", expectedDatafyChannelId: "remote-a" }] });
    expect(h.calls.some((call) => call.startsWith("update:"))).toBe(false);
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "forged" })).status).toBe(409);
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-a" })).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].manual_echo_verified_at).toBeNull();
    expect(h.tables.whatsapp_channels[0].is_active).toBe(false);
  });
  it("revoke não cancela no provider e distingue liberação revogada de assinatura pendente", async () => {
    const h = harness({ state: "connected", withChannel: true });
    expect((await h.run("revoke_official_connection")).body).toMatchObject({ step: "not_granted", connectionRevoked: true, remoteCancellationRequested: false });
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "abandoned", channel_token: null, webhook_secret: null });
    expect(h.tokenReader).not.toHaveBeenCalled(); expect(h.client.cancel).not.toHaveBeenCalled();
  });
  it("confirm concluído é idempotente mesmo com credencial de conta indisponível", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.unavailableAccount();
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.tokenReader).not.toHaveBeenCalled();
  });
  it("token indisponível falha fechado antes de qualquer chamada ao provider", async () => {
    const h = harness({ noOnboarding: true }); h.unavailableAccount();
    expect((await h.run("official_connect_start")).body).toMatchObject({ code: "DATAFY_ACCOUNT_UNAVAILABLE" });
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.listChannels).not.toHaveBeenCalled();
  });
  it("create incerto adota canal pelo GET e não posta de novo", async () => {
    const h = harness({ state: "open" }); h.tables[ONBOARDINGS][0].datafy_channel_id = null;
    h.failCreate();
    expect((await h.run("official_connect_start")).status).toBe(503);
    h.remote.phoneNumberId = null;
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createChannel).toHaveBeenCalledTimes(1);
    expect(h.calls).toContain("rpc:release_datafy_onboarding_step:reconciled_present");
  });
  it("reconciliação ambígua mantém incerteza e recusa qualquer POST ou DELETE", async () => {
    const h = harness({ state: "open" }); h.tables[ONBOARDINGS][0].uncertain_steps = ["create_channel"];
    vi.mocked(h.client.listChannels).mockResolvedValue({ ok: true, value: { accountSubscription: null,
      channels: [{ ...h.remote }, { ...h.remote, id: "remote-b" }] } });
    expect((await h.run("official_connect_start")).body).toMatchObject({ code: "DATAFY_RECONCILE_AMBIGUOUS" });
    expect(h.tables[ONBOARDINGS][0].uncertain_steps).toEqual(["create_channel"]);
    expect(h.client.createChannel).not.toHaveBeenCalled(); expect(h.client.deleteChannel).not.toHaveBeenCalled();
  });
  it("GET 404 do adotado trata listagem defasada como ausência, reivindica de novo e cria", async () => {
    const h = harness({ state: "open" }); h.tables[ONBOARDINGS][0].datafy_channel_id = null;
    h.tables[ONBOARDINGS][0].uncertain_steps = ["create_channel"];
    vi.mocked(h.client.getChannel).mockResolvedValueOnce({ ok: false, kind: "not_found", code: "DATAFY_NOT_FOUND", httpStatus: 404 });
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.calls).toContain("rpc:release_datafy_onboarding_step:reconciled_absent");
    expect(h.client.createChannel).toHaveBeenCalledTimes(1);
  });
  it("trial vencido apaga só após GET descartável, recria e conserva reserved id/URL", async () => {
    const h = harness(); h.remote.phoneNumberId = null; h.remote.onTrial = false;
    vi.mocked(h.client.createChannel).mockImplementationOnce(async () => {
      h.remote.onTrial = true; return { ok: true, value: { id: "remote-new", token: "synthetic-new-token", webhookSecret: "synthetic-new-secret", subscribed: false } };
    });
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.calls.slice(0, 3)).toEqual(["get:remote-a", "get:remote-a", "delete"]);
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ reserved_channel_id: channelId, datafy_channel_id: "remote-new" });
    expect(h.client.createWebhook).toHaveBeenCalledWith("remote-new", { url: `https://project.test/functions/v1/webhook-whatsapp?channel=${channelId}`,
      events: ["messages", "smb_message_echoes"] });
  });
  it("webhook de resposta incerta é reconciliado por URL/eventos sem novo POST", async () => {
    const h = harness({ state: "channel_created" }); h.remote.phoneNumberId = null;
    h.tables[ONBOARDINGS][0].uncertain_steps = ["create_webhook"];
    h.remote.webhooks = [{ id: "existing-hook", url: `https://project.test/functions/v1/webhook-whatsapp?channel=${channelId}`,
      events: ["messages", "smb_message_echoes"], enabled: true }];
    expect((await h.run("official_connect_start")).status).toBe(200);
    expect(h.client.createWebhook).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0].datafy_webhook_id).toBe("existing-hook");
  });
  it("409 do link é recusa curta sem já reconectar/trocar o número", async () => {
    const h = harness(); h.remote.phoneNumberId = null;
    vi.mocked(h.client.createConnectLink).mockResolvedValueOnce({ ok: false, kind: "conflict", httpStatus: 409, code: "DATAFY_CONFLICT" });
    expect((await h.run("official_connect_start")).body).toMatchObject({ code: "DATAFY_LINK_REFUSED" });
    expect(h.client.deleteChannel).not.toHaveBeenCalled(); expect(h.client.createChannel).not.toHaveBeenCalled();
  });
  it("WABA de outra organização recusa antes da assinatura", async () => {
    const h = harness(); h.tables.whatsapp_template_accounts.push({ id: "account-b", waba_id: "waba-a", organization_id: "org-b" });
    expect((await h.run("official_connect_confirm")).body).toMatchObject({ code: "WABA_OWNED_BY_OTHER_ORG" });
    expect(h.client.subscribe).not.toHaveBeenCalled();
  });
  it("2xx subscribed:false segue GET efetivo e não fecha onboarding", async () => {
    const h = harness({ state: "connected", withChannel: true });
    vi.mocked(h.client.subscribe).mockResolvedValueOnce({ ok: true, value: { subscribed: false } });
    expect((await h.run("official_connect_confirm")).body).toMatchObject({ step: "subscription_pending" });
    expect(h.tables[GRANTS][0].consumed_at).toBeNull(); expect(h.tables[ONBOARDINGS][0].state).toBe("connected");
  });
  it("falha do finisher atômico preserva grant e é reconciliável sem cobrar de novo", async () => {
    const h = harness({ state: "connected", withChannel: true }); h.missWrite(ONBOARDINGS);
    expect((await h.run("official_connect_confirm")).status).toBe(503);
    expect(h.tables[GRANTS][0].consumed_channel_id).toBeNull();
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(h.client.subscribe).toHaveBeenCalledTimes(1);
  });
  it("cancel/pause/resume persistem GET pós-operação, não o estado solicitado", async () => {
    const h = harness({ withChannel: true }); h.remote.subscribed = true; h.remote.paused = false;
    expect((await h.run("datafy_pause")).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].provider_paused_at).toBeNull();
    expect(h.tables.whatsapp_channels[0].provider_subscribed_at).toBeTruthy();
    h.remote.paused = true;
    expect((await h.run("datafy_resume")).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].provider_paused_at).toBeTruthy();
    h.remote.subscribed = false;
    expect((await h.run("datafy_cancel")).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].provider_subscribed_at).toBeNull();
    expect(h.tables.whatsapp_channels[0].provider_subscription_canceled_at).toBeTruthy();
    expect(h.client.getChannel).toHaveBeenCalledTimes(3);
  });
  it.each(["datafy_cancel", "datafy_pause"])("%s limpa intenção e o próximo eco real não ativa", async (action) => {
    const h = harness({ state: "completed", withChannel: true });
    Object.assign(h.tables.whatsapp_channels[0], { provider_subscribed_at: "subscribed", activation_requested_at: "intent", is_active: true });
    h.remote.subscribed = action === "datafy_pause";
    h.remote.paused = action === "datafy_pause";
    expect((await h.run(action)).status).toBe(200);
    expect(h.tables.whatsapp_channels[0].is_active).toBe(false);
    expect(h.tables.whatsapp_channels[0].activation_requested_at).toBeNull();
    await h.runEcho();
    expect(h.tables.whatsapp_channels[0].is_active).toBe(false);
    expect(h.calls).not.toContain("rpc:activate_whatsapp_channel:");
  });
  it("controle positivo: o bloco real de eco ativa quando assinatura e intenção são elegíveis", async () => {
    const h = harness({ state: "completed", withChannel: true });
    Object.assign(h.tables.whatsapp_channels[0], { provider_subscribed_at: "subscribed", activation_requested_at: "intent" });
    await h.runEcho();
    expect(h.tables.whatsapp_channels[0].is_active).toBe(true);
    expect(h.calls).toContain("rpc:activate_whatsapp_channel:");
  });
  it("abandonar durante subscribe não libera uma segunda cerca após novo grant", async () => {
    const h = harness({ state: "connected", withChannel: true });
    let competingStatus = 0;
    h.duringPost(async () => {
      await h.run("revoke_official_connection");
      h.tables[GRANTS].push({ ...grant(), id: "new-grant" });
      competingStatus = (await h.run("datafy_subscribe")).status;
    });
    expect((await h.run("official_connect_confirm")).status).toBe(200);
    expect(competingStatus).toBe(409);
    expect(h.client.subscribe).toHaveBeenCalledTimes(1);
    expect(h.tables[ONBOARDINGS][0].state).toBe("abandoned");
    expect(h.tables.whatsapp_channels[0].is_active).toBe(false);
  });
  it("incerteza no terminal continua na fence histórica e não cobra novamente após GET", async () => {
    const h = harness({ state: "abandoned", withChannel: true, subscribed: true });
    h.tables[ONBOARDINGS][0].uncertain_steps = ["subscribe"];
    h.tables[ONBOARDINGS][0].channel_token = null; h.tables[ONBOARDINGS][0].webhook_secret = null;
    expect((await h.run("datafy_subscribe")).status).toBe(200);
    expect(h.client.subscribe).not.toHaveBeenCalled();
    expect(h.tables[ONBOARDINGS][0]).toMatchObject({ state: "abandoned", grant_id: "grant-a", uncertain_steps: [], channel_token: null });
    expect(h.tables[GRANTS][0].consumed_channel_id).toBe(channelId);
    expect(h.calls).toContain("rpc:release_datafy_onboarding_step:reconciled_present");
  });
  it("relink entre load e claim muda o pin antes do POST: remoto anterior nunca é cobrado", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    h.beforeClaim(async () => {
      expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(200);
    });
    expect((await h.run("datafy_subscribe")).status).toBe(200);
    expect(h.client.subscribe).toHaveBeenCalledWith("remote-b");
    expect(h.client.subscribe).not.toHaveBeenCalledWith("remote-a");
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ external_instance_id: "remote-b", template_credential_revision: 1 });
  });
  it.each(["datafy_subscribe", "datafy_cancel"])("relink durante %s é recusado, sem trocar identidade da tentativa", async (action) => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    let relinkStatus = 0;
    h.duringPost(async () => { relinkStatus = (await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status; });
    expect((await h.run(action)).status).toBe(200);
    expect(relinkStatus).toBe(409);
    expect(h.tables.whatsapp_channels[0].external_instance_id).toBe("remote-a");
  });
  it("relink entre GET e projeção é recusado pela mesma exclusão", async () => {
    const h = harness({ state: "completed", withChannel: true, subscribed: true }); h.remote.id = "remote-b";
    let relinkStatus = 0;
    h.beforeProjection(async () => { relinkStatus = (await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status; });
    expect((await h.run("datafy_cancel")).status).toBe(200);
    expect(relinkStatus).toBe(409); expect(h.tables.whatsapp_channels[0].external_instance_id).toBe("remote-a");
  });
  it("dono antigo do onboarding não apaga cancel/pausa depois de takeover na mesma geração", async () => {
    const h = harness({ state: "connected", withChannel: true });
    h.beforeProjection(async () => {
      Object.assign(h.tables[ONBOARDINGS][0], { claim_id: null, state: "completed" });
      Object.assign(h.tables.whatsapp_channels[0], { provider_subscribed_at: null, provider_subscription_canceled_at: "successor-cancel",
        provider_paused_at: "successor-pause", is_active: false, activation_requested_at: null });
    });
    expect((await h.run("official_connect_confirm")).status).toBe(503);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ provider_subscribed_at: null, provider_subscription_canceled_at: "successor-cancel",
      provider_paused_at: "successor-pause", activation_requested_at: null, is_active: false });
    expect(h.tables[GRANTS][0].consumed_at).toBeNull();
  });
  it("segunda reivindicação busy após reconciled_absent mantém 409 e não libera fence velha", async () => {
    const h = harness({ state: "open" }); h.tables[ONBOARDINGS][0].uncertain_steps = ["create_channel"];
    vi.mocked(h.client.listChannels).mockResolvedValue({ ok: true, value: { accountSubscription: null, channels: [] } });
    h.secondClaimBusy();
    const response = await h.run("official_connect_start");
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "ONBOARDING_BUSY" });
    expect(h.calls.filter((call) => call.startsWith("rpc:release_datafy_onboarding_step:"))).toEqual(["rpc:release_datafy_onboarding_step:reconciled_absent"]);
    expect(h.client.createChannel).not.toHaveBeenCalled();
  });
  it("cancel incerto impede relink até GET do mesmo remoto reconciliar a operação anterior", async () => {
    const h = harness({ state: "completed", withChannel: true });
    vi.mocked(h.client.cancel).mockResolvedValueOnce({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect((await h.run("datafy_cancel")).status).toBe(503);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ datafy_subscription_uncertain: true, datafy_subscription_uncertain_operation: "cancel" });
    h.remote.id = "remote-b";
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(200);
    expect(h.calls.indexOf("get:remote-a")).toBeLessThan(h.calls.indexOf("rpc:apply_datafy_channel_relink:"));
    expect(h.tables.whatsapp_channels[0].datafy_subscription_uncertain).toBe(false);
  });
  it("webhook incerto conserva operação ao falhar GET de outra ação e reconcilia antes de subscribe", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    vi.mocked(h.client.createWebhook).mockResolvedValueOnce({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(503);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ datafy_subscription_uncertain: true, datafy_subscription_uncertain_operation: "configure_webhook" });
    vi.mocked(h.client.getChannel).mockResolvedValueOnce({ ok: false, kind: "transport", httpStatus: null, code: "DATAFY_TRANSPORT" });
    expect((await h.run("datafy_subscribe")).status).toBe(503);
    expect(h.tables.whatsapp_channels[0].datafy_subscription_uncertain_operation).toBe("configure_webhook");
    expect(h.client.subscribe).not.toHaveBeenCalled();
    h.remote.webhooks.push({ id: "hook-reconciled", url: `https://project.test/functions/v1/webhook-whatsapp?channel=${channelId}`, enabled: true, events: ["messages", "smb_message_echoes"] });
    expect((await h.run("datafy_subscribe")).status).toBe(200);
    expect(h.calls.indexOf("rpc:release_datafy_existing_subscription:reconciled_present")).toBeLessThan(h.calls.indexOf("subscribe"));
  });
  it("webhook aceito com projeção falha mantém configure_webhook incerto", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    h.missWrite("whatsapp_channels");
    expect((await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" })).status).toBe(503);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ datafy_subscription_uncertain: true, datafy_subscription_uncertain_operation: "configure_webhook" });
  });
  it("claim após relink não configura webhook sobre operação incerta que ganhou a janela", async () => {
    const h = harness({ state: "completed", withChannel: true }); h.remote.id = "remote-b";
    const rpc = h.client.listChannels;
    vi.mocked(rpc).mockImplementationOnce(async () => {
      h.beforeClaim(async () => {
        Object.assign(h.tables.whatsapp_channels[0], { datafy_subscription_uncertain: true, datafy_subscription_uncertain_operation: "subscribe" });
      });
      return { ok: true, value: { accountSubscription: null, channels: [{ ...h.remote }] } };
    });
    const response = await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" });
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "DATAFY_RECONCILIATION_REQUIRED" });
    expect(h.client.createWebhook).not.toHaveBeenCalled();
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ datafy_subscription_uncertain: true, datafy_subscription_uncertain_operation: "subscribe" });
  });
  it("preview → primeiro link de legado com pin NULL persiste o ID descoberto", async () => {
    const h = harness({ noOnboarding: true, withChannel: true });
    h.tables.whatsapp_channels[0].external_instance_id = null;
    const preview = await h.run("datafy_link_existing");
    expect(preview.status).toBe(200); expect(preview.body).toMatchObject({ candidates: [{ expectedDatafyChannelId: "remote-a" }] });
    expect(h.tables.whatsapp_channels[0].external_instance_id).toBeNull();
    const linked = await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-a" });
    expect(linked.status).toBe(200);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ external_instance_id: "remote-a", template_credential_revision: 1 });
    expect(h.client.createWebhook).toHaveBeenCalledWith("remote-a", expect.anything());
  });
  it.each([null, "remote-a"])("crash de relink antes do writer recupera pin antigo %s sem GET cego nem fence órfã", async (oldId) => {
    const h = harness({ noOnboarding: true, withChannel: true }); h.remote.id = "remote-b";
    Object.assign(h.tables.whatsapp_channels[0], { external_instance_id: oldId, expired: true,
      datafy_subscription_claim_id: "crashed-relink", datafy_subscription_operation: "relink" });
    const linked = await h.run("datafy_link_existing", { phase: "link", expected_datafy_channel_id: "remote-b" });
    expect(linked.status).toBe(200);
    expect(h.calls.indexOf("rpc:release_datafy_existing_subscription:reconciled_absent")).toBeLessThan(h.calls.indexOf("rpc:apply_datafy_channel_relink:"));
    expect(h.client.getChannel).not.toHaveBeenCalledWith(oldId);
    expect(h.tables.whatsapp_channels[0]).toMatchObject({ external_instance_id: "remote-b", template_credential_revision: 1,
      datafy_subscription_claim_id: null, datafy_subscription_uncertain: false });
  });
  it.each(["datafy_subscribe", "datafy_cancel", "datafy_pause", "datafy_resume"])("%s continua recusando ID remoto ausente antes de HTTP", async (action) => {
    const h = harness({ noOnboarding: true, withChannel: true }); h.tables.whatsapp_channels[0].external_instance_id = null;
    const response = await h.run(action);
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "DATAFY_CHANNEL_NOT_LINKED" });
    expect(h.client.getChannel).not.toHaveBeenCalled(); expect(h.client.subscribe).not.toHaveBeenCalled();
    expect(h.client.cancel).not.toHaveBeenCalled(); expect(h.client.pause).not.toHaveBeenCalled(); expect(h.client.resume).not.toHaveBeenCalled();
  });
});

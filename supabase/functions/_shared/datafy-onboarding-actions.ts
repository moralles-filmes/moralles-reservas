/** I/O do parceiro Datafy. O entrypoint autentica; os núcleos decidem. */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { DatafyAccountTokenRead } from "./datafy-account-config-core.ts";
import {
  createDatafyAdminClient, datafyMutationMayHaveApplied,
  type DatafyAdminClient, type DatafyAdminResult, type DatafyChannelSnapshot,
} from "./datafy-admin-client.ts";
import {
  decideStartStep, decideConfirm, decideSubscribeStep, deriveOfficialChecklist,
  decideChannelReconciliation, decideAdoptedCredentials, isDisposableRemoteChannel,
  type OnboardingState, type SubscribeGrantState,
} from "./datafy-onboarding-core.ts";

const ONBOARDINGS = "whatsapp_datafy_onboardings";
const GRANTS = "whatsapp_official_connection_grants";
const LIVE = ["open", "channel_created", "webhook_ready", "connected"];
export const DATAFY_ACTIONS = new Set([
  "grant_official_connection", "revoke_official_connection", "official_connection_state",
  "official_connect_start", "official_connect_confirm", "datafy_subscribe", "datafy_cancel",
  "datafy_pause", "datafy_resume", "datafy_link_existing",
]);
type Onboarding = {
  id: string; unit_id: string; organization_id: string; grant_id: string | null;
  reserved_channel_id: string; datafy_channel_id: string | null; datafy_webhook_id: string | null;
  channel_token: string | null; webhook_secret: string | null; state: OnboardingState;
};
type Grant = { id: string; revoked_at: string | null; consumed_at: string | null; consumed_channel_id: string | null };
type Channel = {
  id: string; unit_id: string; external_instance_id: string | null; credentials: Record<string, string>;
  webhook_secret: string | null; status: string; is_active: boolean | null;
  provider_subscribed_at: string | null; provider_subscription_canceled_at: string | null;
  provider_paused_at: string | null; manual_echo_verified_at: string | null; activation_requested_at: string | null;
};
type Claim = { claimed: boolean; claim_id: string; must_reconcile: boolean; source?: "onboarding" | "channel"; onboarding_id?: string };
type Outcome = "succeeded" | "failed" | "uncertain" | "reconciled_absent" | "reconciled_present";
export type DatafyActionResult = { body: unknown; status: number; headers?: Record<string, string> };
export type DatafyOperationalEvent = {
  evt: "datafy_subscription_failed"; unitId: string; channelId: string; reason: string;
};
export interface DatafyActionDeps {
  supabase: SupabaseClient;
  getAccountToken(): Promise<DatafyAccountTokenRead>;
  getOrganizationId(unitId: string): Promise<string>;
  gatesAllowed(unitId: string, adminDecisionRecorded: boolean): Promise<boolean>;
  projectUrl: string;
  createClient?: (token: string) => DatafyAdminClient;
  emitEvent(event: DatafyOperationalEvent): void | Promise<void>;
  logCleanupFailure?: () => void;
}
class ActionFailure extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
const result = (body: unknown, status = 200): DatafyActionResult => ({ body, status });
const rows = <T>(data: unknown): T[] => Array.isArray(data) ? data as T[] : data ? [data as T] : [];
const first = <T>(data: unknown): T | null => rows<T>(data)[0] ?? null;
const trimAnchor = (value: unknown): string | null => typeof value === "string"
  ? value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") || null : typeof value === "number" ? String(value) : null;

export function createDatafyOnboardingActions(deps: DatafyActionDeps) {
  const db = deps.supabase;
  const now = () => new Date().toISOString();
  const webhookUrl = (id: string) => `${deps.projectUrl.replace(/\/$/, "")}/functions/v1/webhook-whatsapp?channel=${id}`;
  async function checked(query: PromiseLike<{ data: unknown; error: unknown }>, code = "DATAFY_PERSIST_FAILED") {
    const { data, error } = await query;
    if (error || rows(data).length !== 1) throw new ActionFailure(code);
    return data;
  }
  async function loadOnboarding(unitId: string, liveOnly = true): Promise<Onboarding | null> {
    let query = db.from(ONBOARDINGS).select("*").eq("unit_id", unitId);
    if (liveOnly) query = query.in("state", LIVE);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new ActionFailure("ONBOARDING_READ_FAILED");
    return data as Onboarding | null;
  }
  async function activeGrant(unitId: string): Promise<Grant | null> {
    const { data, error } = await db.from(GRANTS).select("id, revoked_at, consumed_at, consumed_channel_id")
      .eq("unit_id", unitId).is("revoked_at", null).is("consumed_at", null).maybeSingle();
    if (error) throw new ActionFailure("GRANT_READ_FAILED");
    return data as Grant | null;
  }
  async function grantById(unitId: string, id: string | null): Promise<Grant | null> {
    if (!id) return null;
    const { data, error } = await db.from(GRANTS).select("id, revoked_at, consumed_at, consumed_channel_id")
      .eq("unit_id", unitId).eq("id", id).maybeSingle();
    if (error) throw new ActionFailure("GRANT_READ_FAILED");
    return data as Grant | null;
  }
  const grantState = (grant: Grant | null, channelId: string): SubscribeGrantState => !grant || grant.revoked_at
    ? "none" : grant.consumed_channel_id === channelId ? "consumed_by_this_channel" : !grant.consumed_at ? "active" : "none";
  async function loadChannel(unitId: string, id?: string): Promise<Channel | null> {
    // Campos de lease NÃO entram na projeção nem no DTO.
    let query = db.from("whatsapp_channels").select("id, unit_id, external_instance_id, credentials, webhook_secret, status, is_active, provider_subscribed_at, provider_subscription_canceled_at, provider_paused_at, manual_echo_verified_at, activation_requested_at")
      .eq("unit_id", unitId).eq("provider", "datafy");
    if (id) query = query.eq("id", id);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new ActionFailure("CHANNEL_READ_FAILED");
    return data as Channel | null;
  }
  async function patchOnboarding(o: Onboarding, patch: Record<string, unknown>, claim?: Claim) {
    let query = db.from(ONBOARDINGS).update(patch).eq("id", o.id).eq("unit_id", o.unit_id).in("state", LIVE);
    if (claim) query = query.eq("claim_id", claim.claim_id);
    await checked(query.select("id"), "ONBOARDING_PERSIST_FAILED");
  }
  async function claimStep(o: Onboarding, step: string, actorId: string): Promise<Claim> {
    const { data, error } = await db.rpc("claim_datafy_onboarding_step", {
      p_onboarding_id: o.id, p_unit_id: o.unit_id, p_step: step, p_actor_id: actorId,
    });
    if (error) throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
    const claim = first<Claim>(data);
    if (claim?.claimed === false) throw new ActionFailure("ONBOARDING_BUSY", 409);
    if (claim?.claimed !== true || !claim.claim_id || typeof claim.must_reconcile !== "boolean") throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
    return { ...claim, source: "onboarding", onboarding_id: o.id };
  }
  async function release(o: Onboarding | null, unitId: string, channelId: string, claim: Claim, step: string, outcome: Outcome, code: string | null = null) {
    const rpc = claim.source === "channel" ? "release_datafy_existing_subscription" : "release_datafy_onboarding_step";
    const args = claim.source === "channel"
      ? { p_channel_id: channelId, p_unit_id: unitId, p_claim_id: claim.claim_id, p_outcome: outcome, p_error_code: code }
      : { p_onboarding_id: o?.id ?? claim.onboarding_id, p_unit_id: unitId, p_claim_id: claim.claim_id, p_step: step, p_outcome: outcome, p_error_code: code };
    const { data, error } = await db.rpc(rpc, args);
    if (error || data !== true) throw new ActionFailure("ONBOARDING_RELEASE_FAILED");
  }
  async function remote(client: DatafyAdminClient, id: string): Promise<DatafyChannelSnapshot | null> {
    const response = await client.getChannel(id);
    if (response.ok === false) {
      if (response.kind === "not_found") return null;
      throw new ActionFailure("DATAFY_UNAVAILABLE");
    }
    return response.value;
  }
  async function deleteDisposable(client: DatafyAdminClient, id: string) {
    // GET imediatamente antes do DELETE; listagem nunca autoriza destruição.
    const snapshot = await remote(client, id);
    if (!snapshot) return;
    if (!isDisposableRemoteChannel(snapshot)) throw new ActionFailure("DATAFY_CHANNEL_NOT_DISPOSABLE", 409);
    const deleted = await client.deleteChannel(id);
    if (deleted.ok === false && deleted.kind !== "not_found") throw new ActionFailure("DATAFY_UNAVAILABLE");
  }
  async function state(unitId: string) {
    const [grant, o, channel, adopted] = await Promise.all([
      activeGrant(unitId), loadOnboarding(unitId, false), loadChannel(unitId),
      db.from("whatsapp_automation_adoptions").select("unit_id").eq("unit_id", unitId).maybeSingle(),
    ]);
    if (adopted.error) throw new ActionFailure("DATAFY_STATE_UNAVAILABLE");
    const revoked = !grant && o?.state === "abandoned" && channel && !channel.provider_subscribed_at;
    const checklist = deriveOfficialChecklist({
      grantActive: !!grant, onboardingState: o?.state ?? null,
      channel: channel ? { status: channel.status, isActive: channel.is_active,
        subscribedAt: channel.provider_subscribed_at, echoVerifiedAt: channel.manual_echo_verified_at,
        activationRequestedAt: channel.activation_requested_at } : null,
      automationDispatchAdopted: !!adopted.data,
    });
    return { ...checklist, ...(revoked ? { step: "not_granted" } : {}), granted: !!grant,
      onboardingState: o?.state ?? null, ...(revoked ? { connectionRevoked: true } : {}) };
  }
  async function startConnection(client: DatafyAdminClient, unitId: string, actorId: string) {
    for (let iteration = 0; iteration < 6; iteration++) {
      const [grant, o, active] = await Promise.all([
        activeGrant(unitId), loadOnboarding(unitId),
        db.from("whatsapp_channels").select("id").eq("unit_id", unitId).eq("is_active", true).maybeSingle(),
      ]);
      if (active.error) throw new ActionFailure("CHANNEL_READ_FAILED");
      const gatesAllowed = await deps.gatesAllowed(unitId, !!grant);
      const grantActive = !!grant && (!o || grant.id === o.grant_id);
      if (!grantActive || !gatesAllowed || active.data) {
        const refused = decideStartStep({ grantActive, gatesAllowed, unitHasActiveChannel: !!active.data, onboarding: null, remote: null });
        if (refused.kind === "refuse") throw new ActionFailure(refused.code, 409);
      }
      const snapshot = o?.datafy_channel_id ? await remote(client, o.datafy_channel_id) : null;
      const decision = decideStartStep({ grantActive, gatesAllowed, unitHasActiveChannel: !!active.data,
        onboarding: o ? { state: o.state, datafyChannelId: o.datafy_channel_id, datafyWebhookId: o.datafy_webhook_id } : null,
        remote: o?.datafy_channel_id ? { found: !!snapshot, phoneNumberId: snapshot?.phoneNumberId ?? null,
          subscribed: snapshot?.subscribed ?? false, onTrial: snapshot?.onTrial ?? false } : null });
      if (decision.kind === "refuse") throw new ActionFailure(decision.code, 409);
      if (decision.kind === "open_onboarding") {
        const { error } = await db.from(ONBOARDINGS).insert({ unit_id: unitId,
          organization_id: await deps.getOrganizationId(unitId), grant_id: grant!.id });
        if (error && error.code !== "23505") throw new ActionFailure("ONBOARDING_OPEN_FAILED");
        continue;
      }
      if (!o) throw new ActionFailure("ONBOARDING_READ_FAILED");
      if (decision.kind === "go_confirm") return result({ next: "confirm" });
      if (decision.kind === "recreate_channel") {
        const oldId = o.datafy_channel_id!;
        if (snapshot) await deleteDisposable(client, oldId);
        await checked(db.from(ONBOARDINGS).update({ state: "open", datafy_channel_id: null,
          channel_token: null, webhook_secret: null, datafy_webhook_id: null })
          .eq("id", o.id).eq("unit_id", unitId).eq("datafy_channel_id", oldId).in("state", ["channel_created", "webhook_ready"]).select("id"));
        continue;
      }
      if (decision.kind === "create_channel") {
        let claim = await claimStep(o, "create_channel", actorId);
        try {
          if (claim.must_reconcile) {
            const listed = await client.listChannels();
            if (listed.ok === false) throw new ActionFailure("DATAFY_UNAVAILABLE");
            const reconciliation = decideChannelReconciliation({ reservedChannelId: o.reserved_channel_id, channels: listed.value.channels });
            if (reconciliation.kind === "ambiguous") throw new ActionFailure("DATAFY_RECONCILE_AMBIGUOUS", 409);
            if (reconciliation.kind === "adopt") {
              const adopted = await remote(client, reconciliation.channelId);
              if (adopted) {
                const credentials = decideAdoptedCredentials(adopted);
                if (credentials.kind === "refuse") throw new ActionFailure(credentials.code, 409);
                if (credentials.kind === "use") {
                  await patchOnboarding(o, { datafy_channel_id: adopted.id, channel_token: credentials.token,
                    webhook_secret: credentials.webhookSecret, state: "channel_created" }, claim);
                  await release(o, unitId, o.reserved_channel_id, claim, "create_channel", "reconciled_present");
                  for (const id of reconciliation.discard) {
                    try { await deleteDisposable(client, id); } catch { deps.logCleanupFailure?.(); }
                  }
                  continue;
                }
                await deleteDisposable(client, adopted.id);
              }
            }
            await release(o, unitId, o.reserved_channel_id, claim, "create_channel", "reconciled_absent");
            claim = await claimStep(o, "create_channel", actorId);
            if (claim.must_reconcile) throw new ActionFailure("ONBOARDING_BUSY", 409);
          }
          const created = await client.createChannel({ name: o.reserved_channel_id, description: `unit:${unitId}` });
          if (created.ok === false) {
            await release(o, unitId, o.reserved_channel_id, claim, "create_channel",
              datafyMutationMayHaveApplied(created.kind) ? "uncertain" : "failed", created.code);
            return result({ error: "Não foi possível criar a conexão agora.", code: created.code }, 503);
          }
          await patchOnboarding(o, { datafy_channel_id: created.value.id, channel_token: created.value.token,
            webhook_secret: created.value.webhookSecret, state: "channel_created" }, claim);
          await release(o, unitId, o.reserved_channel_id, claim, "create_channel", "succeeded");
        } catch (error) {
          // failed conserva a reconciliação pendente; um POST aceito com falha
          // local também exige GET antes da próxima tentativa.
          await release(o, unitId, o.reserved_channel_id, claim, "create_channel",
            claim.must_reconcile ? "failed" : "uncertain", error instanceof ActionFailure ? error.code : "DATAFY_PERSIST_FAILED");
          throw error;
        }
        continue;
      }
      if (decision.kind === "create_webhook") {
        const claim = await claimStep(o, "create_webhook", actorId);
        try {
          const fresh = await remote(client, o.datafy_channel_id!);
          if (!fresh) throw new ActionFailure("REMOTE_CHANNEL_MISSING", 409);
          const existing = fresh.webhooks.find((hook) => hook.url === webhookUrl(o.reserved_channel_id)
            && hook.enabled && ["messages", "smb_message_echoes"].every((event) => hook.events.includes(event)));
          let webhookId = existing?.id;
          if (!webhookId) {
            if (claim.must_reconcile) {
              await release(o, unitId, o.reserved_channel_id, claim, "create_webhook", "reconciled_absent");
              // Uma nova requisição reivindica a cerca antes de postar.
              continue;
            }
            const created = await client.createWebhook(o.datafy_channel_id!, {
              url: webhookUrl(o.reserved_channel_id), events: ["messages", "smb_message_echoes"],
            });
            if (created.ok === false) {
              await release(o, unitId, o.reserved_channel_id, claim, "create_webhook",
                datafyMutationMayHaveApplied(created.kind) ? "uncertain" : "failed", created.code);
              return result({ error: "Não foi possível preparar a conexão.", code: created.code }, 503);
            }
            webhookId = created.value.webhookId;
          }
          await patchOnboarding(o, { datafy_webhook_id: webhookId, state: "webhook_ready" }, claim);
          await release(o, unitId, o.reserved_channel_id, claim, "create_webhook", existing ? "reconciled_present" : "succeeded");
        } catch (error) {
          await release(o, unitId, o.reserved_channel_id, claim, "create_webhook", "uncertain", "DATAFY_WEBHOOK_FAILED");
          throw error;
        }
        continue;
      }
      const link = await client.createConnectLink(o.datafy_channel_id!);
      if (link.ok === false) throw new ActionFailure(link.kind === "conflict" ? "DATAFY_LINK_REFUSED" : "DATAFY_UNAVAILABLE", link.kind === "conflict" ? 409 : 503);
      await patchOnboarding(o, { last_link_at: now() });
      return { ...result({ url: link.value.url }), headers: { "Cache-Control": "no-store" } };
    }
    throw new ActionFailure("ONBOARDING_BUSY", 409);
  }
  async function identities(unitId: string, o: Onboarding, snapshot: DatafyChannelSnapshot) {
    const organizationId = await deps.getOrganizationId(unitId);
    const anchors: { id: string; credentials: Record<string, unknown>; units: { organization_id: string } | { organization_id: string }[] }[] = [];
    // Equivalente EXATO de btrim(..., E' \\t\\r\\n') do índice; .eq no JSON
    // cru perderia canais legados com espaços. A leitura global serve só à
    // recusa de colisões e não é devolvida ao caller.
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from("whatsapp_channels").select("id, credentials, units!inner(organization_id)")
        .in("provider", ["official", "datafy"]).neq("id", o.reserved_channel_id).range(offset, offset + 499);
      if (error) throw new ActionFailure("DATAFY_IDENTITY_UNAVAILABLE");
      anchors.push(...(data ?? []) as unknown as typeof anchors);
      if ((data ?? []).length < 500) break;
    }
    const { data: accounts, error } = await db.from("whatsapp_template_accounts").select("id")
      .eq("waba_id", snapshot.wabaId).neq("organization_id", organizationId).limit(1);
    if (error) throw new ActionFailure("DATAFY_IDENTITY_UNAVAILABLE");
    return {
      phoneNumberIdTakenByOtherChannel: anchors.some((row) => trimAnchor(row.credentials?.phone_number_id) === snapshot.phoneNumberId),
      wabaOwnedByOtherOrganization: !!accounts?.length || anchors.some((row) => {
        const unit = Array.isArray(row.units) ? row.units[0] : row.units;
        return unit?.organization_id !== organizationId && trimAnchor(row.credentials?.business_account_id) === snapshot.wabaId;
      }),
    };
  }
  async function recordSubscription(unitId: string, channel: Channel, snapshot: DatafyChannelSnapshot, claim?: Claim) {
    let query = db.from("whatsapp_channels").update({
      provider_subscribed_at: snapshot.subscribed ? channel.provider_subscribed_at ?? now() : null,
      provider_subscription_canceled_at: snapshot.subscribed ? null : channel.provider_subscription_canceled_at ?? now(),
      provider_paused_at: snapshot.paused ? channel.provider_paused_at ?? now() : null,
      ...(!snapshot.subscribed || snapshot.paused ? {
        is_active: false, activation_requested_at: null, activation_requested_by: null,
      } : {}),
    }).eq("id", channel.id).eq("unit_id", unitId);
    if (claim?.source === "channel") query = query.eq("datafy_subscription_claim_id", claim.claim_id);
    await checked(query.select("id"));
  }
  async function finalize(unitId: string, channel: Channel, o: Onboarding | null, grant: Grant, claim: Claim, actorId: string, requestId: string) {
    if (grantState(grant, channel.id) === "active") {
      await checked(db.from(GRANTS).update({ consumed_channel_id: channel.id, consumed_at: now() })
        .eq("id", grant.id).eq("unit_id", unitId).is("revoked_at", null).is("consumed_at", null).select("id"), "GRANT_CONSUME_FAILED");
    }
    // Intenção só depois da assinatura confirmada. RPC continua autoridade.
    const fresh = await loadChannel(unitId, channel.id);
    if (!fresh) throw new ActionFailure("CHANNEL_READ_FAILED");
    const operable = !!fresh.provider_subscribed_at && !fresh.provider_subscription_canceled_at && !fresh.provider_paused_at;
    if (operable && !fresh.is_active && !fresh.activation_requested_at) {
      const { data, error } = await db.rpc("request_whatsapp_channel_activation", {
        p_unit_id: unitId, p_channel_id: channel.id, p_actor_id: actorId, p_request_id: requestId,
      });
      if (error || !first(data)) throw new ActionFailure("ACTIVATION_REQUEST_FAILED");
    }
    // Ativa antes de fechar: falha na RPC mantém confirm reexecutável.
    const activating = await loadChannel(unitId, channel.id);
    if (!activating) throw new ActionFailure("CHANNEL_READ_FAILED");
    if (!activating.is_active && activating.provider_subscribed_at && !activating.provider_subscription_canceled_at
      && !activating.provider_paused_at && activating.manual_echo_verified_at && activating.activation_requested_at && activating.status === "connected") {
      const { error } = await db.rpc("activate_whatsapp_channel", {
        p_unit_id: unitId, p_channel_id: channel.id, p_actor_id: actorId, p_request_id: requestId,
      });
      if (error) throw new ActionFailure("ACTIVATION_RECONCILIATION_REQUIRED");
    }
    if (o) await patchOnboarding(o, { state: "completed", completed_at: now(), channel_token: null, webhook_secret: null }, claim);
  }
  async function subscribeChannel(client: DatafyAdminClient, unitId: string, channel: Channel, o: Onboarding | null,
    actorId: string, requestId: string, admin = false, reconciliationAttempts = 0): Promise<DatafyActionResult> {
    let claim: Claim;
    if (admin) {
      const { data, error } = await db.rpc("claim_datafy_existing_subscription", {
        p_channel_id: channel.id, p_unit_id: unitId, p_actor_id: actorId,
      });
      if (error) throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
      const claimed = first<Claim>(data);
      if (claimed?.claimed === false) throw new ActionFailure("ONBOARDING_BUSY", 409);
      if (claimed?.claimed !== true || !claimed.claim_id || typeof claimed.must_reconcile !== "boolean"
        || !["onboarding", "channel"].includes(claimed.source)) throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
      claim = claimed;
      if (claim.source === "channel") o = null;
      if (claim.source === "onboarding" && (!o || o.id !== claim.onboarding_id)) {
        o = await loadOnboarding(unitId);
        if (!o || o.id !== claim.onboarding_id || o.reserved_channel_id !== channel.id) throw new ActionFailure("ONBOARDING_READ_FAILED");
      }
    } else claim = await claimStep(o!, "subscribe", actorId);
    let released = false;
    try {
      // Sempre NOVO GET depois do claim, inclusive quando o confirm já leu.
      let snapshot = await remote(client, channel.external_instance_id!);
      let grant = admin ? await activeGrant(unitId) : await grantById(unitId, o!.grant_id);
      if (admin && !grant) {
        const { data, error } = await db.from(GRANTS).select("id, revoked_at, consumed_at, consumed_channel_id")
          .eq("unit_id", unitId).eq("consumed_channel_id", channel.id).is("revoked_at", null).order("consumed_at", { ascending: false }).limit(1).maybeSingle();
        if (error) throw new ActionFailure("GRANT_READ_FAILED");
        grant = data as Grant | null;
      }
      const currentGrantState = grantState(grant, channel.id);
      const decision = decideSubscribeStep({ grant: currentGrantState,
        gatesAllowed: await deps.gatesAllowed(unitId, currentGrantState !== "none"),
        remote: { found: !!snapshot, subscribed: snapshot?.subscribed ?? false } });
      if (decision.kind === "refuse") {
        await release(o, unitId, channel.id, claim, "subscribe", "failed", decision.code); released = true;
        throw new ActionFailure(decision.code, 409);
      }
      if (decision.kind === "record_subscription") {
        await recordSubscription(unitId, channel, snapshot!, claim);
        await release(o, unitId, channel.id, claim, "subscribe", "reconciled_present", decision.code); released = true;
        await deps.emitEvent({ evt: "datafy_subscription_failed", unitId, channelId: channel.id, reason: decision.code });
        return result({ step: "subscription_pending", code: decision.code });
      }
      if (decision.kind === "subscribe") {
        if (claim.must_reconcile) {
          await release(o, unitId, channel.id, claim, "subscribe", "reconciled_absent"); released = true;
          if (reconciliationAttempts >= 2) throw new ActionFailure("ONBOARDING_BUSY", 409);
          return subscribeChannel(client, unitId, channel, o, actorId, requestId, admin, reconciliationAttempts + 1);
        }
        const subscribed = await client.subscribe(channel.external_instance_id!);
        if (subscribed.ok === false) {
          const uncertain = datafyMutationMayHaveApplied(subscribed.kind);
          await release(o, unitId, channel.id, claim, "subscribe", uncertain ? "uncertain" : "failed", subscribed.code); released = true;
          if (uncertain) throw new ActionFailure(subscribed.code);
          if (!["payment_declined", "conflict", "account_inactive"].includes(subscribed.kind)) throw new ActionFailure(subscribed.code);
          await deps.emitEvent({ evt: "datafy_subscription_failed", unitId, channelId: channel.id, reason: subscribed.code });
          return result({ step: "subscription_pending", code: subscribed.code });
        }
        snapshot = await remote(client, channel.external_instance_id!);
        if (!snapshot?.subscribed) {
          await release(o, unitId, channel.id, claim, "subscribe", snapshot ? "failed" : "uncertain", "DATAFY_SUBSCRIPTION_UNCONFIRMED"); released = true;
          await deps.emitEvent({ evt: "datafy_subscription_failed", unitId, channelId: channel.id, reason: "DATAFY_SUBSCRIPTION_UNCONFIRMED" });
          return result({ step: "subscription_pending" }, snapshot ? 200 : 503);
        }
      }
      await recordSubscription(unitId, channel, snapshot!, claim);
      // Revalidar liberação e gates depois do POST: revogação durante a
      // chamada não apaga o fato remoto e nunca habilita o canal.
      const finalGrant = await grantById(unitId, grant!.id);
      const finalDecision = decideSubscribeStep({ grant: grantState(finalGrant, channel.id),
        gatesAllowed: await deps.gatesAllowed(unitId, grantState(finalGrant, channel.id) !== "none"),
        remote: { found: true, subscribed: true } });
      if (finalDecision.kind === "already_subscribed") {
        await finalize(unitId, channel, o, finalGrant!, claim, actorId, requestId);
      } else {
        await deps.emitEvent({ evt: "datafy_subscription_failed", unitId, channelId: channel.id,
          reason: finalDecision.kind === "record_subscription" ? finalDecision.code : "GRANT_REQUIRED" });
      }
      await release(o, unitId, channel.id, claim, "subscribe", claim.must_reconcile || decision.kind === "already_subscribed" ? "reconciled_present" : "succeeded"); released = true;
      return result(await state(unitId));
    } catch (error) {
      if (!released) await release(o, unitId, channel.id, claim, "subscribe", "uncertain", error instanceof ActionFailure ? error.code : "DATAFY_SUBSCRIPTION_FAILED");
      throw error;
    }
  }
  async function confirmConnection(client: DatafyAdminClient, unitId: string, actorId: string, requestId: string) {
    const o = await loadOnboarding(unitId);
    if (!o) {
      const latest = await loadOnboarding(unitId, false);
      if (latest?.state === "completed") return result(await state(unitId));
      throw new ActionFailure("ONBOARDING_NOT_FOUND", 409);
    }
    if (!["webhook_ready", "connected"].includes(o.state)) throw new ActionFailure("ONBOARDING_NOT_READY", 409);
    if (o.state === "webhook_ready") {
      const grant = await activeGrant(unitId);
      const gatesAllowed = await deps.gatesAllowed(unitId, !!grant);
      // Núcleo recusa gates antes de qualquer leitura remota.
      const preflight = decideConfirm({ grantActive: !!grant && grant.id === o.grant_id, gatesAllowed,
        remote: { found: false, phoneNumberId: null, wabaId: null, businessId: null },
        phoneNumberIdTakenByOtherChannel: false, wabaOwnedByOtherOrganization: false });
      if (preflight.kind === "refuse" && ["GRANT_REQUIRED", "PROVISIONING_BLOCKED"].includes(preflight.code)) throw new ActionFailure(preflight.code, 409);
      const snapshot = await remote(client, o.datafy_channel_id!);
      const collision = snapshot?.phoneNumberId && snapshot?.wabaId ? await identities(unitId, o, snapshot)
        : { phoneNumberIdTakenByOtherChannel: false, wabaOwnedByOtherOrganization: false };
      const decision = decideConfirm({ grantActive: !!grant && grant.id === o.grant_id, gatesAllowed,
        remote: { found: !!snapshot, phoneNumberId: snapshot?.phoneNumberId ?? null,
          wabaId: snapshot?.wabaId ?? null, businessId: snapshot?.businessId ?? null }, ...collision });
      if (decision.kind === "refuse") throw new ActionFailure(decision.code, 409);
      if (decision.kind === "not_connected_yet") return result({ step: "connecting" });
      if (!o.channel_token || !o.webhook_secret) throw new ActionFailure("DATAFY_CREDENTIALS_UNAVAILABLE", 409);
      const { error } = await db.from("whatsapp_channels").insert({
        id: o.reserved_channel_id, unit_id: unitId, provider: "datafy",
        credentials: { access_token: o.channel_token, phone_number_id: decision.phoneNumberId, business_account_id: decision.wabaId },
        webhook_secret: o.webhook_secret, external_instance_id: o.datafy_channel_id,
        status: "connected", is_active: false, async_ingestion_enabled: true, display_phone: snapshot?.displayPhone,
      });
      if (error) {
        if (error.code !== "23505") throw new ActionFailure("CHANNEL_CREATE_FAILED");
        const existing = await loadChannel(unitId, o.reserved_channel_id);
        if (!existing || existing.external_instance_id !== o.datafy_channel_id
          || trimAnchor(existing.credentials?.phone_number_id) !== decision.phoneNumberId
          || trimAnchor(existing.credentials?.business_account_id) !== decision.wabaId) throw new ActionFailure("PHONE_NUMBER_ALREADY_BOUND", 409);
      }
      await patchOnboarding(o, { state: "connected" });
      o.state = "connected";
    }
    const channel = await loadChannel(unitId, o.reserved_channel_id);
    if (!channel || channel.external_instance_id !== o.datafy_channel_id) throw new ActionFailure("CHANNEL_READ_FAILED");
    return subscribeChannel(client, unitId, channel, o, actorId, requestId);
  }
  async function linkExisting(client: DatafyAdminClient, unitId: string, body: Record<string, unknown>, channel: Channel, actorId: string, requestId: string) {
    const phoneNumberId = trimAnchor(channel.credentials?.phone_number_id);
    if (!phoneNumberId) throw new ActionFailure("REMOTE_IDENTITY_INCOMPLETE", 409);
    const listed = await client.listChannels();
    if (listed.ok === false) throw new ActionFailure("DATAFY_UNAVAILABLE");
    const candidates = listed.value.channels.filter((candidate) => candidate.phoneNumberId === phoneNumberId);
    if (body.phase !== "link") {
      const previews = [];
      for (const candidate of candidates) {
        const snapshot = await remote(client, candidate.id);
        if (!snapshot || snapshot.phoneNumberId !== phoneNumberId) continue;
        previews.push({ name: snapshot.name, expectedDatafyChannelId: snapshot.id, idPrefix: snapshot.id.slice(0, 8), subscribed: snapshot.subscribed,
          paused: snapshot.paused, webhookHosts: snapshot.webhooks.map((hook) => {
            try { return new URL(hook.url).hostname; } catch { return "inválido"; }
          }) });
      }
      return result({ candidates: previews });
    }
    const expected = body.expected_datafy_channel_id;
    if (typeof expected !== "string" || !candidates.some((candidate) => candidate.id === expected)) throw new ActionFailure("DATAFY_LINK_CANDIDATE_REQUIRED", 409);
    const snapshot = await remote(client, expected);
    if (!snapshot || snapshot.phoneNumberId !== phoneNumberId || !snapshot.token || !snapshot.webhookSecret) throw new ActionFailure("DATAFY_CREDENTIALS_UNAVAILABLE", 409);
    // Troca das credenciais desativa na mesma escrita (trigger de paridade).
    await checked(db.from("whatsapp_channels").update({ external_instance_id: snapshot.id,
      credentials: { ...channel.credentials, access_token: snapshot.token }, webhook_secret: snapshot.webhookSecret,
      is_active: false, manual_echo_verified_at: null, manual_echo_verification_source: null,
      activation_requested_at: null }).eq("id", channel.id).eq("unit_id", unitId).select("id"));
    if (!snapshot.webhooks.some((hook) => hook.url === webhookUrl(channel.id) && hook.enabled
      && ["messages", "smb_message_echoes"].every((event) => hook.events.includes(event)))) {
      const created = await client.createWebhook(snapshot.id, { url: webhookUrl(channel.id), events: ["messages", "smb_message_echoes"] });
      if (created.ok === false) throw new ActionFailure("DATAFY_WEBHOOK_FAILED");
    }
    await recordSubscription(unitId, channel, snapshot);
    // Canal em trial não pode ganhar intenção de ativação só por vinculação.
    if (snapshot.subscribed && !snapshot.paused) {
      const { data, error } = await db.rpc("request_whatsapp_channel_activation", {
        p_unit_id: unitId, p_channel_id: channel.id, p_actor_id: actorId, p_request_id: requestId,
      });
      if (error || !first(data)) throw new ActionFailure("ACTIVATION_REQUEST_FAILED");
    }
    return result({ success: true });
  }
  async function handle(action: string, unitId: string, actorId: string, requestId: string, body: Record<string, unknown>): Promise<DatafyActionResult> {
    try {
      if (action === "official_connection_state") return result(await state(unitId));
      if (action === "grant_official_connection") {
        if (!await activeGrant(unitId)) {
          const { error } = await db.from(GRANTS).insert({ unit_id: unitId,
            organization_id: await deps.getOrganizationId(unitId), granted_by: actorId });
          if (error && error.code !== "23505") throw new ActionFailure("GRANT_CREATE_FAILED");
          if (!await activeGrant(unitId)) throw new ActionFailure("GRANT_CREATE_FAILED");
        }
        return result(await state(unitId));
      }
      if (action === "revoke_official_connection") {
        const [grant, o] = await Promise.all([activeGrant(unitId), loadOnboarding(unitId)]);
        if (grant) await checked(db.from(GRANTS).update({ revoked_at: now(), revoked_by: actorId })
          .eq("id", grant.id).eq("unit_id", unitId).is("consumed_at", null).is("revoked_at", null).select("id"), "GRANT_REVOKE_FAILED");
        if (o) await patchOnboarding(o, { state: "abandoned", abandoned_at: now(), channel_token: null, webhook_secret: null });
        return result({ ...await state(unitId), remoteCancellationRequested: false,
          message: "Liberação revogada. O canal permanece inativo; o trial expira automaticamente." });
      }
      if (action === "official_connect_confirm" && !await loadOnboarding(unitId)) {
        const latest = await loadOnboarding(unitId, false);
        if (latest?.state === "completed") return result(await state(unitId));
      }
      const token = await deps.getAccountToken();
      if (token.ok === false) throw new ActionFailure("DATAFY_ACCOUNT_UNAVAILABLE");
      const client = deps.createClient ? deps.createClient(token.token) : createDatafyAdminClient({ token: token.token });
      if (action === "official_connect_start") return await startConnection(client, unitId, actorId);
      if (action === "official_connect_confirm") return await confirmConnection(client, unitId, actorId, requestId);
      const channel = await loadChannel(unitId);
      if (!channel) throw new ActionFailure("CHANNEL_NOT_FOUND", 404);
      if (action === "datafy_link_existing") return await linkExisting(client, unitId, body, channel, actorId, requestId);
      if (!channel.external_instance_id) throw new ActionFailure("DATAFY_CHANNEL_NOT_LINKED", 409);
      if (action === "datafy_subscribe") return await subscribeChannel(client, unitId, channel, await loadOnboarding(unitId), actorId, requestId, true);
      let operation: DatafyAdminResult<{ acknowledged: true }>;
      if (action === "datafy_cancel") operation = await client.cancel(channel.external_instance_id);
      else if (action === "datafy_pause") operation = await client.pause(channel.external_instance_id);
      else if (action === "datafy_resume") operation = await client.resume(channel.external_instance_id);
      else throw new ActionFailure("INVALID_ACTION", 400);
      if (operation.ok === false) throw new ActionFailure(operation.code);
      const snapshot = await remote(client, channel.external_instance_id);
      if (!snapshot) throw new ActionFailure("REMOTE_CHANNEL_MISSING", 409);
      await recordSubscription(unitId, channel, snapshot);
      return result(await state(unitId));
    } catch (error) {
      return result({ error: "Não foi possível atualizar a conexão oficial. Tente novamente ou fale com o suporte.",
        code: error instanceof ActionFailure ? error.code : "DATAFY_ACTION_FAILED" }, error instanceof ActionFailure ? error.status : 503);
    }
  }
  return { handle };
}

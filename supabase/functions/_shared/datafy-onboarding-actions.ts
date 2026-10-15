/** I/O do parceiro Datafy. O entrypoint autentica; os núcleos decidem. */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { DatafyAccountTokenRead } from "./datafy-account-config-core.ts";
import { resolveUnitChannelBinding, type OrgChannelInput } from "./whatsapp-org-provider-core.ts";
import {
  createDatafyAdminClient, datafyMutationMayHaveApplied, DATAFY_ADMIN_MAX_TIMEOUT_MS,
  type DatafyAdminClient, type DatafyChannelSnapshot,
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
  claim_id: string | null; claim_step: string | null; uncertain_steps: string[];
};
type Grant = { id: string; revoked_at: string | null; consumed_at: string | null; consumed_channel_id: string | null };
type Channel = {
  id: string; unit_id: string; external_instance_id: string | null; credentials: Record<string, string>;
  webhook_secret: string | null; status: string; is_active: boolean | null;
  provider_subscribed_at: string | null; provider_subscription_canceled_at: string | null;
  provider_paused_at: string | null; manual_echo_verified_at: string | null; activation_requested_at: string | null;
  template_credential_revision: number;
};
type Operation = "subscribe" | "cancel" | "pause" | "resume" | "relink" | "configure_webhook";
type Claim = { claimed: boolean; claim_id: string; must_reconcile: boolean; deadline: number; source?: "onboarding" | "channel"; onboarding_id?: string; actor_id?: string;
  operation?: Operation; reconcile_operation?: Operation; external_instance_id?: string | null; template_credential_revision?: number };
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
  logUnrecognized?: (info: { operation: string; httpStatus: number; shape: unknown }) => void;
  monotonicNow?: () => number;
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
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const mutationBudgetMs = DATAFY_ADMIN_MAX_TIMEOUT_MS + 5_000;
  const webhookUrl = (id: string) => `${deps.projectUrl.replace(/\/$/, "")}/functions/v1/webhook-whatsapp?channel=${id}`;
  const hasRequiredWebhook = (snapshot: DatafyChannelSnapshot, id: string) => snapshot.webhooks.some((hook) =>
    hook.url === webhookUrl(id) && hook.enabled && hook.events.includes("messages") && hook.events.includes("smb_message_echoes"));
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
  async function onboardingById(unitId: string, id: string): Promise<Onboarding | null> {
    const { data, error } = await db.from(ONBOARDINGS).select("*").eq("id", id).eq("unit_id", unitId).maybeSingle();
    if (error) throw new ActionFailure("ONBOARDING_READ_FAILED");
    return data as Onboarding | null;
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
    let query = db.from("whatsapp_channels").select("id, unit_id, external_instance_id, credentials, webhook_secret, status, is_active, provider_subscribed_at, provider_subscription_canceled_at, provider_paused_at, manual_echo_verified_at, activation_requested_at, template_credential_revision")
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
    const deadline = monotonicNow() + 120_000;
    const { data, error } = await db.rpc("claim_datafy_onboarding_step", {
      p_onboarding_id: o.id, p_unit_id: o.unit_id, p_step: step, p_actor_id: actorId,
    });
    if (error) throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
    const claim = first<Claim>(data);
    if (claim?.claimed === false) throw new ActionFailure("ONBOARDING_BUSY", 409);
    if (claim?.claimed !== true || !claim.claim_id || typeof claim.must_reconcile !== "boolean") throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
    return { ...claim, deadline, source: "onboarding", onboarding_id: o.id, actor_id: actorId };
  }
  async function release(o: Onboarding | null, unitId: string, channelId: string, claim: Claim, step: string, outcome: Outcome, code: string | null = null) {
    const rpc = claim.source === "channel" ? "release_datafy_existing_subscription" : "release_datafy_onboarding_step";
    const args = claim.source === "channel"
      ? { p_channel_id: channelId, p_unit_id: unitId, p_claim_id: claim.claim_id, p_outcome: outcome, p_error_code: code }
      : { p_onboarding_id: o?.id ?? claim.onboarding_id, p_unit_id: unitId, p_claim_id: claim.claim_id, p_step: step, p_outcome: outcome, p_error_code: code };
    const { data, error } = await db.rpc(rpc, args);
    if (error || data !== true) throw new ActionFailure("ONBOARDING_RELEASE_FAILED");
  }
  async function claimOperation(unitId: string, channelId: string, actorId: string, operation: Operation): Promise<Claim> {
    const deadline = monotonicNow() + 120_000;
    const { data, error } = await db.rpc("claim_datafy_channel_operation", {
      p_channel_id: channelId, p_unit_id: unitId, p_actor_id: actorId, p_operation: operation,
    });
    if (error) throw new ActionFailure("DATAFY_OPERATION_CLAIM_FAILED", 409);
    const claim = first<Claim>(data);
    if (claim?.claimed === false) throw new ActionFailure("ONBOARDING_BUSY", 409);
    if (claim?.claimed !== true || !claim.claim_id || typeof claim.must_reconcile !== "boolean"
      || !["channel", "onboarding"].includes(claim.source)
      || (!claim.external_instance_id && !(operation === "relink" && claim.external_instance_id === null))
      || !Number.isSafeInteger(claim.template_credential_revision)) throw new ActionFailure("ONBOARDING_CLAIM_FAILED");
    return { ...claim, deadline, actor_id: actorId, operation };
  }
  // SQL owns TTL/fence/grant authority. Monotonic elapsed time only narrows
  // permission, including time spent awaiting this last database round-trip.
  // This cannot make a provider POST and a database transaction atomic.
  async function authorizeMutation(unitId: string, channelId: string, claim: Claim, operation: string,
    externalId: string | null, revision: number | null, grantId: string | null = null) {
    if (claim.deadline - monotonicNow() < mutationBudgetMs) throw new ActionFailure("DATAFY_CLAIM_EXPIRED", 409);
    const { data, error } = await db.rpc("authorize_datafy_mutation", {
      p_unit_id: unitId, p_channel_id: channelId, p_actor_id: claim.actor_id, p_claim_id: claim.claim_id,
      p_onboarding_id: claim.source === "onboarding" ? claim.onboarding_id : null,
      p_operation: operation, p_external_id: externalId, p_revision: revision, p_grant_id: grantId,
    });
    if (error || data !== true) throw new ActionFailure("DATAFY_MUTATION_NOT_AUTHORIZED", 409);
    if (claim.deadline - monotonicNow() < mutationBudgetMs) throw new ActionFailure("DATAFY_CLAIM_EXPIRED", 409);
  }
  async function assertDatafyBinding(unitId: string) {
    const { data, error } = await db.from("whatsapp_channels").select("provider, status, is_active, created_at").eq("unit_id", unitId);
    if (error) throw new ActionFailure("CHANNEL_READ_FAILED");
    const binding = resolveUnitChannelBinding(rows<OrgChannelInput>(data));
    if (binding && binding.provider !== "datafy") throw new ActionFailure("DATAFY_MIGRATION_NOT_SUPPORTED", 409);
  }
  async function freshStep(o: Onboarding, claim: Claim, step: "create_channel" | "create_webhook") {
    const fresh = await onboardingById(o.unit_id, o.id);
    if (!fresh) throw new ActionFailure("ONBOARDING_READ_FAILED");
    const expected = step === "create_channel" ? fresh.state === "open" && !fresh.datafy_channel_id
      : fresh.state === "channel_created" && fresh.datafy_channel_id === o.datafy_channel_id;
    if (!expected) {
      await release(o, o.unit_id, o.reserved_channel_id, claim, step, "failed");
      return null;
    }
    return fresh;
  }
  async function reconcileAdvancedSteps(client: DatafyAdminClient, initial: Onboarding, actorId: string): Promise<Onboarding> {
    let o = initial;
    let missingPublishedResource: string | null = null;
    for (const step of ["create_channel", "create_webhook"] as const) {
      const advanced = step === "create_channel" ? ["channel_created", "webhook_ready", "connected"].includes(o.state)
        : ["webhook_ready", "connected"].includes(o.state);
      const resetWebhook = step === "create_webhook" && o.state === "open" && !o.datafy_channel_id;
      if ((!advanced && !resetWebhook) || !(o.uncertain_steps.includes(step) || (o.claim_id && o.claim_step === step))) continue;
      // A escrita de sucesso pode ter commitado antes do release. Reivindicar
      // o passo ORIGINAL conserva a pendência e a autoridade do mesmo histórico.
      const claim = await claimStep(o, step, actorId);
      let released = false;
      try {
        const current = await onboardingById(o.unit_id, o.id);
        if (!current || current.claim_id !== claim.claim_id || current.claim_step !== step
          || (!current.datafy_channel_id && !(step === "create_webhook" && current.state === "open"))) throw new ActionFailure("DATAFY_RECONCILIATION_REQUIRED", 409);
        // Reset cercado já persistido também prova ausência se o processo caiu
        // antes do release; não existe ID remoto a consultar nesse caso.
        const snapshot = current.datafy_channel_id ? await remote(client, current.datafy_channel_id) : null;
        if (snapshot && snapshot.id !== current.datafy_channel_id) throw new ActionFailure("DATAFY_IDENTITY_CHANGED", 409);
        const present = !!snapshot && (step === "create_channel" || snapshot.webhooks.some((hook) =>
          hook.id === current.datafy_webhook_id && hook.url === webhookUrl(current.reserved_channel_id)
          && hook.enabled && ["messages", "smb_message_echoes"].every((event) => hook.events.includes(event))));
        if (!present) {
          // Só ausência definitiva permite voltar ao estado reparável. GET com
          // timeout lança antes daqui, preservando identidade e incerteza.
          const published = await loadChannel(current.unit_id, current.reserved_channel_id);
          if (published) {
            // Identidade publicada pertence à autoridade de relink. Resolver
            // a pendência não autoriza recriar seu remoto por este fluxo.
            missingPublishedResource = snapshot ? "DATAFY_WEBHOOK_MISSING" : "REMOTE_CHANNEL_MISSING";
          } else if (snapshot || !current.uncertain_steps.some((pending) => pending !== step && ["create_channel", "create_webhook"].includes(pending))) {
            await patchOnboarding(current, snapshot ? { state: "channel_created", datafy_webhook_id: null }
              : { state: "open", datafy_channel_id: null, datafy_webhook_id: null, channel_token: null, webhook_secret: null }, claim);
          }
        }
        await release(current, current.unit_id, current.reserved_channel_id, claim, step, present ? "reconciled_present" : "reconciled_absent");
        released = true;
      } catch (error) {
        if (!released) await release(o, o.unit_id, o.reserved_channel_id, claim, step, "failed", "DATAFY_RECONCILIATION_FAILED");
        throw error;
      }
      const fresh = await onboardingById(o.unit_id, o.id);
      if (!fresh) throw new ActionFailure("ONBOARDING_READ_FAILED");
      o = fresh;
    }
    if (missingPublishedResource) throw new ActionFailure(missingPublishedResource, 409);
    return o;
  }
  async function claimedChannel(unitId: string, channelId: string, claim: Claim, o: Onboarding | null): Promise<Channel> {
    const channel = await loadChannel(unitId, channelId);
    const unlinkedRelink = claim.operation === "relink" && claim.external_instance_id === null && channel?.external_instance_id === null;
    if (!channel || (!channel.external_instance_id && !unlinkedRelink) || !Number.isSafeInteger(channel.template_credential_revision)
      || (claim.external_instance_id !== undefined && claim.external_instance_id !== channel.external_instance_id)
      || (claim.template_credential_revision !== undefined && claim.template_credential_revision !== channel.template_credential_revision)
      || (claim.source === "onboarding" && o?.datafy_channel_id !== channel.external_instance_id)) {
      throw new ActionFailure("DATAFY_IDENTITY_CHANGED", 409);
    }
    return channel;
  }
  async function reconcileOperation(client: DatafyAdminClient, unitId: string, channel: Channel, claim: Claim, o: Onboarding | null) {
    if (claim.reconcile_operation === "relink") {
      // O writer SQL troca identidade E encerra lease no mesmo commit. Lease
      // remanescente no takeover prova ausência; nova escrita exige novo claim.
      if (claim.source !== "channel") throw new ActionFailure("DATAFY_RECONCILIATION_REQUIRED", 409);
      await release(o, unitId, channel.id, claim, "subscribe", "reconciled_absent");
      return;
    }
    const snapshot = await remote(client, channel.external_instance_id!);
    if (snapshot) await recordSubscription(unitId, channel, snapshot, claim);
    const operation = claim.reconcile_operation;
    if (!operation) throw new ActionFailure("DATAFY_RECONCILIATION_REQUIRED", 409);
    const applied = !snapshot ? operation === "cancel" : operation === "subscribe" ? snapshot.subscribed
      : operation === "cancel" ? !snapshot.subscribed : operation === "pause" ? snapshot.paused
      : operation === "resume" ? !snapshot.paused : operation === "configure_webhook"
        ? snapshot.webhooks.some((hook) => hook.url === webhookUrl(channel.id) && hook.enabled
          && ["messages", "smb_message_echoes"].every((event) => hook.events.includes(event))) : false;
    await release(o, unitId, channel.id, claim, "subscribe", applied ? "reconciled_present" : "reconciled_absent");
  }
  async function remote(client: DatafyAdminClient, id: string): Promise<DatafyChannelSnapshot | null> {
    if (!id) throw new ActionFailure("DATAFY_CHANNEL_NOT_LINKED", 409);
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
      const [grant, o, channels] = await Promise.all([
        activeGrant(unitId), loadOnboarding(unitId),
        db.from("whatsapp_channels").select("provider, status, is_active, created_at").eq("unit_id", unitId),
      ]);
      if (channels.error) throw new ActionFailure("CHANNEL_READ_FAILED");
      const binding = resolveUnitChannelBinding(rows<OrgChannelInput>(channels.data));
      const gatesAllowed = await deps.gatesAllowed(unitId, !!grant);
      const grantActive = !!grant && (!o || grant.id === o.grant_id);
      if (!grantActive || !gatesAllowed || binding) {
        const refused = decideStartStep({ grantActive, gatesAllowed, unitHasActiveChannel: !!binding, onboarding: null, remote: null });
        if (refused.kind === "refuse") throw new ActionFailure(refused.code, 409);
      }
      if (o) Object.assign(o, await reconcileAdvancedSteps(client, o, actorId));
      const snapshot = o?.datafy_channel_id ? await remote(client, o.datafy_channel_id) : null;
      const decision = decideStartStep({ grantActive, gatesAllowed, unitHasActiveChannel: !!binding,
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
        let ownsClaim = true;
        try {
          const fresh = await freshStep(o, claim, "create_channel");
          if (!fresh) { ownsClaim = false; continue; }
          Object.assign(o, fresh);
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
                  ownsClaim = false;
                  for (const id of reconciliation.discard) {
                    try { await deleteDisposable(client, id); } catch { deps.logCleanupFailure?.(); }
                  }
                  continue;
                }
                await deleteDisposable(client, adopted.id);
              }
            }
            await release(o, unitId, o.reserved_channel_id, claim, "create_channel", "reconciled_absent");
            ownsClaim = false;
            claim = await claimStep(o, "create_channel", actorId);
            ownsClaim = true;
            if (claim.must_reconcile) throw new ActionFailure("ONBOARDING_BUSY", 409);
            const retryFresh = await freshStep(o, claim, "create_channel");
            if (!retryFresh) { ownsClaim = false; continue; }
            Object.assign(o, retryFresh);
          }
          await authorizeMutation(unitId, o.reserved_channel_id, claim, "create_channel", o.datafy_channel_id, null, o.grant_id);
          const created = await client.createChannel({ name: o.reserved_channel_id, description: `unit:${unitId}` });
          if (created.ok === false) {
            await release(o, unitId, o.reserved_channel_id, claim, "create_channel",
              datafyMutationMayHaveApplied(created.kind) ? "uncertain" : "failed", created.code);
            ownsClaim = false;
            return result({ error: "Não foi possível criar a conexão agora.", code: created.code }, 503);
          }
          await patchOnboarding(o, { datafy_channel_id: created.value.id, channel_token: created.value.token,
            webhook_secret: created.value.webhookSecret, state: "channel_created" }, claim);
          await release(o, unitId, o.reserved_channel_id, claim, "create_channel", "succeeded");
          ownsClaim = false;
        } catch (error) {
          // failed conserva a reconciliação pendente; um POST aceito com falha
          // local também exige GET antes da próxima tentativa.
          if (ownsClaim) await release(o, unitId, o.reserved_channel_id, claim, "create_channel",
            claim.must_reconcile ? "failed" : "uncertain", error instanceof ActionFailure ? error.code : "DATAFY_PERSIST_FAILED");
          throw error;
        }
        continue;
      }
      if (decision.kind === "create_webhook") {
        const claim = await claimStep(o, "create_webhook", actorId);
        try {
          const current = await freshStep(o, claim, "create_webhook");
          if (!current) continue;
          Object.assign(o, current);
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
            await authorizeMutation(unitId, o.reserved_channel_id, claim, "create_webhook", o.datafy_channel_id, null);
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
  async function recordSubscription(unitId: string, channel: Channel, snapshot: DatafyChannelSnapshot, claim: Claim) {
    const { data, error } = await db.rpc("record_datafy_channel_state", {
      p_channel_id: channel.id, p_unit_id: unitId, p_claim_id: claim.claim_id,
      p_actor_id: claim.actor_id,
      p_onboarding_id: claim.source === "onboarding" ? claim.onboarding_id : null,
      p_external_id: channel.external_instance_id, p_revision: channel.template_credential_revision,
      p_subscribed: snapshot.subscribed, p_paused: snapshot.paused,
    });
    if (error || data !== true) throw new ActionFailure("DATAFY_PROJECTION_FAILED");
  }
  async function finalize(unitId: string, channel: Channel, o: Onboarding | null, grant: Grant, claim: Claim, actorId: string, requestId: string) {
    const { data, error } = await db.rpc("finalize_datafy_channel_subscription", {
      p_channel_id: channel.id, p_unit_id: unitId, p_actor_id: actorId, p_claim_id: claim.claim_id,
      p_onboarding_id: o?.id ?? null, p_grant_id: grant.id, p_external_id: channel.external_instance_id,
      p_revision: channel.template_credential_revision, p_request_id: requestId,
    });
    if (error || (data !== "finalized" && data !== "grant_revoked")) throw new ActionFailure("DATAFY_FINALIZE_FAILED");
    if (data === "grant_revoked") await deps.emitEvent({ evt: "datafy_subscription_failed", unitId, channelId: channel.id, reason: "GRANT_REQUIRED" });
  }
  async function subscribeChannel(client: DatafyAdminClient, unitId: string, channel: Channel, o: Onboarding | null,
    actorId: string, requestId: string, admin = false, reconciliationAttempts = 0): Promise<DatafyActionResult> {
    if (o) o = await reconcileAdvancedSteps(client, o, actorId);
    let claim: Claim;
    if (admin) {
      claim = await claimOperation(unitId, channel.id, actorId, "subscribe");
      if (claim.source === "channel") o = null;
    } else claim = await claimStep(o!, "subscribe", actorId);
    let released = false;
    try {
      if (claim.source === "onboarding" && (!o || o.id !== claim.onboarding_id)) {
        o = await onboardingById(unitId, claim.onboarding_id!);
        if (!o || o.id !== claim.onboarding_id || o.reserved_channel_id !== channel.id) throw new ActionFailure("ONBOARDING_READ_FAILED");
      }
      channel = await claimedChannel(unitId, channel.id, claim, o);
      if (claim.must_reconcile && claim.reconcile_operation && claim.reconcile_operation !== "subscribe") {
        await reconcileOperation(client, unitId, channel, claim, o); released = true;
        if (reconciliationAttempts >= 2) throw new ActionFailure("ONBOARDING_BUSY", 409);
        return subscribeChannel(client, unitId, channel, o, actorId, requestId, admin, reconciliationAttempts + 1);
      }
      // Sempre NOVO GET depois do claim, inclusive quando o confirm já leu.
      let snapshot = await remote(client, channel.external_instance_id!);
      if (!snapshot && claim.must_reconcile) {
        // Definitive 404 resolves this attempt, not any historical cost fact.
        await release(o, unitId, channel.id, claim, "subscribe", "reconciled_absent", "REMOTE_CHANNEL_MISSING"); released = true;
        return result({ step: "channel_missing", code: "REMOTE_CHANNEL_MISSING" }, 409);
      }
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
        if (!hasRequiredWebhook(snapshot!, channel.id)) {
          await release(o, unitId, channel.id, claim, "subscribe", "failed", "DATAFY_WEBHOOK_MISSING"); released = true;
          return result({ step: "webhook_pending", code: "DATAFY_WEBHOOK_MISSING" }, 409);
        }
        await assertDatafyBinding(unitId);
        await authorizeMutation(unitId, channel.id, claim, "subscribe", channel.external_instance_id, channel.template_credential_revision, grant!.id);
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
        // Registrar custo aceito antes de recusar ativação; cada retry valida o
        // webhook no GET sob claim, mesmo após encerrar a incerteza original.
        if (!hasRequiredWebhook(snapshot!, channel.id)) {
          await release(o, unitId, channel.id, claim, "subscribe", "reconciled_present", "DATAFY_WEBHOOK_MISSING"); released = true;
          return result({ step: "webhook_pending", code: "DATAFY_WEBHOOK_MISSING" }, 409);
        }
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
    await assertDatafyBinding(unitId);
    const o = await loadOnboarding(unitId);
    if (!o) {
      const latest = await loadOnboarding(unitId, false);
      if (latest?.state === "completed") return result(await state(unitId));
      throw new ActionFailure("ONBOARDING_NOT_FOUND", 409);
    }
    Object.assign(o, await reconcileAdvancedSteps(client, o, actorId));
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
        status: "connected", is_active: false, datafy_subscription_required: true, async_ingestion_enabled: true, display_phone: snapshot?.displayPhone,
      });
      if (error) {
        if (error.code === "PT409") throw new ActionFailure("WABA_OWNED_BY_OTHER_ORG", 409);
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
  async function linkExisting(client: DatafyAdminClient, unitId: string, body: Record<string, unknown>, channel: Channel, actorId: string, requestId: string, attempt = 0): Promise<DatafyActionResult> {
    let claim: Claim | null = null, released = false, postedWebhook = false;
    try {
    if (body.phase === "link") {
      claim = await claimOperation(unitId, channel.id, actorId, "relink");
      channel = await claimedChannel(unitId, channel.id, claim, null);
      if (claim.must_reconcile) {
        await reconcileOperation(client, unitId, channel, claim, null); released = true;
        if (attempt >= 2) throw new ActionFailure("ONBOARDING_BUSY", 409);
        return linkExisting(client, unitId, body, channel, actorId, requestId, attempt + 1);
      }
    }
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
    const { data: linked, error: linkError } = await db.rpc("apply_datafy_channel_relink", {
      p_channel_id: channel.id, p_unit_id: unitId, p_actor_id: actorId, p_claim_id: claim!.claim_id,
      p_expected_external_id: channel.external_instance_id, p_expected_revision: channel.template_credential_revision,
      p_external_id: snapshot.id, p_channel_token: snapshot.token, p_webhook_secret: snapshot.webhookSecret,
    });
    if (linkError || !first(linked)) throw new ActionFailure("DATAFY_RELINK_FAILED");
    released = true;
    // O writer SQL encerrou o lease atomicamente com as credenciais. Antes do
    // próximo I/O, cercar de novo a identidade efetivamente vinculada.
    const linkedPin = first<{ external_instance_id: string; template_credential_revision: number }>(linked)!;
    claim = await claimOperation(unitId, channel.id, actorId, "configure_webhook"); released = false;
    channel = await claimedChannel(unitId, channel.id, claim, null);
    // Outra operação pode ter ganho a janela entre os dois leases. Não emitir
    // webhook enquanto sua operação incerta ainda aguarda reconciliação.
    if (claim.must_reconcile) throw new ActionFailure("DATAFY_RECONCILIATION_REQUIRED", 409);
    if (channel.external_instance_id !== linkedPin.external_instance_id || channel.template_credential_revision !== linkedPin.template_credential_revision) {
      throw new ActionFailure("DATAFY_IDENTITY_CHANGED", 409);
    }
    const current = await remote(client, channel.external_instance_id!);
    if (!current) throw new ActionFailure("REMOTE_CHANNEL_MISSING", 409);
    if (!current.webhooks.some((hook) => hook.url === webhookUrl(channel.id) && hook.enabled
      && ["messages", "smb_message_echoes"].every((event) => hook.events.includes(event)))) {
      await authorizeMutation(unitId, channel.id, claim, "configure_webhook", channel.external_instance_id, channel.template_credential_revision);
      postedWebhook = true;
      const created = await client.createWebhook(channel.external_instance_id!, { url: webhookUrl(channel.id), events: ["messages", "smb_message_echoes"] });
      if (created.ok === false) {
        await release(null, unitId, channel.id, claim, "subscribe", datafyMutationMayHaveApplied(created.kind) ? "uncertain" : "failed", created.code); released = true;
        throw new ActionFailure("DATAFY_WEBHOOK_FAILED");
      }
    }
    await recordSubscription(unitId, channel, current, claim);
    // Canal em trial não pode ganhar intenção de ativação só por vinculação.
    if (current.subscribed && !current.paused) {
      const { data, error } = await db.rpc("finalize_datafy_channel_subscription", {
        p_unit_id: unitId, p_channel_id: channel.id, p_actor_id: actorId, p_request_id: requestId,
        p_claim_id: claim.claim_id, p_onboarding_id: null, p_grant_id: null,
        p_external_id: channel.external_instance_id, p_revision: channel.template_credential_revision,
      });
      if (error || data !== "finalized") throw new ActionFailure("ACTIVATION_REQUEST_FAILED");
    }
    await release(null, unitId, channel.id, claim, "subscribe", "succeeded"); released = true;
    return result({ success: true });
    } catch (error) {
      if (claim && !released) await release(null, unitId, channel.id, claim, "subscribe", postedWebhook ? "uncertain" : "failed", "DATAFY_RELINK_FAILED");
      throw error;
    }
  }
  async function lifecycleOperation(client: DatafyAdminClient, unitId: string, initial: Channel, actorId: string,
    operation: "cancel" | "pause" | "resume", attempt = 0): Promise<DatafyActionResult> {
    const claim = await claimOperation(unitId, initial.id, actorId, operation);
    let released = false, posted = false;
    try {
      const channel = await claimedChannel(unitId, initial.id, claim, null);
      if (claim.must_reconcile) {
        await reconcileOperation(client, unitId, channel, claim, null); released = true;
        if (attempt >= 2) throw new ActionFailure("ONBOARDING_BUSY", 409);
        return lifecycleOperation(client, unitId, channel, actorId, operation, attempt + 1);
      }
      await authorizeMutation(unitId, channel.id, claim, operation, channel.external_instance_id, channel.template_credential_revision);
      posted = true;
      const response = await client[operation](channel.external_instance_id!);
      if (response.ok === false) {
        await release(null, unitId, channel.id, claim, "subscribe", datafyMutationMayHaveApplied(response.kind) ? "uncertain" : "failed", response.code); released = true;
        throw new ActionFailure(response.code);
      }
      const snapshot = await remote(client, channel.external_instance_id!);
      if (!snapshot) throw new ActionFailure("REMOTE_CHANNEL_MISSING", 409);
      await recordSubscription(unitId, channel, snapshot, claim);
      await release(null, unitId, channel.id, claim, "subscribe", "succeeded"); released = true;
      return result(await state(unitId));
    } catch (error) {
      if (!released) await release(null, unitId, initial.id, claim, "subscribe", posted ? "uncertain" : "failed", "DATAFY_OPERATION_FAILED");
      throw error;
    }
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
      const client = deps.createClient ? deps.createClient(token.token) : createDatafyAdminClient({ token: token.token, onUnrecognized: deps.logUnrecognized });
      if (action === "official_connect_start") return await startConnection(client, unitId, actorId);
      if (action === "official_connect_confirm") return await confirmConnection(client, unitId, actorId, requestId);
      const channel = await loadChannel(unitId);
      if (!channel) throw new ActionFailure("CHANNEL_NOT_FOUND", 404);
      if (action === "datafy_link_existing") return await linkExisting(client, unitId, body, channel, actorId, requestId);
      if (!channel.external_instance_id) throw new ActionFailure("DATAFY_CHANNEL_NOT_LINKED", 409);
      if (action === "datafy_subscribe") return await subscribeChannel(client, unitId, channel, await loadOnboarding(unitId), actorId, requestId, true);
      if (action === "datafy_cancel" || action === "datafy_pause" || action === "datafy_resume") {
        return await lifecycleOperation(client, unitId, channel, actorId, action.slice(7) as "cancel" | "pause" | "resume");
      }
      throw new ActionFailure("INVALID_ACTION", 400);
    } catch (error) {
      return result({ error: "Não foi possível atualizar a conexão oficial. Tente novamente ou fale com o suporte.",
        code: error instanceof ActionFailure ? error.code : "DATAFY_ACTION_FAILED" }, error instanceof ActionFailure ? error.status : 503);
    }
  }
  return { handle };
}

import { MESSAGE_TTL_MS } from './whatsapp-message-ttl-core.ts';
import { TEMPLATE_CATALOG, type TemplateId } from './whatsapp-template-catalog-core.ts';

/** Closed ledger kind list; the SQL CHECK and twin test compare against this source. */
export const SCHEDULED_KINDS = ['confirmation', 'reminder_d1', 'survey_d1', 'waitlist_entered', 'waitlist_feedback', 'voucher_issued', 'cancellation', 'waitlist_table_ready'] as const;
export type ScheduledKind = typeof SCHEDULED_KINDS[number];
export type AutomationKind = ScheduledKind;
type IntentOrigin = { unitId: string; sourceEventKey: string; factAt: string };
export type ScheduledIntent = IntentOrigin & (
  | { kind: 'confirmation' | 'reminder_d1' | 'survey_d1' | 'cancellation'; reservationId: string; waitlistId?: never; voucherId?: never }
  | { kind: 'waitlist_entered' | 'waitlist_feedback' | 'waitlist_table_ready'; waitlistId: string; reservationId?: never; voucherId?: never }
  | { kind: 'voucher_issued'; voucherId: string; reservationId?: never; waitlistId?: never }
);
export type DispatchSelection = 'scheduled' | 'paused' | 'legacy';
export type DispatchResult =
  | { state: 'not_enqueued'; jobId: null; reason: 'adoption_required' | 'producer_before_adoption' | 'legacy_already_accepted' | 'authorization_refused' | 'resource_refused' | 'provenance_refused' | 'intent_invalid' | 'dependency_unavailable' }
  | { state: 'accepted'; pinPhase: 'bound'; jobId: string; providerMessageId?: string }
  | { state: 'queued' | 'blocked' | 'expired' | 'uncertain' | 'needs_review' | 'failed' | 'reconciled'; pinPhase: 'bound'; jobId: string; reason: string }
  | { state: 'blocked' | 'expired' | 'needs_review'; pinPhase: 'preconfiguration'; jobId: string; reason: string };
export const AUTOMATION_POST_TIMEOUT_MS = 15_000;

export const AUTOMATION_PREFLIGHT_REASONS = [
  'reservation_pending', 'payment_incompatible', 'reservation_not_confirmed', 'reservation_not_cancelled', 'reservation_changed', 'reservation_past', 'reservation_wrong_day',
  'survey_already_answered', 'waitlist_not_waiting', 'waitlist_not_seated', 'waitlist_wrong_day', 'waitlist_changed',
  'voucher_not_active', 'voucher_expired', 'voucher_changed', 'customer_not_alive', 'recipient_changed', 'do_not_contact',
  'invalid_timezone', 'service_suspended', 'channel_unavailable', 'channel_changed', 'binding_changed', 'dispatch_paused',
  'consent_changed', 'cost_not_authorized', 'template_unavailable', 'template_sync_failed', 'render_invalid', 'dependency_unavailable', 'expired',
] as const;
export type AutomationPreflightReason = typeof AUTOMATION_PREFLIGHT_REASONS[number];
export function automationPreflightState(reason: AutomationPreflightReason, expired: boolean): 'expired' | 'paused' | 'needs_review' | 'blocked' {
  if (!AUTOMATION_PREFLIGHT_REASONS.includes(reason)) throw new Error('automation_preflight_reason_invalid');
  if (expired || reason === 'expired') return 'expired';
  if (reason === 'dispatch_paused') return 'paused';
  if (['reservation_changed', 'waitlist_changed', 'voucher_changed', 'recipient_changed', 'channel_changed', 'binding_changed'].includes(reason)) return 'needs_review';
  return 'blocked';
}

type NonpostState = 'blocked' | 'paused' | 'needs_review' | 'expired';
export type AutomationStoredState = NonpostState | 'queued' | 'claimed' | 'posting' | 'retry_wait' | 'rejected' | 'accepted' | 'uncertain' | 'failed' | 'reconciled';
type ChannelPins = { channelId: string; initialCredentialRevision: number } & (
  | {provider: 'official' | 'datafy'; transport: 'template'}
  | {provider: 'zapi' | 'waha' | 'uazapi'; transport: 'text'});
type NoTemplate = {remoteTemplateId: null; templateVersion: null; syncEpoch: null};
type NoBinding = {bindingId: null; bindingGeneration: null; accountId: null};
type IncompletePins = {initialCatalogKey: TemplateId} & (
  | ({shape: 'unselected'; channelId: null; provider: null; transport: null; initialCredentialRevision: null} & NoBinding & NoTemplate)
  | ({shape: 'unbound'} & ChannelPins & NoBinding & NoTemplate)
  | ({shape: 'missing_template'; channelId: string; provider: 'official' | 'datafy'; transport: 'template'; initialCredentialRevision: number; bindingId: string; bindingGeneration: number; accountId: string} & NoTemplate));
type BoundPins = {shape: 'complete'; channelId: string; bindingId: string; bindingGeneration: number; initialCredentialRevision: number | null; initialCatalogKey: TemplateId | null} & (
  | {transport: 'text'; provider: 'zapi' | 'waha' | 'uazapi'; accountId: null; remoteTemplateId: null; templateVersion: null; syncEpoch: null}
  | {transport: 'template'; provider: 'official' | 'datafy'; accountId: string; remoteTemplateId: string; templateVersion: number; syncEpoch: number});
export type AutomationLedger = {jobId: string; reason: string | null; providerMessageId: string | null} & (
  | {pinPhase: 'preconfiguration'; state: NonpostState; attempts: 0; pins: IncompletePins}
  | {pinPhase: 'bound'; state: AutomationStoredState; attempts: number; pins: BoundPins});

function invalidLedger(): never { throw new Error('automation_ledger_invalid'); }
function ledgerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nullableLedgerText(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : invalidLedger();
}
function ledgerUuid(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : invalidLedger();
}
function ledgerInteger(value: unknown, min: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : invalidLedger();
}
function ledgerState(value: unknown): AutomationStoredState {
  switch (value) {
    case 'queued': case 'claimed': case 'posting': case 'retry_wait': case 'paused': case 'rejected': case 'accepted': case 'blocked': case 'expired': case 'uncertain': case 'needs_review': case 'failed': case 'reconciled': return value;
    default: return invalidLedger();
  }
}
function catalogKey(value: unknown): TemplateId {
  for (const definition of Object.values(TEMPLATE_CATALOG)) if (definition.id === value) return definition.id;
  return invalidLedger();
}
/** Unknown DB/RPC data must pass here; SQL NULL is explicit, never undefined/coerced. */
export function parseAutomationLedger(value: unknown): AutomationLedger {
  if (!ledgerRecord(value)) return invalidLedger();
  const r: Record<string, unknown> = value;
  const jobId = ledgerUuid(r.id), state = ledgerState(r.state), attempts = ledgerInteger(r.attempts, 0);
  if (attempts > 5 || (r.error_code !== null && (typeof r.error_code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(r.error_code)))) return invalidLedger();
  const reason = nullableLedgerText(r.error_code);
  const providerMessageId = nullableLedgerText(r.provider_message_id);
  if (providerMessageId !== null && (typeof providerMessageId !== 'string' || !providerMessageId || providerMessageId.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(providerMessageId))) return invalidLedger();
  const initialCredentialRevision = r.initial_credential_revision === null ? null : ledgerInteger(r.initial_credential_revision, 0);
  const initialCatalogKey = r.initial_catalog_key === null ? null : catalogKey(r.initial_catalog_key);
  const common = {jobId, reason, providerMessageId};
  const noTemplate: NoTemplate = {remoteTemplateId:null, templateVersion:null, syncEpoch:null};
  const noBinding: NoBinding = {bindingId:null, bindingGeneration:null, accountId:null};
  if (r.pin_phase === 'preconfiguration') {
    if (!['blocked','paused','needs_review','expired'].includes(state) || attempts !== 0 || initialCatalogKey === null || r.reconcile_required !== false
      || ['claim_token','claimed_until','posting_started_at','provider_message_id','safe_log_body','consent_revision','cost_authorization_id','sync_epoch','remote_template_id','template_version'].some(key => r[key] !== null)) return invalidLedger();
    // Explicit switch retains the literal nonpost union in both TS nullability modes.
    if (state !== 'blocked' && state !== 'paused' && state !== 'needs_review' && state !== 'expired') return invalidLedger();
    const base = {...common, pinPhase:'preconfiguration' as const, state, attempts:0 as const};
    if (r.channel_id === null) {
      if (['provider','transport','binding_id','binding_generation','account_id','initial_credential_revision'].some(key => r[key] !== null)) return invalidLedger();
      return {...base, pins:{shape:'unselected',channelId:null,provider:null,transport:null,initialCredentialRevision:null,initialCatalogKey,...noBinding,...noTemplate}};
    }
    const channelId=ledgerUuid(r.channel_id);
    if (initialCredentialRevision === null) return invalidLedger();
    const provider=r.provider, transport=r.transport;
    if (r.binding_id === null) {
      if (r.binding_generation !== null || r.account_id !== null) return invalidLedger();
      if ((provider === 'official' || provider === 'datafy') && transport === 'template') return {...base,pins:{shape:'unbound',channelId,provider,transport,initialCredentialRevision,initialCatalogKey,...noBinding,...noTemplate}};
      if ((provider === 'zapi' || provider === 'waha' || provider === 'uazapi') && transport === 'text') return {...base,pins:{shape:'unbound',channelId,provider,transport,initialCredentialRevision,initialCatalogKey,...noBinding,...noTemplate}};
      return invalidLedger();
    }
    if ((provider !== 'official' && provider !== 'datafy') || transport !== 'template') return invalidLedger();
    return {...base,pins:{shape:'missing_template',channelId,provider,transport,initialCredentialRevision,initialCatalogKey,bindingId:ledgerUuid(r.binding_id),bindingGeneration:ledgerInteger(r.binding_generation,1),accountId:ledgerUuid(r.account_id),...noTemplate}};
  }
  if (r.pin_phase !== 'bound') return invalidLedger();
  const base={...common,pinPhase:'bound' as const,state,attempts};
  const pins={shape:'complete' as const,channelId:ledgerUuid(r.channel_id),bindingId:ledgerUuid(r.binding_id),bindingGeneration:ledgerInteger(r.binding_generation,1),initialCredentialRevision,initialCatalogKey};
  const provider=r.provider, transport=r.transport;
  if ((provider === 'zapi' || provider === 'waha' || provider === 'uazapi') && transport === 'text') {
    if (['account_id','remote_template_id','template_version','sync_epoch'].some(key=>r[key]!==null)) return invalidLedger();
    return {...base,pins:{...pins,provider,transport,accountId:null,...noTemplate}};
  }
  if ((provider === 'official' || provider === 'datafy') && transport === 'template') return {...base,pins:{...pins,provider,transport,accountId:ledgerUuid(r.account_id),remoteTemplateId:ledgerUuid(r.remote_template_id),templateVersion:ledgerInteger(r.template_version,1),syncEpoch:ledgerInteger(r.sync_epoch,0)}};
  return invalidLedger();
}

export function recordedDispatchResult(row: AutomationLedger): DispatchResult {
  const reason=row.reason ?? row.state;
  if (row.pinPhase === 'preconfiguration') return {state:row.state === 'paused' ? 'blocked' : row.state,jobId:row.jobId,pinPhase:row.pinPhase,reason};
  const base={jobId:row.jobId,pinPhase:row.pinPhase,reason};
  switch (row.state) {
    case 'accepted': return {state:'accepted',jobId:row.jobId,pinPhase:'bound',...(row.providerMessageId === null ? {} : {providerMessageId:row.providerMessageId})};
    case 'queued': case 'claimed': case 'posting': case 'retry_wait': return {...base,state:'queued'};
    case 'paused': return {...base,state:'blocked'};
    case 'rejected': return {...base,state:'failed'};
    case 'blocked': case 'expired': case 'uncertain': case 'needs_review': case 'failed': case 'reconciled': return {...base,state:row.state};
    default: { const unreachable: never=row; return unreachable; }
  }
}

export function logicalAutomationKey(input: { unitId: string; kind: AutomationKind; reservationId?: string; waitlistId?: string; voucherId?: string; sourceEventKey?: string }): string {
  const resources = [input.reservationId, input.waitlistId, input.voucherId].filter(Boolean);
  const resource = ['confirmation', 'reminder_d1', 'survey_d1', 'cancellation'].includes(input.kind)
    ? input.reservationId : input.kind === 'voucher_issued' ? input.voucherId : input.waitlistId;
  if (!input.unitId || resources.length !== 1 || !resource) throw new Error('automation_resource_invalid');
  return JSON.stringify([input.unitId, input.kind, resource]);
}

export function selectAutomationPath(input: { ledgerExists: boolean; adoptedAt: string | null; enabled: boolean }): DispatchSelection {
  if (input.ledgerExists) return 'scheduled';
  if (input.enabled) return 'scheduled';
  if (input.adoptedAt) return 'paused';
  return 'legacy';
}

/** New intents require an explicit originating instant; retries retain this deadline. */
export function automationDeadline(kind: AutomationKind, factAt: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(factAt) || !Number.isFinite(Date.parse(factAt))) throw new Error('automation_fact_invalid');
  return new Date(Date.parse(factAt) + MESSAGE_TTL_MS[kind]).toISOString();
}

export type AutomationOutcome = { outcome: 'accepted'; reason: 'provider_accepted'; provider_message_id: string }
  | { outcome: 'rejected'; reason: 'documented_preproxy_429' }
  | { outcome: 'uncertain'; reason: 'response_invalid' | 'post_ambiguous' }
  | { outcome: 'local_preflight_refused'; reason: LocalPreflightReason };

export type LocalPreflightReason = 'final_service_suspended' | 'final_channel_changed' | 'final_consent_changed' | 'final_resource_changed' | 'final_gate_paused';
/** postAttempted is the dispatcher's own switch, never provider/body evidence. */
export function localPreflightRefusal(input: {postAttempted: boolean; reason: LocalPreflightReason}): AutomationOutcome | null {
  return input.postAttempted === false ? {outcome:'local_preflight_refused', reason:input.reason} : null;
}

/** Adapter must prove the documented Datafy preproxy envelope, not merely HTTP 429. */
export function classifyAutomationOutcome(input: { provider: string; status?: number; preproxyStatusCode?: number; messageId?: unknown }): AutomationOutcome {
  if (input.status !== undefined && input.status >= 200 && input.status < 300) {
    if (typeof input.messageId === 'string' && input.messageId.length > 0 && input.messageId.length <= 512 && !/[\x00-\x1f\x7f-\x9f]/.test(input.messageId)) {
      return { outcome: 'accepted', reason: 'provider_accepted', provider_message_id: input.messageId };
    }
    return { outcome: 'uncertain', reason: 'response_invalid' };
  }
  if (input.provider === 'datafy' && input.status === 429 && input.preproxyStatusCode === 429 && input.messageId == null) return { outcome: 'rejected', reason: 'documented_preproxy_429' };
  return { outcome: 'uncertain', reason: 'post_ambiguous' };
}

export function automationRetryDelayMs(postAttempts: number): number | null {
  return Number.isInteger(postAttempts) && postAttempts >= 1 && postAttempts < 5 ? 60_000 * 4 ** (postAttempts - 1) : null;
}

/** Worker-facing name; retry authority remains the existing single ladder. */
export const nextRetryDelay = automationRetryDelayMs;

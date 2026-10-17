import { AUTOMATION_PREFLIGHT_REASONS, parseAutomationLedger, selectAutomationPath,
  type AutomationStoredState, type DispatchResult } from './whatsapp-automation-core.ts';

type ReservationKind = 'confirmation' | 'reminder_d1' | 'survey_d1' | 'cancellation';
export type AutomationRouteReader = (table: string, columns: string,
  predicates: readonly (readonly [column: string, value: string])[], cardinality: 'single' | 'many') => Promise<unknown>;
export type ReservationAutomationRoute = { path: 'legacy' } | { path: 'dependency' }
  | { path: 'managed'; existingJobId: string | null; selection: 'scheduled' | 'paused' };
export const automationUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const instant = (v: unknown): v is string => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

/** Read-only selection. Existing evidence precedes volatile activation; this grants no ownership. */
export async function selectReservationAutomationRoute(read: AutomationRouteReader,
  input: { kind: ReservationKind; unitId: string; reservationId: string }): Promise<ReservationAutomationRoute> {
  try {
    if (!automationUuid(input.unitId) || !automationUuid(input.reservationId)) return { path: 'dependency' };
    const ledger = await read('whatsapp_automation_jobs', '*', [['unit_id', input.unitId],
      ['reservation_id', input.reservationId], ['kind', input.kind]], 'single');
    if (ledger !== null) {
      const row = ledger;
      if (!object(row) || row.unit_id !== input.unitId || row.reservation_id !== input.reservationId || row.kind !== input.kind)
        return { path: 'dependency' };
      const parsed = parseAutomationLedger(row);
      return { path: 'managed', existingJobId: parsed.jobId, selection: 'scheduled' };
    }
    return await selectUnownedAutomationRoute(read, input.unitId);
  } catch { return { path: 'dependency' }; }
}

/** The approved adoption/activation read is shared without granting dispatch authority. */
async function selectUnownedAutomationRoute(read: AutomationRouteReader, unitId: string): Promise<ReservationAutomationRoute> {
    const [adoption, flag, bindings] = await Promise.all([
      read('whatsapp_automation_adoptions', 'adopted_at', [['unit_id', unitId]], 'single'),
      read('platform_flags', 'value', [['key', 'whatsapp_automation_dispatch']], 'single'),
      read('whatsapp_template_bindings', 'dispatch_enabled,adopted_at', [['unit_id', unitId]], 'many'),
    ]);
    if (!Array.isArray(bindings)
      || (adoption !== null && (!object(adoption) || !instant(adoption.adopted_at)))
      || (flag !== null && (!object(flag) || typeof flag.value !== 'boolean'))
      || bindings.some(b => !object(b) || typeof b.dispatch_enabled !== 'boolean'
        || (b.adopted_at !== null && !instant(b.adopted_at)) || (b.dispatch_enabled && !instant(b.adopted_at)))) return { path: 'dependency' };
    const enabled = object(flag) && flag.value === true && bindings.some(b => b.dispatch_enabled === true);
    if (enabled && adoption === null) return { path: 'dependency' };
    const selection = selectAutomationPath({ ledgerExists: false, enabled,
      adoptedAt: object(adoption) ? adoption.adopted_at as string : null });
    return selection === 'legacy' ? { path: 'legacy' } : { path: 'managed', existingJobId: null, selection };
}

/** Exact waitlist ledger first; absence alone permits activation reads. */
export async function selectWaitlistAutomationRoute(read: AutomationRouteReader,
  input: { kind: 'waitlist_entered' | 'waitlist_feedback' | 'waitlist_table_ready'; unitId: string; waitlistId: string }): Promise<ReservationAutomationRoute> {
  try {
    if (!automationUuid(input.unitId) || !automationUuid(input.waitlistId)) return { path: 'dependency' };
    const row = await read('whatsapp_automation_jobs', '*', [['unit_id', input.unitId],
      ['waitlist_id', input.waitlistId], ['kind', input.kind]], 'single');
    if (row !== null) {
      if (!object(row) || row.unit_id !== input.unitId || row.waitlist_id !== input.waitlistId
        || row.reservation_id !== null || row.voucher_id !== null || row.kind !== input.kind) return { path: 'dependency' };
      const parsed = parseAutomationLedger(row);
      return { path: 'managed', existingJobId: parsed.jobId, selection: 'scheduled' };
    }
    return await selectUnownedAutomationRoute(read, input.unitId);
  } catch { return { path: 'dependency' }; }
}

const storedStates = ['queued','claimed','posting','retry_wait','blocked','paused','needs_review','uncertain',
  'accepted','reconciled','expired','rejected','failed'] as const;
const notEnqueuedReasons = ['adoption_required','producer_before_adoption','legacy_already_accepted','authorization_refused',
  'resource_refused','provenance_refused','intent_invalid','dependency_unavailable'];
const dispatchReasons: readonly string[] = [...AUTOMATION_PREFLIGHT_REASONS, ...storedStates,
  'local_acceptance_reconciled','acceptance_not_persisted','post_ambiguous','response_invalid','documented_preproxy_429',
  'final_service_suspended','final_channel_changed','final_consent_changed','final_resource_changed','final_gate_paused',
  'channel_missing','binding_missing','template_missing','configuration_incomplete'];
/** Closed transport result, never reconstructed into a stored ledger state. */
export function decodeAutomationDispatch(value: unknown): DispatchResult | null {
  if (!object(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (value.state === 'not_enqueued') return keys === 'jobId,reason,state' && value.jobId === null
    && typeof value.reason === 'string' && notEnqueuedReasons.includes(value.reason) ? value as DispatchResult : null;
  if (!automationUuid(value.jobId)) return null;
  if (value.state === 'accepted') return value.pinPhase === 'bound'
    && (keys === 'jobId,pinPhase,state' || (keys === 'jobId,pinPhase,providerMessageId,state'
      && typeof value.providerMessageId === 'string' && value.providerMessageId.length > 0 && value.providerMessageId.length <= 512
      && !/[\x00-\x1f\x7f-\x9f]/.test(value.providerMessageId))) ? value as DispatchResult : null;
  if (keys !== 'jobId,pinPhase,reason,state' || typeof value.reason !== 'string' || !dispatchReasons.includes(value.reason)) return null;
  const states = value.pinPhase === 'bound' ? ['queued','blocked','expired','uncertain','needs_review','failed','reconciled']
    : value.pinPhase === 'preconfiguration' ? ['blocked','expired','needs_review'] : [];
  return states.includes(String(value.state)) ? value as DispatchResult : null;
}

export type OutboxAutomationObservation = {
  ledger_state: AutomationStoredState | null;
  outbox_status: 'pending' | 'processing' | 'done' | 'dead';
  disposition: 'pending' | 'accepted' | 'discarded' | 'rejected' | 'failed' | 'suppressed' | 'dependency';
  reason: string; retry_after_seconds: 60 | null;
};
/** Validate the SQL five-key DTO and every correlation; SQL alone projects durable outcomes. */
export function decodeOutboxAutomationObservation(value: unknown): OutboxAutomationObservation | null {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'disposition,ledger_state,outbox_status,reason,retry_after_seconds') return null;
  const { ledger_state: state, outbox_status: status, disposition, reason, retry_after_seconds: retry } = value;
  if (state !== null) {
    if (typeof state !== 'string' || !storedStates.includes(state as AutomationStoredState) || reason !== `automation_${state}`) return null;
    if (['accepted','reconciled'].includes(state)) {
      if (status !== 'done' || disposition !== 'accepted' || retry !== null) return null;
    } else if (state === 'expired') {
      if (status !== 'done' || disposition !== 'discarded' || retry !== null) return null;
    } else if (state === 'rejected' || state === 'failed') {
      if (status !== 'dead' || disposition !== state || retry !== null) return null;
    } else if (status !== 'pending' || disposition !== 'pending' || retry !== 60) return null;
  } else if (reason === 'automation_before_adoption' || reason === 'automation_legacy_accepted') {
    if (status !== 'done' || disposition !== 'suppressed' || retry !== null) return null;
  } else {
    if (!['automation_dependency_unavailable','automation_job_missing','automation_dependency_changed',
      'automation_initial_unclaimed','automation_initial_unfinished'].includes(String(reason)) || disposition !== 'dependency' || retry !== 60
      || (status !== 'pending' && !(status === 'processing' && reason === 'automation_initial_unclaimed'))) return null;
  }
  return value as OutboxAutomationObservation;
}

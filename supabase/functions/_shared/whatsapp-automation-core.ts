import { MESSAGE_TTL_MS } from './whatsapp-message-ttl-core.ts';

export type ScheduledKind = 'confirmation' | 'reminder_d1' | 'survey_d1' | 'waitlist_entered' | 'waitlist_feedback' | 'voucher_issued';
export type AutomationKind = ScheduledKind;
type IntentOrigin = { unitId: string; sourceEventKey: string; factAt: string };
export type ScheduledIntent = IntentOrigin & (
  | { kind: 'confirmation' | 'reminder_d1' | 'survey_d1'; reservationId: string; waitlistId?: never; voucherId?: never }
  | { kind: 'waitlist_entered' | 'waitlist_feedback'; waitlistId: string; reservationId?: never; voucherId?: never }
  | { kind: 'voucher_issued'; voucherId: string; reservationId?: never; waitlistId?: never }
);
export type DispatchSelection = 'scheduled' | 'paused' | 'legacy';
export type DispatchResult =
  | { state: 'accepted'; jobId: string; providerMessageId?: string }
  | { state: 'queued' | 'blocked' | 'expired' | 'uncertain' | 'needs_review' | 'failed' | 'reconciled'; jobId: string; reason: string };
export const AUTOMATION_POST_TIMEOUT_MS = 15_000;

export function logicalAutomationKey(input: { unitId: string; kind: AutomationKind; reservationId?: string; waitlistId?: string; voucherId?: string; sourceEventKey?: string }): string {
  const resources = [input.reservationId, input.waitlistId, input.voucherId].filter(Boolean);
  const resource = ['confirmation', 'reminder_d1', 'survey_d1'].includes(input.kind)
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
  | { outcome: 'uncertain'; reason: 'response_invalid' | 'post_ambiguous' };

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

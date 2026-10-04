import { describe, expect, it } from 'vitest';
import { logicalAutomationKey, selectAutomationPath, automationDeadline, classifyAutomationOutcome, automationRetryDelayMs, localPreflightRefusal } from '../../supabase/functions/_shared/whatsapp-automation-core.ts';
import type { ScheduledIntent, ScheduledKind, DispatchResult, DispatchSelection } from '../../supabase/functions/_shared/whatsapp-automation-core.ts';

describe('automation identity and cutover', () => {
  it('local preflight refusal only exists before the dispatcher invokes POST', () => {
    expect(localPreflightRefusal({postAttempted:false,reason:'final_consent_changed'})).toEqual({outcome:'local_preflight_refused',reason:'final_consent_changed'});
    expect(localPreflightRefusal({postAttempted:true,reason:'final_consent_changed'})).toBeNull();
  });
  it('exports the producer/dispatcher shared union contracts', () => {
    const kind: ScheduledKind = 'voucher_issued';
    const intent: ScheduledIntent = { unitId: 'u', kind, voucherId: 'v', sourceEventKey: 's', factAt: '2026-10-03T12:00:00Z' };
    const result: DispatchResult = { state: 'accepted', jobId: logicalAutomationKey(intent) };
    const selection: DispatchSelection = selectAutomationPath({ ledgerExists: true, adoptedAt: null, enabled: false });
    expect(result.jobId).toBe('["u","voucher_issued","v"]');
    expect(selection).toBe('scheduled');
  });
  it('existing ledger wins rollback and sticky adoption pauses', () => {
    expect(selectAutomationPath({ ledgerExists: true, adoptedAt: null, enabled: false })).toBe('scheduled');
    expect(selectAutomationPath({ ledgerExists: false, adoptedAt: '2026-10-03T12:00:00Z', enabled: false })).toBe('paused');
    expect(selectAutomationPath({ ledgerExists: false, adoptedAt: null, enabled: false })).toBe('legacy');
    expect(selectAutomationPath({ ledgerExists: false, adoptedAt: null, enabled: true })).toBe('scheduled');
  });
  it('provenance never creates a second intent', () => {
    const x = { unitId: 'u', kind: 'reminder_d1' as const, reservationId: 'r' };
    expect(logicalAutomationKey({ ...x, sourceEventKey: 'a' })).toBe(logicalAutomationKey({ ...x, sourceEventKey: 'b' }));
    expect(logicalAutomationKey(x)).not.toBe(logicalAutomationKey({ ...x, unitId: 'other' }));
  });
  it('refuses ambiguous or mismatched resources', () => {
    expect(() => logicalAutomationKey({ unitId: 'u', kind: 'voucher_issued', reservationId: 'r' })).toThrow();
    expect(() => logicalAutomationKey({ unitId: 'u', kind: 'confirmation', reservationId: 'r', waitlistId: 'w' })).toThrow();
  });
  it('deadline imports existing zero TTL and blocks missing new facts', () => {
    expect(automationDeadline('confirmation', '2026-10-03T20:00:00-03:00')).toBe('2026-10-03T23:00:00.000Z');
    expect(automationDeadline('survey_d1', '2026-10-03T23:59:00-03:00')).toBe('2026-10-06T02:59:00.000Z');
    expect(() => automationDeadline('confirmation', '')).toThrow();
    expect(() => automationDeadline('confirmation', '2026-10-03T20:00:00')).toThrow();
  });
});
describe('closed outcomes', () => {
  it('only documented Datafy preproxy nonacceptance retries', () => {
    expect(classifyAutomationOutcome({ provider: 'datafy', status: 429, preproxyStatusCode: 429 })).toEqual({ outcome: 'rejected', reason: 'documented_preproxy_429' });
    for (const status of [429, 500, 503]) expect(classifyAutomationOutcome({ provider: 'datafy', status }).outcome).toBe('uncertain');
    expect(classifyAutomationOutcome({ provider: 'zapi', status: 429, preproxyStatusCode: 429 }).outcome).toBe('uncertain');
  });
  it('accepted opaque IDs are bounded and controls never persisted', () => {
    expect(classifyAutomationOutcome({ provider: 'datafy', status: 200, messageId: 'remote.id' }).outcome).toBe('accepted');
    for (const messageId of ['', 'a'.repeat(513), 'unsafe\n']) expect(classifyAutomationOutcome({ provider: 'datafy', status: 200, messageId }).outcome).toBe('uncertain');
  });
  it('uses exactly four backoffs and never retries beyond five POSTs', () => {
    expect([1, 2, 3, 4].map(automationRetryDelayMs)).toEqual([60000, 240000, 960000, 3840000]);
    expect(automationRetryDelayMs(5)).toBeNull();
  });
});

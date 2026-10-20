import { describe, expect, it } from 'vitest';
import { logicalAutomationKey, selectAutomationPath, automationDeadline, classifyAutomationOutcome, automationRetryDelayMs, localPreflightRefusal, parseAutomationLedger, recordedDispatchResult, automationPreflightState, AUTOMATION_PREFLIGHT_REASONS, SCHEDULED_KINDS } from '../../supabase/functions/_shared/whatsapp-automation-core.ts';
import type { ScheduledIntent, ScheduledKind, DispatchResult, DispatchSelection } from '../../supabase/functions/_shared/whatsapp-automation-core.ts';

describe('automation identity and cutover', () => {
  it('local preflight refusal only exists before the dispatcher invokes POST', () => {
    expect(localPreflightRefusal({postAttempted:false,reason:'final_consent_changed'})).toEqual({outcome:'local_preflight_refused',reason:'final_consent_changed'});
    expect(localPreflightRefusal({postAttempted:true,reason:'final_consent_changed'})).toBeNull();
  });
  it('exports the producer/dispatcher shared union contracts', () => {
    const kind: ScheduledKind = 'voucher_issued';
    const intent: ScheduledIntent = { unitId: 'u', kind, voucherId: 'v', sourceEventKey: 's', factAt: '2026-10-03T12:00:00Z' };
    const result: DispatchResult = { state: 'accepted', pinPhase: 'bound', jobId: logicalAutomationKey(intent) };
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
  it('SCHEDULED_KINDS is the closed kind source with cancellation and table-ready resources', () => {
    expect([...SCHEDULED_KINDS]).toEqual(['confirmation', 'reminder_d1', 'survey_d1', 'waitlist_entered', 'waitlist_feedback', 'voucher_issued', 'cancellation', 'waitlist_table_ready']);
    const cancellation: ScheduledIntent = { unitId: 'u', kind: 'cancellation', reservationId: 'r', sourceEventKey: 's', factAt: '2026-10-03T12:00:00Z' };
    const ready: ScheduledIntent = { unitId: 'u', kind: 'waitlist_table_ready', waitlistId: 'w', sourceEventKey: 's', factAt: '2026-10-03T12:00:00Z' };
    expect(logicalAutomationKey(cancellation)).toBe('["u","cancellation","r"]');
    expect(logicalAutomationKey(ready)).toBe('["u","waitlist_table_ready","w"]');
    expect(() => logicalAutomationKey({ unitId: 'u', kind: 'cancellation', waitlistId: 'w' })).toThrow();
    expect(() => logicalAutomationKey({ unitId: 'u', kind: 'waitlist_table_ready', reservationId: 'r' })).toThrow();
    expect(automationDeadline('cancellation', '2026-10-03T20:00:00-03:00')).toBe('2026-10-04T23:00:00.000Z');
    expect(automationDeadline('waitlist_table_ready', '2026-10-03T20:00:00-03:00')).toBe('2026-10-03T23:30:00.000Z');
    expect(automationPreflightState('reservation_not_cancelled', false)).toBe('blocked');
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

const rawLedger = () => ({id:'00000000-0000-4000-8000-000000000001',pin_phase:'preconfiguration',state:'blocked',attempts:0,error_code:'channel_unconfigured',
  channel_id:null,provider:null,binding_id:null,binding_generation:null,transport:null,account_id:null,remote_template_id:null,template_version:null,sync_epoch:null,
  initial_credential_revision:null,initial_catalog_key:'res_confirmacao_v1',claim_token:null,claimed_until:null,posting_started_at:null,provider_message_id:null,
  initial_template_version:1,initial_selection_source:'legacy',initial_selection_revision:0,initial_enrollment_id:null,initial_catalog_digest:null,
  safe_log_body:null,consent_revision:null,cost_authorization_id:null,reconcile_required:false});
describe('Task9b truthful ledger projection',()=>{
  it('retains real incomplete identity instead of inventing a queued or accepted result',()=>{
    const row=parseAutomationLedger(rawLedger());
    expect(row.pinPhase).toBe('preconfiguration');
    expect(recordedDispatchResult(row)).toEqual({state:'blocked',pinPhase:'preconfiguration',jobId:rawLedger().id,reason:'channel_unconfigured'});
  });
  it('accepts exactly three incomplete tuples and actual revision zero',()=>{
    expect(parseAutomationLedger(rawLedger()).pins.shape).toBe('unselected');
    const channel={...rawLedger(),channel_id:rawLedger().id,provider:'datafy',transport:'template',initial_credential_revision:0};
    expect(parseAutomationLedger(channel).pins.shape).toBe('unbound');
    expect(parseAutomationLedger({...channel,binding_id:rawLedger().id,binding_generation:1,account_id:rawLedger().id}).pins.shape).toBe('missing_template');
    for(const patch of [{binding_generation:1},{provider:'datafy'},{initial_credential_revision:0},{sync_epoch:0},{attempts:1},{state:'queued'},{safe_log_body:'render'},{reconcile_required:true},{initial_catalog_key:null}]) expect(()=>parseAutomationLedger({...rawLedger(),...patch})).toThrow('automation_ledger_invalid');
    for(const key of Object.keys(channel)) { const copy={...channel}; delete copy[key]; expect(()=>parseAutomationLedger(copy),key).toThrow(); }
  });
  it('maps all thirteen stored states and keeps historical revision nullable',()=>{
    const states={queued:'queued',claimed:'queued',posting:'queued',retry_wait:'queued',paused:'blocked',rejected:'failed',accepted:'accepted',blocked:'blocked',expired:'expired',uncertain:'uncertain',needs_review:'needs_review',failed:'failed',reconciled:'reconciled'};
    for(const [state,expected] of Object.entries(states)) {
      const row=parseAutomationLedger({...rawLedger(),pin_phase:'bound',state,channel_id:rawLedger().id,provider:'zapi',transport:'text',binding_id:rawLedger().id,binding_generation:1,initial_catalog_key:null});
      expect(row.pins.initialCredentialRevision).toBeNull();
      expect(recordedDispatchResult(row).state).toBe(expected);
    }
    for(const patch of [{state:'sent'},{attempts:0.5},{attempts:6},{id:'fake'},{initial_credential_revision:'0'}]) expect(()=>parseAutomationLedger({...rawLedger(),...patch})).toThrow();
  });
  it('closed initial refusal vocabulary maps conservatively and expiry dominates',()=>{
    for(const reason of AUTOMATION_PREFLIGHT_REASONS) expect(automationPreflightState(reason,true)).toBe('expired');
    expect(automationPreflightState('reservation_pending',false)).toBe('blocked');
    expect(automationPreflightState('dispatch_paused',false)).toBe('paused');
    for(const reason of ['reservation_changed','waitlist_changed','voucher_changed','recipient_changed','channel_changed','binding_changed'] as const) expect(automationPreflightState(reason,false)).toBe('needs_review');
    expect(()=>automationPreflightState('invented' as never,false)).toThrow();
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

// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createAutomationFixture, createAutomationEndpointIO } from '../test/fixtures/whatsapp-automation-fixtures';
import { createEdgeRequestHarness } from '../test/fixtures/edge-request-harness';
import { decodeOutboxAutomationObservation, selectReservationAutomationRoute, type AutomationRouteReader } from '../../supabase/functions/_shared/whatsapp-automation-producer-routing';

const fixtures: ReturnType<typeof createAutomationFixture>[] = [];
function fixture(options: { templateStatus?: string } = {}) { const f = createAutomationFixture(options); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.producer().harness.dispose(); });
const pending = (state: string) => ({ ledger_state: state, outbox_status: 'pending', disposition: 'pending', reason: `automation_${state}`, retry_after_seconds: 60 });

describe('actual reservation producers through Request and internal hops', () => {
  it('PENDING official template blocks WhatsApp but preserves the one initial email', async () => {
    const f = fixture({ templateStatus: 'PENDING' }), p = f.producer();
    await f.runReservationProducer('confirmation');
    expect(p.row.error_code).toBe('template_unavailable');
    expect(f.calls.post + f.calls.legacyText).toBe(0); expect(f.calls.email).toBe(1); expect(f.calls.recordSent).toBe(0);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('MARKETING reclassification blocks the actual survey dispatcher', async () => {
    const f = fixture({ templateStatus: 'APPROVED' }), p = f.producer(); p.controls.templateCategory = 'MARKETING';
    await f.runReservationProducer('survey_d1', { date: '2026-10-04' });
    expect(p.row.error_code).toBe('template_unavailable'); expect(f.calls.post + f.calls.legacyText).toBe(0);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('discount variant and current rescheduled time use the actual text renderer', async () => {
    const f = fixture(), p = f.producer();
    await f.runReservationProducer('confirmation', { time: '22:15:00', applied_discount_percent: 15 });
    expect(p.row.initial_catalog_key).toBe('res_confirmacao_desconto_v1');
    expect(f.calls.post).toBe(1); expect(JSON.stringify(p.requests)).toContain('22:15'); expect(JSON.stringify(p.requests)).toContain('15%');
  });
  it.each(['cancelled','no_show'])('current %s never posts despite a current producer selection', async status => {
    const f = fixture(); await f.runReservationProducer('confirmation', { status });
    expect(f.calls.post + f.calls.legacyText).toBe(0); expect(f.calls.email).toBe(1);
  });
  it('plain adopted confirmation preserves email, creates no intent and never sends legacy', async () => {
    const f = fixture(), p = f.producer(); p.controls.plain = true;
    const response = await f.runReservationProducer('confirmation');
    expect(await response.json()).toMatchObject({ success: true, whatsapp: { sent: false, skipped: true, local_success: false }, email: { sent: true } });
    expect(f.calls.email).toBe(1); expect(f.calls.post).toBe(0); expect(f.calls.legacyText).toBe(0);
    expect(p.trace).toEqual([]); expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('an auto cohort with confirmation OFF cannot create an intent or use legacy text', async () => {
    const f = fixture(), p = f.producer();
    p.controls.plain = true;
    p.controls.serviceRoute = { auto_cohort: true, allowed: false, reason_code: 'service_not_enabled' };
    const response = await f.runReservationProducer('confirmation');
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ success: true, whatsapp: { sent: false,
      skipped: true, reason: 'service_not_enabled' }, email: { sent: true } });
    expect(p.controls.serviceRouteReads).toEqual([{ kind: 'confirmation', resourceId: f.ids.reservation }]);
    expect(p.trace.some(x => x.name === 'enqueue_whatsapp_automation')).toBe(false);
    expect(f.calls.post + f.calls.legacyText).toBe(0);
    expect(f.calls.email).toBe(1);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('an auto cohort with confirmation OFF completes the outbox email without a WhatsApp intent', async () => {
    const f = fixture(), p = f.producer();
    p.controls.serviceRoute = { auto_cohort: true, allowed: false, reason_code: 'service_not_enabled' };
    const response = await f.runReservationProducer('outbox');
    expect(await response.json()).toMatchObject({ succeeded: 1, skippedService: 1,
      automationDependency: 0, failed: 0 });
    expect(f.calls.email).toBe(1);
    expect(f.calls.post + f.calls.legacyText).toBe(0);
    expect(p.trace.map(x => x.name)).toContain('mark_outbox_done');
    expect(p.trace.some(x => x.name === 'enqueue_whatsapp_automation'
      || x.name === 'claim_notification_outbox_initial')).toBe(false);
    expect(p.controls.serviceRouteReads).toEqual(Array(2).fill({ kind: 'confirmation', resourceId: f.ids.reservation }));
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it.each(['reminder_d1', 'survey_d1'] as const)('%s verified OFF is skipped, not a worker failure', async kind => {
    const f = fixture(), p = f.producer();
    p.controls.serviceRoute = { auto_cohort: true, allowed: false, reason_code: 'service_not_enabled' };
    const response = await f.runReservationProducer(kind);
    expect(await response.json()).toMatchObject({ dispatched: 0, failed: 0, skipped_service: 1 });
    expect(p.controls.serviceRouteReads).toEqual([{ kind, resourceId: f.ids.reservation }]);
    expect(p.trace.some(x => x.name === 'enqueue_whatsapp_automation')).toBe(false);
    expect(f.calls.post + f.calls.legacyText).toBe(0);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('initial owner claims before enqueue, pins before dispatch, preserves attempts and one email across real worker polls', async () => {
    const f = fixture(), p = f.producer();
    await f.runReservationProducer('outbox');
    const names = p.trace.map(x => x.name);
    expect(names.indexOf('claim_notification_outbox_initial')).toBeLessThan(names.indexOf('enqueue_whatsapp_automation'));
    expect(names.indexOf('delegate_notification_outbox_automation')).toBeLessThan(names.indexOf('claim_whatsapp_automation'));
    expect(f.calls.post).toBe(1); expect(f.calls.email).toBe(1); expect(f.calls.legacyText).toBe(0);
    const count = p.harness.internalRequests.length;
    await f.runReservationProducer('outbox');
    expect(p.harness.internalRequests).toHaveLength(count); expect(f.calls.email).toBe(1); expect(f.calls.post).toBe(1);
    expect(p.outbox.attempts).toBe(2); expect(p.trace.some(x => x.name === 'mark_outbox_failed' || x.name === 'mark_outbox_done')).toBe(false);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('recovers the original no-job intent after enqueue fails before INSERT, without repeating email or dispatch', async () => {
    const f = fixture(), p = f.producer();
    const original = { ...p.outbox };
    p.rpcReplies.enqueue_whatsapp_automation = [{ data: null, error: { code: 'synthetic_before_insert' } }];
    p.controls.pollResult = { ledger_state: null, outbox_status: 'pending', disposition: 'dependency',
      reason: 'automation_dependency_unavailable', retry_after_seconds: 60 };
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    const token = p.outbox.automation_initial_token;
    expect(token).toBe('66666666-0000-4000-8000-000000000001');
    expect(p.controls.ledger).toBe(false); expect(p.outbox.automation_job_id).toBeNull();
    expect(p.outbox.status).toBe('pending'); expect(f.calls.email).toBe(1); expect(f.calls.post).toBe(0);
    expect(p.trace.filter(x => x.name === 'finish_notification_outbox_initial')).toHaveLength(1);
    const firstIntent = p.trace.find(x => x.name === 'enqueue_whatsapp_automation')!.args;
    const recoveryStart = p.trace.length, hopStart = p.harness.internalRequests.length;
    p.controls.pollResult = pending('queued');
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationPending: 1, succeeded: 0 });
    expect(p.controls.ledger).toBe(true);
    expect(p.outbox).toMatchObject({ automation_initial_token: token, automation_job_id: p.row.id,
      attempts: original.attempts, id: original.id, reservation_id: original.reservation_id,
      unit_id: original.unit_id, kind: original.kind, created_at: original.created_at });
    expect(p.trace.slice(recoveryStart)).toEqual([
      { name: 'recover_delegated_notification_outbox', args: { p_limit: 20 } },
      { name: 'enqueue_whatsapp_automation', args: firstIntent },
      { name: 'delegate_notification_outbox_automation', args: { p_id: p.outboxId, p_job_id: p.row.id } },
      { name: 'poll_notification_outbox_automation', args: { p_id: p.outboxId } },
    ]);
    const recoveryHops = p.harness.internalRequests.slice(hopStart);
    expect(recoveryHops.map(x => [x.from, x.to])).toEqual([['process-notification-outbox', 'send-scheduled-whatsapp']]);
    expect(await recoveryHops[0].request.json()).toEqual({ action: 'enqueue', kind: 'confirmation',
      resource_id: f.ids.reservation, unit_id: f.ids.unit, outbox_id: p.outboxId });
    expect(p.row).toMatchObject({ source_event_key: `outbox:${p.outboxId}`, fact_at: '2026-10-05T20:30:00-03:00',
      expires_at: '2026-10-05T23:30:00.000Z', attempts: 0 });
    const recoveredJob = { ...p.row }, recoveredHops = p.harness.internalRequests.length;
    await f.runReservationProducer('outbox');
    expect(p.row).toEqual(recoveredJob); expect(p.harness.internalRequests).toHaveLength(recoveredHops);
    expect(f.calls.email).toBe(1); expect(f.calls.post + f.calls.legacyText).toBe(0);
    const response = await p.harness.request('send-scheduled-whatsapp', new Request('https://fixture.supabase.invalid/functions/v1/send-scheduled-whatsapp', {
      method: 'POST', headers: { 'x-internal-key': 'synthetic-internal' }, body: JSON.stringify({ action: 'dispatch_existing', job_id: p.row.id }),
    }));
    expect(await response.json()).toMatchObject({ state: 'reconciled', jobId: p.row.id });
    expect(f.calls.post).toBe(1); expect(f.calls.email).toBe(1); expect(f.calls.legacyText).toBe(0);
    expect(p.outbox.automation_initial_token).toBe(token); expect(p.outbox.attempts).toBe(2);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('known zero-POST pending job reevaluates only after real scoped promotion', async () => {
    const f = fixture(), p = f.producer();
    await f.runReservationProducer('confirmation', { status: 'pending' });
    expect(f.calls.email).toBe(1); expect(f.calls.post).toBe(1);
    expect(p.trace.filter(x => x.name === 'enqueue_whatsapp_automation')).toHaveLength(1);
    expect(p.trace.filter(x => x.name === 'claim_whatsapp_automation')).toHaveLength(2);
    expect(p.queries.find(q => q.table === 'reservations' && q.patch)).toMatchObject({ columns: 'id,unit_id,status',
      filters: { id: f.ids.reservation, unit_id: f.ids.unit, status: 'pending' } });
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it.each(['zero','error','no_email','failed_email','payment'] as const)('%s does not authorize pending reevaluation', async control => {
    const f = fixture(), p = f.producer();
    if (control === 'zero' || control === 'error') p.controls.promotion = control;
    if (control === 'no_email') p.controls.email = null;
    if (control === 'failed_email') p.controls.emailAccepted = false;
    await f.runReservationProducer('confirmation', { status: 'pending', ...(control === 'payment' ? { payment_status: 'pending_payment' } : {}) });
    expect(f.calls.post).toBe(0); expect(f.calls.legacyText).toBe(0);
    expect(p.trace.filter(x => x.name === 'enqueue_whatsapp_automation')).toHaveLength(1);
  });
  it.each(['plain','resend','initial_existing'] as const)('existing accepted ledger in %s creates no new fact or email retry', async mode => {
    const f = fixture(), p = f.producer(); p.controls.ledger = true; p.row.state = 'accepted'; p.row.provider_message_id = 'native-existing';
    p.controls.plain = mode === 'plain'; p.controls.resend = mode === 'resend';
    await f.runReservationProducer('confirmation');
    expect(f.calls.post).toBe(0); expect(f.calls.legacyText).toBe(0); expect(f.calls.email).toBe(mode === 'resend' ? 0 : 1);
    expect(p.trace.some(x => x.name === 'enqueue_whatsapp_automation')).toBe(false);
    if (mode !== 'resend') expect(p.trace.some(x => x.name === 'reconcile_whatsapp_automation_acceptance')).toBe(false);
  });
  it.each(['claim_loser','foreign_outbox','wrong_unit'] as const)('%s has no initial effects', async mode => {
    const f = fixture(), p = f.producer();
    if (mode === 'claim_loser') p.controls.initialClaim = null;
    if (mode === 'foreign_outbox') p.outbox.unit_id = f.ids.foreignUnit;
    if (mode === 'wrong_unit') p.controls.requestUnit = f.ids.foreignUnit;
    await f.runReservationProducer('confirmation');
    expect(f.calls.email).toBe(0); expect(f.calls.post).toBe(0); expect(f.calls.legacyText).toBe(0);
  });
  it('actual worker empty selection preserves upstream WhatsApp exclusion; real manual row is eligible', async () => {
    const f = fixture(), p = f.producer(); p.controls.emptyOutbox = true;
    await f.runReservationProducer('outbox', { source: 'whatsapp' });
    expect(f.calls.email + f.calls.post + f.calls.legacyText).toBe(0);
    p.controls.emptyOutbox = false;
    await f.runReservationProducer('outbox');
    expect(f.calls.email).toBe(1); expect(f.calls.post).toBe(1);
  });
  it.each(['platform_flags','whatsapp_template_bindings','whatsapp_automation_jobs'] as const)('plain %s dependency never falls through or suppresses email', async table => {
    const f = fixture(), p = f.producer(); p.controls.plain = true; p.controls.queryError = table;
    await f.runReservationProducer('confirmation');
    expect(f.calls.email).toBe(1); expect(f.calls.legacyText).toBe(0); expect(f.calls.post).toBe(0); expect(p.trace).toEqual([]);
  });
  it('sticky OFF remains managed while never adopted OFF preserves legacy', async () => {
    const f = fixture(), p = f.producer(); p.controls.flag = false; p.controls.bindingEnabled = false; p.controls.plain = true;
    await f.runReservationProducer('confirmation'); expect(f.calls.legacyText).toBe(0);
    p.controls.adopted = false;
    await f.runReservationProducer('confirmation'); expect(f.calls.legacyText).toBe(1); expect(f.calls.email).toBe(2);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it('legacy resend requires actual confirmation retry provenance and excludes email', async () => {
    const f = fixture(), p = f.producer(); Object.assign(p.controls, { adopted: false, flag: false, bindingEnabled: false, resend: true });
    await f.runReservationProducer('confirmation'); expect(f.calls.legacyText).toBe(0);
    p.controls.resendReceipt = true;
    await f.runReservationProducer('confirmation'); expect(f.calls.legacyText).toBe(1); expect(f.calls.email).toBe(0);
  });
  it.each(['reminder_d1','survey_d1'] as const)('%s actual selector routes to same dispatcher with current date and time', async kind => {
    const f = fixture(), p = f.producer();
    await f.runReservationProducer(kind, { date: kind === 'survey_d1' ? '2026-10-04' : '2026-10-05', time: '21:45:00' });
    expect(f.calls.post).toBe(1); expect(f.calls.legacyText).toBe(0); expect(f.calls.email).toBe(0);
    expect(p.trace[0]).toMatchObject({ name: kind === 'survey_d1' ? 'get_reservations_for_survey' : 'get_reservations_for_reminder',
      args: { p_target_date: kind === 'survey_d1' ? '2026-10-04' : '2026-10-05', p_unit_id: f.ids.unit } });
    if (kind === 'reminder_d1') expect(JSON.stringify(p.requests)).toContain('21:45');
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it.each(['accepted','reconciled','expired','rejected','failed','uncertain'] as const)('worker consumes actual SQL %s without invoking handler', async state => {
    const f = fixture(), p = f.producer(); p.outbox.automation_initial_token = '66666666-0000-4000-8000-000000000001';
    p.outbox.automation_job_id = p.row.id;
    p.controls.pollResult = state === 'uncertain' ? pending(state) : { ledger_state: state,
      outbox_status: ['rejected','failed'].includes(state) ? 'dead' : 'done',
      disposition: ['accepted','reconciled'].includes(state) ? 'accepted' : state === 'expired' ? 'discarded' : state,
      reason: `automation_${state}`, retry_after_seconds: null };
    const response = await f.runReservationProducer('outbox'); const body = await response.json();
    expect(body.succeeded).toBe(['accepted','reconciled'].includes(state) ? 1 : 0);
    expect(body.expired).toBe(state === 'expired' ? 1 : 0);
    expect(body.failed).toBe(['rejected','failed'].includes(state) ? 1 : 0);
    expect(f.calls.email + f.calls.post + f.calls.legacyText).toBe(0); expect(p.outbox.attempts).toBe(2);
  });
  it('unclaimed initial processing observation is deferred without stranding or replay', async () => {
    const f = fixture(), p = f.producer(); p.controls.initialClaim = null;
    p.controls.pollResult = { ledger_state:null, outbox_status:'processing', disposition:'dependency', reason:'automation_initial_unclaimed', retry_after_seconds:60 };
    const response = await f.runReservationProducer('outbox');
    expect(await response.json()).toMatchObject({ succeeded:0, automationDependency:1 });
    expect(p.trace.map(x => x.name)).toEqual(['recover_delegated_notification_outbox','claim_notification_outbox_initial','poll_notification_outbox_automation','defer_notification_outbox_automation_dependency']);
    expect(f.calls.post + f.calls.email + f.calls.legacyText).toBe(0);
    expect(p.outbox.automation_initial_token).toBeNull(); expect(p.outbox.attempts).toBe(2);
    expect(p.harness.internalRequests.map(x => [x.from,x.to])).toEqual([['process-notification-outbox','send-confirmation']]);
  });
  it('never-adopted worker routing dependency defers with zero initial effects', async () => {
    const f = fixture(), p = f.producer(); p.controls.adopted = false; p.controls.flag = false; p.controls.bindingEnabled = false;
    p.controls.queryError = 'platform_flags';
    const response = await f.runReservationProducer('outbox');
    expect(await response.json()).toMatchObject({ succeeded: 0, automationDependency: 1 });
    expect(p.trace.map(x => x.name)).toContain('defer_notification_outbox_automation_dependency');
    expect(p.trace.map(x => x.name)).not.toContain('claim_notification_outbox_initial');
    expect(f.calls.email + f.calls.post + f.calls.legacyText).toBe(0);
    expect(p.outbox.automation_initial_token).toBeNull(); expect(p.outbox.automation_job_id).toBeNull();
  });
  it('failed ledger observation defers observably without legacy retry or extra email', async () => {
    const f = fixture(), p = f.producer(); p.controls.pollError = true; p.outbox.automation_initial_token = '66666666-0000-4000-8000-000000000001';
    const response = await f.runReservationProducer('outbox'); expect(await response.json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    expect(p.trace.some(x => x.name === 'defer_notification_outbox_automation_dependency')).toBe(true);
    expect(f.calls.email + f.calls.post + f.calls.legacyText).toBe(0);
  });
});

describe('original no-job recovery through actual worker Requests', () => {
  function tokenOwned() {
    const f = fixture(), p = f.producer();
    p.outbox.automation_initial_token = '66666666-0000-4000-8000-000000000001';
    return { f, p };
  }
  function noDeliveryEffects(f: ReturnType<typeof fixture>) {
    const p = f.producer();
    expect(f.calls.email + f.calls.post + f.calls.legacyText).toBe(0);
    expect(p.trace.some(x => ['claim_notification_outbox_initial', 'finish_notification_outbox_initial',
      'claim_whatsapp_automation', 'prepare_whatsapp_automation_post', 'confirm_whatsapp_automation_post',
      'reconcile_whatsapp_automation_acceptance', 'mark_outbox_done', 'mark_outbox_failed'].includes(x.name))).toBe(false);
    expect(p.outbox.automation_initial_token).toBe('66666666-0000-4000-8000-000000000001');
    expect(p.outbox.attempts).toBe(2); expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  }
  it.each(['queued', 'accepted', 'uncertain'] as const)('natural %s ledger appears before recovery: pin and SQL poll, zero enqueue', async state => {
    const { f, p } = tokenOwned(); p.controls.ledger = true; p.row.state = state;
    if (state !== 'queued') p.row.provider_message_id = 'native-existing';
    p.controls.queryError = 'platform_flags';
    const job = { ...p.row };
    const response = await f.runReservationProducer('outbox');
    expect(await response.json()).toMatchObject({ succeeded: 0, automationPending: 1 });
    expect(p.queries.map(q => q.table)).toEqual(['notification_outbox', 'whatsapp_automation_jobs']);
    expect(p.queries[1]).toEqual({ table: 'whatsapp_automation_jobs', columns: '*', patch: null,
      filters: { unit_id: f.ids.unit, reservation_id: f.ids.reservation, kind: 'confirmation' } });
    expect(p.trace.map(x => x.name)).toEqual(['recover_delegated_notification_outbox',
      'delegate_notification_outbox_automation', 'poll_notification_outbox_automation']);
    expect(p.outbox.automation_job_id).toBe(p.row.id); expect(p.row).toEqual(job);
    expect(p.harness.internalRequests).toEqual([]); noDeliveryEffects(f);
  });
  it('a historical missing pin only polls SQL and cannot recreate a job', async () => {
    const { f, p } = tokenOwned(); p.outbox.automation_job_id = p.row.id;
    p.controls.pollResult = { ledger_state: null, outbox_status: 'pending', disposition: 'dependency',
      reason: 'automation_job_missing', retry_after_seconds: 60 };
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    expect(p.controls.ledger).toBe(false); expect(p.outbox.automation_job_id).toBe(p.row.id);
    expect(p.queries.map(q => q.table)).toEqual(['notification_outbox']);
    expect(p.trace.map(x => x.name)).toEqual(['recover_delegated_notification_outbox', 'poll_notification_outbox_automation']);
    expect(p.harness.internalRequests).toEqual([]); noDeliveryEffects(f);
  });
  it.each(['error', 'undefined', 'duplicate', 'unit', 'reservation', 'kind', 'state'] as const)('%s natural ledger evidence defers without an enqueue', async mode => {
    const { f, p } = tokenOwned();
    const data = mode === 'undefined' ? undefined : mode === 'duplicate' ? [{ ...p.row }, { ...p.row }]
      : { ...p.row, ...(mode === 'unit' ? { unit_id: f.ids.foreignUnit } : mode === 'reservation' ? { reservation_id: f.ids.foreignUnit }
        : mode === 'kind' ? { kind: 'survey_d1' } : mode === 'state' ? { state: 'invented' } : {}) };
    p.queryReplies.whatsapp_automation_jobs = [{ data, error: mode === 'error' ? { code: 'synthetic_read' } : null }];
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    expect(p.trace.map(x => x.name)).toEqual(['recover_delegated_notification_outbox', 'defer_notification_outbox_automation_dependency']);
    expect(p.harness.internalRequests).toEqual([]); expect(p.outbox.automation_job_id).toBeNull(); noDeliveryEffects(f);
  });
  it.each(['transport', 'http', 'json', 'dto'] as const)('%s failure after enqueue defers, then discovers the persisted job without another enqueue', async mode => {
    const { f, p } = tokenOwned();
    p.responseScripts.push({ from: 'process-notification-outbox', to: 'send-scheduled-whatsapp', reply: response => {
      expect(response.ok).toBe(true);
      if (mode === 'transport') throw new Error('synthetic_response_lost');
      return mode === 'http' ? Response.json({ error: 'synthetic' }, { status: 503 })
        : mode === 'json' ? new Response('{') : Response.json({ state: 'accepted', jobId: p.row.id, pinPhase: 'bound', extra: true });
    } });
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    expect(p.controls.ledger).toBe(true); expect(p.outbox.automation_job_id).toBeNull();
    expect(p.trace.map(x => x.name)).toEqual(['recover_delegated_notification_outbox', 'enqueue_whatsapp_automation',
      'defer_notification_outbox_automation_dependency']);
    const job = { ...p.row };
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationPending: 1, succeeded: 0 });
    expect(p.outbox.automation_job_id).toBe(p.row.id); expect(p.row).toEqual(job);
    expect(p.trace.filter(x => x.name === 'enqueue_whatsapp_automation')).toHaveLength(1);
    expect(p.harness.internalRequests).toHaveLength(1); expect(p.responseScripts).toEqual([]); noDeliveryEffects(f);
  });
  it.each(['error', 'false', 'malformed', 'foreign_job'] as const)('%s delegation never counts an HTTP result as acceptance', async mode => {
    const { f, p } = tokenOwned();
    p.rpcReplies.delegate_notification_outbox_automation = [{ data: mode === 'malformed' ? 'true' : false,
      error: mode === 'error' ? { code: 'synthetic_delegate' } : null }];
    if (mode === 'foreign_job') p.responseScripts.push({ from: 'process-notification-outbox', to: 'send-scheduled-whatsapp',
      reply: () => Response.json({ state: 'accepted', jobId: f.ids.foreignUnit, pinPhase: 'bound' }) });
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
    expect(p.outbox.automation_job_id).toBeNull();
    expect(p.trace.find(x => x.name === 'delegate_notification_outbox_automation')!.args).toEqual({ p_id: p.outboxId,
      p_job_id: mode === 'foreign_job' ? f.ids.foreignUnit : p.row.id });
    expect(p.trace.some(x => x.name === 'poll_notification_outbox_automation')).toBe(false);
    noDeliveryEffects(f);
  });
  it('closed accepted HTTP snapshot still follows the pending SQL observation', async () => {
    const { f, p } = tokenOwned();
    p.responseScripts.push({ from: 'process-notification-outbox', to: 'send-scheduled-whatsapp',
      reply: () => Response.json({ state: 'accepted', jobId: p.row.id, pinPhase: 'bound' }) });
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ succeeded: 0, automationPending: 1 });
    expect(p.outbox.automation_job_id).toBe(p.row.id); noDeliveryEffects(f);
  });
  it.each(['before_adoption', 'accepted_receipt'] as const)('%s positive suppression never mints a new job or finishes as the initial owner', async mode => {
    const { f, p } = tokenOwned();
    if (mode === 'before_adoption') p.outbox.created_at = '2026-09-30T12:00:00Z';
    // Actual SQL enqueue returns NULL for its exact accepted WhatsApp receipt check.
    // Supplying that I/O result is not an implementation of the SQL predicate.
    else p.rpcReplies.enqueue_whatsapp_automation = [{ data: null, error: null }];
    p.controls.pollResult = { ledger_state: null, outbox_status: 'pending', disposition: 'dependency',
      reason: 'automation_initial_unfinished', retry_after_seconds: 60 };
    const createdAt = p.outbox.created_at;
    for (let i = 0; i < 2; i++) {
      expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ automationDependency: 1, succeeded: 0 });
      if (mode === 'accepted_receipt') p.rpcReplies.enqueue_whatsapp_automation.push({ data: null, error: null });
    }
    expect(p.controls.ledger).toBe(false); expect(p.outbox.automation_job_id).toBeNull();
    expect(p.outbox.created_at).toBe(createdAt);
    expect(p.trace.filter(x => x.name === 'enqueue_whatsapp_automation')).toHaveLength(mode === 'before_adoption' ? 0 : 2);
    expect(p.trace.filter(x => x.name === 'poll_notification_outbox_automation')).toHaveLength(2);
    noDeliveryEffects(f);
  });
  it.each(['rpc_error', 'not_enqueued', 'poll_error', 'poll_dto', 'defer_error'] as const)('%s remains a bounded observable dependency', async mode => {
    const { f, p } = tokenOwned();
    if (mode === 'rpc_error' || mode === 'defer_error') p.rpcReplies.enqueue_whatsapp_automation = [{ data: null, error: { code: 'synthetic_enqueue' } }];
    if (mode === 'not_enqueued') p.controls.adopted = false;
    if (mode === 'poll_error') p.controls.pollError = true;
    if (mode === 'poll_dto') p.controls.pollResult = { ...pending('queued'), retry_after_seconds: 61 };
    if (mode === 'defer_error') p.rpcReplies.defer_notification_outbox_automation_dependency = [{ data: true, error: { code: 'synthetic_defer' } }];
    expect(await (await f.runReservationProducer('outbox')).json()).toMatchObject({ succeeded: 0,
      automationDependency: mode === 'defer_error' ? 0 : 1, automationWriteFailed: mode === 'defer_error' ? 1 : 0 });
    expect(p.harness.internalRequests).toHaveLength(1);
    expect(p.trace.filter(x => x.name === 'defer_notification_outbox_automation_dependency')).toHaveLength(1);
    expect(p.trace.filter(x => x.name === 'enqueue_whatsapp_automation').length).toBeLessThanOrEqual(1);
    noDeliveryEffects(f);
  });
});

describe('closed SQL observation decoder', () => {
  it.each(['queued','claimed','posting','retry_wait','blocked','paused','needs_review','uncertain'])('preserves %s without coarse reconstruction', state => {
    expect(decodeOutboxAutomationObservation(pending(state))).toEqual(pending(state));
    expect(decodeOutboxAutomationObservation({ ...pending(state), outbox_status: 'done' })).toBeNull();
  });
  it.each([{}, { ...pending('queued'), extra: true }, { ...pending('posting'), retry_after_seconds: 61 },
    { ...pending('accepted'), disposition: 'accepted' }, { ...pending('invented') }, { ...pending('queued'), ledger_state: null }])('rejects malformed correlation %#', value => {
    expect(decodeOutboxAutomationObservation(value)).toBeNull();
  });
});

describe('actual internal enqueue handler', () => {
  it.each(['accepted','reconciled','queued'] as const)('enqueue %s is persisted observation, zero dispatch/repair', async state => {
    const f = createAutomationEndpointIO(); f.row.state = state;
    const url = 'https://fixture.supabase.invalid';
    const h = createEdgeRequestHarness({ env: { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'synthetic', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' }, createClient: () => f.db });
    try {
      const body = { action: 'enqueue', kind: 'confirmation', resource_id: f.ids.reservation, unit_id: f.ids.unit, outbox_id: '00000000-0000-4000-8000-000000000001' };
      const call = (value: unknown, headers: Record<string,string> = { 'x-internal-key': 'synthetic-internal' }) => h.request('send-scheduled-whatsapp', new Request(`${url}/functions/v1/send-scheduled-whatsapp`, { method: 'POST', headers, body: JSON.stringify(value) }));
      expect(await (await call(body)).json()).toMatchObject({ state, jobId: f.jobId });
      expect((await call(body, { Authorization: 'Bearer synthetic-jwt' })).status).toBe(401);
      for (const extra of ['fact_at','phone','source_event_key','skipPost','target_date','initial_token']) expect((await call({ ...body, [extra]: 'untrusted' })).status).toBe(400);
      expect(f.calls.post).toBe(0); expect(f.calls.reconcile).toBe(0); expect(f.calls.prepares).toEqual([]); expect(f.calls.confirms).toEqual([]);
      expect(f.unexpected).toEqual([]); h.assertNoUnexpectedIo();
    } finally { h.dispose(); }
  });
});


describe('read-only route contract', () => {
  const input = { kind: 'confirmation' as const, unitId: 'bbbbbbbb-0000-0000-0000-000000000001', reservationId: 'eeeeeeee-0000-0000-0000-000000000001' };
  it('owns exact ordered predicates and cardinalities, ledger first', async () => {
    const calls: unknown[] = [];
    const read: AutomationRouteReader = async (...args) => { calls.push(args); return args[3] === 'many' ? [] : null; };
    expect(await selectReservationAutomationRoute(read,input)).toEqual({ path: 'legacy' });
    expect(calls).toEqual([
      ['whatsapp_automation_jobs','*',[['unit_id',input.unitId],['reservation_id',input.reservationId],['kind','confirmation']],'single'],
      ['whatsapp_automation_adoptions','adopted_at',[['unit_id',input.unitId]],'single'],
      ['platform_flags','value',[['key','whatsapp_automation_dispatch']],'single'],
      ['whatsapp_template_bindings','dispatch_enabled,adopted_at',[['unit_id',input.unitId]],'many'],
      ['whatsapp_channels','id,unit_id,provider,status,is_active,created_at',[['unit_id',input.unitId]],'many'],
    ]);
  });
  it('valid existing ledger wins without touching failed activation dependencies', async () => {
    const f = createAutomationEndpointIO(); let reads = 0;
    const read: AutomationRouteReader = async table => { reads++; if (table !== 'whatsapp_automation_jobs') throw new Error('activation_read_forbidden'); return { ...f.row }; };
    expect(await selectReservationAutomationRoute(read,{kind:'confirmation',unitId:f.ids.unit,reservationId:f.ids.reservation}))
      .toEqual({path:'managed',existingJobId:f.jobId,selection:'scheduled'}); expect(reads).toBe(1);
  });
  it.each(['throw','undefined','array','foreign'])('refuses %s ledger without activation reads', async mode => {
    let count = 0;
    const read: AutomationRouteReader = async () => { count++; if (mode === 'throw') throw new Error('synthetic');
      return mode === 'undefined' ? undefined : mode === 'array' ? [] : { unit_id: input.reservationId }; };
    expect(await selectReservationAutomationRoute(read,input)).toEqual({ path: 'dependency' }); expect(count).toBe(1);
  });
  it.each([
    ['platform_flags',{value:'false'}], ['whatsapp_automation_adoptions',{adopted_at:'invalid'}],
    ['whatsapp_template_bindings',null], ['whatsapp_template_bindings',[{dispatch_enabled:true,adopted_at:null}]],
    ['whatsapp_channels',null], ['whatsapp_channels',[{provider:'datafy',status:'connected',is_active:true}]],
  ])('refuses malformed %s without coercion', async (table,value) => {
    const read: AutomationRouteReader = async (name,_columns,_predicates,cardinality) => name === table ? value : cardinality === 'many' ? [] : null;
    expect(await selectReservationAutomationRoute(read,input)).toEqual({ path: 'dependency' });
  });
  it.each([
    ['active Datafy before adoption', [{ id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:input.unitId, provider:'datafy', status:'connected', is_active:true, created_at:'2026-10-01T00:00:00Z' }], 'paused'],
    ['disconnected but active Datafy', [{ id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:input.unitId, provider:'datafy', status:'disconnected', is_active:true, created_at:'2026-10-01T00:00:00Z' }], 'paused'],
    ['connected legacy NULL Datafy', [{ id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:input.unitId, provider:'datafy', status:'connected', is_active:null, created_at:'2026-10-01T00:00:00Z' }], 'paused'],
    ['UazAPI active with prepared Datafy', [
      { id:'aaaaaaaa-0000-0000-0000-000000000002', unit_id:input.unitId, provider:'datafy', status:'connected', is_active:false, created_at:'2026-10-01T00:00:00Z' },
      { id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:input.unitId, provider:'uazapi', status:'disconnected', is_active:true, created_at:'2026-09-01T00:00:00Z' },
    ], 'legacy'],
    ['legacy NULL UazAPI with prepared Datafy', [
      { id:'aaaaaaaa-0000-0000-0000-000000000002', unit_id:input.unitId, provider:'datafy', status:'connected', is_active:false, created_at:'2026-10-01T00:00:00Z' },
      { id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:input.unitId, provider:'uazapi', status:'connected', is_active:null, created_at:'2026-09-01T00:00:00Z' },
    ], 'legacy'],
    ['no operational channel', [], 'legacy'],
  ] as const)('%s does not let a new Datafy channel fall through to text', async (_label, channels, expected) => {
    const read: AutomationRouteReader = async (table) => {
      if (table === 'whatsapp_automation_jobs' || table === 'whatsapp_automation_adoptions') return null;
      if (table === 'platform_flags') return { value: true };
      if (table === 'whatsapp_template_bindings') return [];
      if (table === 'whatsapp_channels') return channels;
      throw new Error(`unexpected:${table}`);
    };
    expect(await selectReservationAutomationRoute(read,input, async () => ({auto_cohort:false,allowed:true}))).toEqual(expected === 'legacy'
      ? {path:'legacy'} : {path:'managed',existingJobId:null,selection:'paused'});
  });
  it('fails closed on ambiguous active channels, even before adoption', async () => {
    const read: AutomationRouteReader = async (table) => {
      if (table === 'whatsapp_automation_jobs' || table === 'whatsapp_automation_adoptions') return null;
      if (table === 'platform_flags') return {value:true};
      if (table === 'whatsapp_template_bindings') return [];
      if (table === 'whatsapp_channels') return [
        {id:'aaaaaaaa-0000-0000-0000-000000000001',unit_id:input.unitId,provider:'uazapi',status:'connected',is_active:true,created_at:'2026-09-01T00:00:00Z'},
        {id:'aaaaaaaa-0000-0000-0000-000000000002',unit_id:input.unitId,provider:'datafy',status:'connected',is_active:true,created_at:'2026-10-01T00:00:00Z'},
      ];
      throw new Error(`unexpected:${table}`);
    };
    expect(await selectReservationAutomationRoute(read,input)).toEqual({path:'dependency'});
  });
  it('checks the exact service fact before selecting a new managed intent, while durable jobs bypass this gate', async () => {
    const f = createAutomationEndpointIO();
    const calls: Array<[string,string]> = [];
    const read: AutomationRouteReader = async (table) => {
      if (table === 'whatsapp_automation_jobs') return null;
      if (table === 'whatsapp_automation_adoptions') return {adopted_at:'2026-10-01T00:00:00Z'};
      if (table === 'platform_flags') return {value:true};
      if (table === 'whatsapp_template_bindings') return [{dispatch_enabled:true,adopted_at:'2026-10-01T00:00:00Z'}];
      throw new Error(`unexpected:${table}`);
    };
    const route = (gate: unknown) => selectReservationAutomationRoute(read,input, async (kind,resourceId) => {
      calls.push([kind,resourceId]); return gate;
    });
    expect(await route({auto_cohort:true,allowed:false,reason_code:'service_not_enabled'})).toEqual({path:'disabled'});
    expect(await route({auto_cohort:true,allowed:false,reason_code:'dependency_unavailable'})).toEqual({path:'dependency'});
    expect(await route({auto_cohort:true,allowed:true,reason_code:'ready'}))
      .toEqual({path:'managed',existingJobId:null,selection:'scheduled'});
    expect(await route({auto_cohort:false,allowed:true}))
      .toEqual({path:'managed',existingJobId:null,selection:'scheduled'});
    expect(calls).toEqual(Array(4).fill(['confirmation',input.reservationId]));
    const existingRead: AutomationRouteReader = async table => table === 'whatsapp_automation_jobs'
      ? {...f.row,unit_id:input.unitId,reservation_id:input.reservationId,kind:'confirmation'}
      : Promise.reject(new Error('volatile_read_forbidden'));
    expect(await selectReservationAutomationRoute(existingRead,input,async () => { throw new Error('gate_forbidden'); }))
      .toEqual({path:'managed',existingJobId:f.jobId,selection:'scheduled'});
  });
  it.each([null, {}, {auto_cohort:true,allowed:true}, {auto_cohort:false,allowed:false},
    {auto_cohort:true,allowed:true,reason_code:'ready',extra:true}])('refuses malformed service route %#', async gate => {
    const read: AutomationRouteReader = async table => table === 'whatsapp_automation_jobs' ? null
      : table === 'whatsapp_automation_adoptions' ? {adopted_at:'2026-10-01T00:00:00Z'}
      : table === 'platform_flags' ? {value:true}
      : [{dispatch_enabled:true,adopted_at:'2026-10-01T00:00:00Z'}];
    expect(await selectReservationAutomationRoute(read,input,async () => gate)).toEqual({path:'dependency'});
  });
  it('refuses a channel row from another unit instead of treating Datafy as absent', async () => {
    const read: AutomationRouteReader = async (table) => {
      if (table === 'whatsapp_automation_jobs' || table === 'whatsapp_automation_adoptions') return null;
      if (table === 'platform_flags') return {value:true};
      if (table === 'whatsapp_template_bindings') return [];
      if (table === 'whatsapp_channels') return [{id:'aaaaaaaa-0000-0000-0000-000000000001',unit_id:input.reservationId,
        provider:'datafy',status:'connected',is_active:true,created_at:'2026-10-01T00:00:00Z'}];
      throw new Error(`unexpected:${table}`);
    };
    expect(await selectReservationAutomationRoute(read,input)).toEqual({path:'dependency'});
  });
});

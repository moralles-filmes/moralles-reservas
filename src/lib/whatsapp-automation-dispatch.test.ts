// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAutomationDispatcher } from '../../supabase/functions/_shared/whatsapp-automation-dispatch';
import { createAutomationFixture, createAutomationEndpointIO, createTemplateDispatchFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { createEdgeRequestHarness } from '../test/fixtures/edge-request-harness';
import { renderScheduledTemplate } from '../../supabase/functions/_shared/whatsapp-automation-resources';
import type { ScheduledIntent } from '../../supabase/functions/_shared/whatsapp-automation-core';

describe('scheduled authoritative resources', () => {
  it('fixture projects selected fields and rejects unknown query shapes and duplicate single rows', async () => {
    const f = createAutomationFixture();
    f.rows.organizations[0].private_field = 'synthetic-private';
    expect(await f.readOne('organizations', 'id', { id: f.ids.organization })).toEqual({ id: f.ids.organization });
    await expect(f.readOne('organizations', '*', { id: f.ids.organization })).rejects.toThrow('unexpected_fixture_query');
    await expect(f.readOne('organizations', 'id', { unknown: f.ids.organization })).rejects.toThrow('unexpected_fixture_query');
    f.rows.organizations.push({ id: f.ids.organization });
    await expect(f.readOne('organizations', 'id', { id: f.ids.organization })).rejects.toThrow('fixture_cardinality');
  });
  it('uses the resource organization, canonical DDD55 and normalized database time', async () => {
    const f = createAutomationFixture();
    const result = await f.resources.loadScheduledResource(f.intent);
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.resource.phone).toBe('55912345678');
    expect(result.resource.e164).toBe('5555912345678');
    expect(result.resource.time).toBe('20:30');
    expect(result.resource.organizationId).toBe(f.ids.organization);
  });
  it.each(['pending', 'cancelled', 'no_show'] as const)('refuses confirmation status %s without promoting it', async status => {
    const f = createAutomationFixture();
    f.rows.reservations[0].status = status;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false,
      reason: status === 'pending' ? 'reservation_pending' : 'reservation_not_confirmed' });
    expect(f.rows.reservations[0].status).toBe(status);
  });
  it.each(['pending_payment', 'failed', 'refunded', 'expired', '', 'unknown'])('refuses confirmation payment %s', async payment => {
    const f = createAutomationFixture();
    f.rows.reservations[0].payment_status = payment;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'payment_incompatible' });
  });
  it.each([null, 'not_required', 'paid'])('accepts confirmed compatible payment %s', async payment => {
    const f = createAutomationFixture();
    f.rows.reservations[0].payment_status = payment;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true });
  });
  it('refuses a body unit assertion against the actual resource', async () => {
    const f = createAutomationFixture();
    expect(await f.resources.loadScheduledResource({ ...f.intent, unitId: f.ids.foreignUnit }))
      .toMatchObject({ ok: false, reason: 'recipient_changed' });
  });
  it('rejects a foreign customer organization and a deleted customer', async () => {
    const f = createAutomationFixture();
    f.rows.customers[0].organization_id = f.ids.foreignUnit;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'customer_not_alive' });
    f.rows.customers[0].organization_id = f.ids.organization;
    f.rows.customers[0].deleted_at = f.nowISO;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'customer_not_alive' });
  });
  it('refuses invalid IANA but defaults an absent timezone', async () => {
    const f = createAutomationFixture();
    f.rows.units[0].timezone = 'not/a-zone';
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'invalid_timezone' });
    f.rows.units[0].timezone = null;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true, resource: { timezone: 'America/Sao_Paulo' } });
  });
  it.each(['america/sao_paulo', 'utc'])('preserves recognized case-insensitive IANA %s in expected capture', async timezone => {
    const f = createAutomationFixture(); f.rows.units[0].timezone = timezone;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true, resource: { timezone, expected: { unit: { timezone } } } });
  });
  it('captures real NULL name/slug/timezone while retaining the actual renderer fallback', async () => {
    const f = createAutomationFixture();
    f.rows.customers[0].name = null; f.rows.units[0].slug = null; f.rows.units[0].timezone = null;
    const loaded = await f.resources.loadScheduledResource(f.intent);
    expect(loaded).toMatchObject({ ok: true, resource: { customerName: '', timezone: 'America/Sao_Paulo',
      expected: { customer: { name: null }, unit: { slug: null, timezone: null } } } });
    if (!loaded.ok) throw new Error('unexpected capture refusal');
    expect(renderScheduledTemplate(loaded.resource, 'https://example.com', ['https://example.com']).parameters[0]).toBe('cliente');
  });
  it.each([['customers','name'], ['units','slug'], ['units','timezone']] as const)('does not fabricate NULL from undefined %s.%s', async (table, field) => {
    const f = createAutomationFixture(); f.rows[table][0][field] = undefined;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'render_invalid' });
  });
  it.each([['customers','name'], ['units','slug'], ['units','timezone']] as const)('does not fabricate NULL from a non-string %s.%s', async (table, field) => {
    const f = createAutomationFixture(); f.rows[table][0][field] = { unexpected: true };
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false });
  });
  it.each([['source',null], ['party_size',null], ['party_size','4'], ['reservation_code',null], ['time','25:00:00'], ['date','2026-02-30']])('refuses uncapturable reservation %s=%s', async (field,value) => {
    const f = createAutomationFixture(); f.rows.reservations[0][String(field)] = value;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false });
  });
  it('retains the original deadline after rescheduling', async () => {
    const f = createAutomationFixture();
    f.rows.reservations[0].date = '2026-10-07';
    f.setNow('2026-10-06T00:00:00Z');
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'expired' });
  });
  it('snapshot changes when the same customer phone changes', async () => {
    const f = createAutomationFixture();
    const first = await f.resources.loadScheduledResource(f.intent);
    f.rows.customers[0].phone = '11987654321';
    const second = await f.resources.loadScheduledResource(f.intent);
    if (first.ok === false || second.ok === false) throw new Error('fixture unexpectedly refused');
    expect(second.resource.snapshot).not.toBe(first.resource.snapshot);
  });
});

function waitlistFixture(kind: 'waitlist_entered' | 'waitlist_feedback' = 'waitlist_entered') {
  const f = createAutomationFixture();
  const waitlistId = 'eeeeeeee-0000-0000-0000-000000000002';
  f.rows.waitlist.push({ id: waitlistId, unit_id: f.ids.unit, customer_id: null, customer_name: 'Nome da fila',
    customer_phone: '55912345678', party_size: 3, code: 12, status: kind === 'waitlist_entered' ? 'waiting' : 'seated',
    created_at: '2026-10-05T14:00:00Z', seated_at: kind === 'waitlist_feedback' ? '2026-10-04T19:00:00Z' : null });
  const intent: ScheduledIntent = { kind, unitId: f.ids.unit, waitlistId, sourceEventKey: 'synthetic-current-entry',
    factAt: kind === 'waitlist_entered' ? '2026-10-05T14:00:00Z' : '2026-10-04T23:59:00-03:00' };
  return { ...f, intent };
}
function voucherFixture() {
  const f = createAutomationFixture();
  const voucherId = 'eeeeeeee-0000-0000-0000-000000000003', ruleId = 'eeeeeeee-0000-0000-0000-000000000004';
  f.rows.vouchers.push({ id: voucherId, unit_id: f.ids.unit, customer_id: f.ids.customer, rule_id: ruleId, code: 'VCH12345',
    discount_percent: 15, status: 'active', issued_at: f.nowISO, created_at: f.nowISO, expires_at: '2026-10-15T23:59:59-03:00' });
  f.rows.voucher_rules.push({ id: ruleId, unit_id: f.ids.unit, trigger_type: 'birthday' });
  const intent: ScheduledIntent = { kind: 'voucher_issued', unitId: f.ids.unit, voucherId, sourceEventKey: 'existing-job-only', factAt: f.nowISO };
  return { ...f, intent };
}
describe('waitlist and existing benefit resource contracts', () => {
  it.each(['2026-02-30T14:00:00Z', 'infinity', '2026-10-05T25:00:00Z', '999999-10-05T14:00:00Z'])('does not capture invalid mandatory timestamptz %s', async value => {
    const f = waitlistFixture(); f.rows.waitlist[0].created_at = value;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'render_invalid' });
  });
  it('permits operational entry without manufacturing a customer', async () => {
    const f = waitlistFixture(); f.rows.customers = [];
    const result = await f.resources.loadScheduledResource(f.intent);
    expect(result).toMatchObject({ ok: true, resource: { customerId: null, customerName: 'Nome da fila', code: 12 } });
    expect(f.rows.customers).toEqual([]);
  });
  it('resolves a nullable entry customer within the same organization and canonical row phone', async () => {
    const f = waitlistFixture();
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true, resource: { customerId: f.ids.customer } });
    expect(f.calls.find(call => call.table === 'customers')?.predicates).toEqual({ organization_id: f.ids.organization, phone: '55912345678' });
  });
  it('rejects a non-null entry FK whose phone differs from the row', async () => {
    const f = waitlistFixture(); f.rows.waitlist[0].customer_id = f.ids.customer; f.rows.waitlist[0].customer_phone = '11987654321';
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'recipient_changed' });
  });
  it('does not use a same-phone foreign organization customer', async () => {
    const f = waitlistFixture('waitlist_feedback'); f.rows.customers[0].organization_id = f.ids.foreignUnit;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'customer_not_alive' });
  });
  it('requires seated and the original BRT target day for feedback', async () => {
    const f = waitlistFixture('waitlist_feedback');
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true });
    f.rows.waitlist[0].seated_at = '2026-10-05T14:00:00Z';
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'waitlist_wrong_day' });
    f.rows.waitlist[0].status = 'waiting';
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'waitlist_not_seated' });
  });
  it('preserves exact entry expiry equality and expires one millisecond later', async () => {
    const f = waitlistFixture(); f.setNow('2026-10-05T16:00:00Z');
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: true });
    f.setNow('2026-10-05T16:00:00.001Z');
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'expired' });
  });
  it.each(['used', 'expired', 'cancelled'])('refuses voucher status %s without changing the benefit', async status => {
    const f = voucherFixture(); f.rows.vouchers[0].status = status;
    const before = JSON.stringify(f.rows.vouchers);
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'voucher_not_active' });
    expect(JSON.stringify(f.rows.vouchers)).toBe(before);
  });
  it('refuses after_rating and foreign rules', async () => {
    const f = voucherFixture(); f.rows.voucher_rules[0].trigger_type = 'after_rating';
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'voucher_changed' });
    f.rows.voucher_rules[0].trigger_type = 'frequency'; f.rows.voucher_rules[0].unit_id = f.ids.foreignUnit;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'voucher_changed' });
  });
  it('requires benefit expiry to be strictly future independently of message TTL', async () => {
    const f = voucherFixture(); f.rows.vouchers[0].expires_at = f.nowISO;
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'voucher_expired' });
  });
  it('reads the actual per-unit enablement setting', async () => {
    const f = voucherFixture(); f.rows.settings.push({ unit_id: f.ids.unit, key: 'giftback_whatsapp_enabled', value: 'false' });
    expect(await f.resources.loadScheduledResource(f.intent)).toMatchObject({ ok: false, reason: 'dispatch_paused' });
  });
});

describe('official render from real resources', () => {
  it('retains the feedback slug NULL refusal even when capture preserves real NULL', async () => {
    const f = waitlistFixture('waitlist_feedback'); f.rows.units[0].slug = null;
    const result = await f.resources.loadScheduledResource(f.intent);
    if (!result.ok) throw new Error('unexpected capture refusal');
    expect(result.resource.expected.unit.slug).toBeNull();
    expect(() => renderScheduledTemplate(result.resource, 'https://example.com', ['https://example.com'], 'A'.repeat(43))).toThrow('render_invalid');
  });
  it('selects discounted confirmation without changing the kind or resource', async () => {
    const f = createAutomationFixture(); f.rows.reservations[0].applied_discount_percent = 15;
    const result = await f.resources.loadScheduledResource(f.intent);
    if (result.ok === false) throw new Error('fixture unexpectedly refused');
    const rendered = renderScheduledTemplate(result.resource, 'https://example.com', ['https://example.com']);
    expect(result.resource.templateId).toBe('res_confirmacao_desconto_v1');
    expect(result.resource.intent.kind).toBe('confirmation');
    expect(rendered.parameters).toEqual(['Marina','Restaurante Exemplo','05/10/2026','20:30','4','RES123','15',`https://example.com/acompanhar/${f.ids.reservation}`]);
  });
  it('uses actual slug for feedback and redacts only the preference token in history', async () => {
    const f = waitlistFixture('waitlist_feedback');
    const result = await f.resources.loadScheduledResource(f.intent);
    if (result.ok === false) throw new Error('fixture unexpectedly refused');
    const token = 'A'.repeat(43);
    const rendered = renderScheduledTemplate(result.resource, 'https://example.com', ['https://example.com'], token);
    expect(rendered.body).toContain('https://example.com/r/exemplo');
    expect(rendered.body).toContain(`/preferencias/mensagens/${token}`);
    expect(rendered.safeLogBody).not.toContain(token);
    expect(rendered.safeLogBody).toContain('/preferencias/mensagens/[redacted]');
    expect(rendered.footer).toBe('Para não receber ofertas, use o link de preferências.');
  });
  it.each(['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com?next=x','https://foreign.example'])('refuses invalid base %s', async base => {
    const f = createAutomationFixture(); const result = await f.resources.loadScheduledResource(f.intent);
    if (result.ok === false) throw new Error('fixture unexpectedly refused');
    expect(() => renderScheduledTemplate(result.resource, base, ['https://example.com'])).toThrow();
  });
  it('uses the catalogue fallback greeting and rejects missing real codes', async () => {
    const f = createAutomationFixture(); f.rows.customers[0].name = null;
    const result = await f.resources.loadScheduledResource(f.intent);
    if (result.ok === false) throw new Error('fixture unexpectedly refused');
    expect(renderScheduledTemplate(result.resource, 'https://example.com', ['https://example.com']).body).toContain('Olá, cliente.');
    expect(() => renderScheduledTemplate({ ...result.resource, code: '' }, 'https://example.com', ['https://example.com'])).toThrow();
  });
});
import { createDispatchFixture } from '../test/fixtures/whatsapp-automation-fixtures';

describe('actual dispatcher acceptance and final lease', () => {
  it('accepted local response loss repairs on second dispatch with exactly one adapter invocation', async () => {
    const f = createDispatchFixture({ finalizeFailsOnce: true });
    await f.dispatch();
    await f.dispatch();
    expect(f.calls.post).toBe(1);
    expect(f.calls.reconcile).toBeGreaterThan(0);
    expect(f.row.state).toBe('reconciled');
    expect(f.row.provider_message_id).toBe('native-test-1');
  });
  it('final async lease gap reaches readonly confirm and never invokes the adapter or invents local refusal', async () => {
    const f = createDispatchFixture({ finalLeaseGap: true });
    await f.dispatch();
    expect(f.calls.operations).toContain('prepare_whatsapp_automation_post');
    expect(f.calls.operations).toContain('confirm_whatsapp_automation_resource_post');
    expect(f.calls.post).toBe(0);
    expect(f.calls.finishes).toEqual([]);
    expect(f.calls.sqlNow).toBeGreaterThan(Date.parse(String(f.row.claimed_until)));
  });
  it('failure before any durable acceptance cannot manufacture an ID on second dispatch', async () => {
    const f = createDispatchFixture({ beforeCommitFailure: true });
    await f.dispatch();
    await f.dispatch();
    expect(f.calls.post).toBe(1);
    expect(f.calls.reconcile).toBe(0);
    expect(f.row.provider_message_id).toBeNull();
  });
});

describe('actual dispatcher state and drift controls', () => {
  it.each(['queued','claimed','retry_wait','blocked','paused'])('keeps actual %s when SQL refuses ownership/requeue', async state => {
    const f = createDispatchFixture(); f.row.state = state; f.controls.claimReturnsNull = true; f.controls.requeueReturnsFalse = true;
    expect(await f.dispatch()).toMatchObject({ state: state === 'blocked' || state === 'paused' ? 'blocked' : 'queued', jobId: f.jobId });
    expect(f.calls.post).toBe(0); expect(f.calls.finishes).toEqual([]);
  });
  it('preserves saved TEXT chips and customization', async () => {
    const f = createDispatchFixture(); f.row.kind = 'reminder_d1'; f.row.initial_catalog_key = 'res_lembrete_dia_v1';
    const dispatcher = createAutomationDispatcher({ ...f.io, readOne: async (table, columns, filters, latest) => {
      if (table === 'reservation_message_templates' && columns === 'customized,body' && filters.unit_id === f.ids.unit && filters.event === 'reminder_d1')
        return { customized: true, body: 'Minha mensagem {{cliente_nome}} {{horario}} {{party_size}} #{{codigo}} {{unidade_nome}} {{link_acompanhamento}}' };
      return f.io.readOne(table, columns, filters, latest);
    } });
    await dispatcher.dispatchExistingJob(f.jobId);
    expect(f.calls.bodies).toEqual([`Minha mensagem Marina 20:30 4 #RES123 Restaurante Exemplo https://example.com/acompanhar/${f.ids.reservation}`]);
  });
  it('oversized saved TEXT records render_invalid before SQL prepare', async () => {
    const f = createDispatchFixture(); f.row.kind = 'reminder_d1'; f.row.initial_catalog_key = 'res_lembrete_dia_v1';
    const dispatcher = createAutomationDispatcher({ ...f.io, readOne: async (table, columns, filters, latest) => table === 'reservation_message_templates'
      ? { customized: true, body: 'x'.repeat(4097) } : f.io.readOne(table, columns, filters, latest) });
    await dispatcher.dispatchExistingJob(f.jobId); expect(f.row.error_code).toBe('render_invalid'); expect(f.calls.post).toBe(0);
    expect(f.calls.operations).not.toContain('prepare_whatsapp_automation_post');
  });
  it.each(['accepted','reconciled'])('repairs durable %s before reading erased resource or paused gate', async state => {
    const f = createDispatchFixture();
    Object.assign(f.row, { state, provider_message_id: 'native-erased', customer_id: null, safe_log_body: null, customer_erased_at: f.nowISO });
    f.rows.reservations.length = 0; f.controls.gate = false;
    expect((await f.dispatch()).state).toBe('reconciled');
    expect(f.calls.post).toBe(0); expect(f.calls.reconcile).toBe(1);
    expect(f.calls.operations).toEqual(['read:whatsapp_automation_jobs']);
  });
  it.each(['uncertain','posting','needs_review','expired','failed','rejected'])('does not restart %s', async state => {
    const f = createDispatchFixture(); f.row.state = state;
    await f.dispatch(); expect(f.calls.post).toBe(0);
    expect(f.calls.operations).toEqual(['read:whatsapp_automation_jobs']);
  });
  it.each(['unselected','unbound','missing_template'])('preserves visible incomplete %s without claim', async shape => {
    const f = createDispatchFixture();
    Object.assign(f.row, { state: 'blocked', pin_phase: 'preconfiguration', binding_id: null, binding_generation: null });
    if (shape === 'unselected') Object.assign(f.row, { channel_id: null, provider: null, transport: null, initial_credential_revision: null });
    if (shape === 'missing_template') Object.assign(f.row, { provider: 'datafy', transport: 'template', binding_id: '44444444-0000-4000-8000-000000000001', binding_generation: 1, account_id: '66666666-0000-4000-8000-000000000001' });
    expect(await f.dispatch()).toMatchObject({ state: 'blocked', pinPhase: 'preconfiguration', jobId: f.jobId });
    expect(f.calls.post).toBe(0); expect(f.calls.operations).toEqual(['read:whatsapp_automation_jobs']);
  });
  it.each(['pending','cancelled','no_show'])('blocks reservation %s with original claim and no prepare/attempt', async state => {
    const f = createDispatchFixture(); f.rows.reservations[0].status = state;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.row.attempts).toBe(0);
    expect(f.calls.operations).toContain('block_whatsapp_automation_preflight');
    expect(f.calls.operations).not.toContain('prepare_whatsapp_automation_post');
  });
  it.each(['phone','date','status','payment_status'])('refuses final same-ID %s drift before adapter', async field => {
    const f = createDispatchFixture();
    f.controls.afterPrepare = () => {
      if (field === 'phone') f.rows.customers[0].phone = '11912345678';
      else f.rows.reservations[0][field] = field === 'date' ? '2026-10-06' : field === 'status' ? 'cancelled' : 'refunded';
    };
    await f.dispatch(); expect(f.calls.post).toBe(0);
    expect(f.calls.finishes).toEqual([{ outcome: 'local_preflight_refused', reason: 'final_resource_changed' }]);
    expect(f.row.attempts).toBe(0);
  });
  it('uses confirm as final await immediately before the last closure', async () => {
    const f = createDispatchFixture(); await f.dispatch();
    const index = f.calls.operations.indexOf('adapter');
    expect(f.calls.operations.slice(index - 2, index + 1)).toEqual(['channel:prepare','confirm_whatsapp_automation_resource_post','adapter']);
    expect(f.calls.bodies[0]).toContain('*Reserva Confirmada!*');
  });
  it.each(['phone','status','payment_status','date','time'])('proves final RPC boundary for %s changed DURING last channel prepare', async field => {
    const f = createDispatchFixture();
    f.controls.duringLastPrepare = () => {
      if (field === 'phone') f.rows.customers[0].phone = '11912345678';
      else f.rows.reservations[0][field] = { status: 'cancelled', payment_status: 'refunded', date: '2026-10-06', time: '21:00:00' }[field];
      // Scripted database response, NOT a fixture implementation of SQL comparison.
      f.controls.resourceConfirm = { allowed: false, reason: 'resource_changed' };
    };
    await f.dispatch();
    expect(f.calls.post).toBe(0);
    expect(f.calls.resourceConfirms).toHaveLength(1);
    expect(f.calls.resourceConfirms[0].p_expected).toMatchObject({ version: 1, kind: 'confirmation', resource: { date: '2026-10-05', time: '20:30:00', status: 'confirmed' }, customer: { phone: '55912345678' } });
    expect(f.calls.finishes).toEqual([{ outcome: 'local_preflight_refused', reason: 'final_resource_changed' }]);
    expect(f.row.fact_at).toBe(f.intent.factAt);
  });
  it.each([true, false, null, {}, { allowed: true, reason: 'resource_changed' }, { allowed: false }, { allowed: false, reason: 'unknown' }, { allowed: false, reason: 'authority_changed' }, { allowed: false, reason: 'snapshot_invalid' }])('does not invent a reset for a refused/malformed final DTO %j', async result => {
    const f = createDispatchFixture(); f.controls.resourceConfirm = result;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.calls.finishes).toEqual([]); expect(f.row.state).toBe('posting');
  });
  it.each(['status','customer_phone','seated_at'])('waitlist %s drift during LAST channel preparation reaches closed resource refusal', async field => {
    const f = await createTemplateDispatchFixture(true);
    f.controls.duringLastPrepare = () => {
      f.rows.waitlist[0][field] = { status: 'cancelled', customer_phone: '11912345678', seated_at: '2026-10-05T14:00:00Z' }[field];
      f.controls.resourceConfirm = { allowed: false, reason: 'resource_changed' };
    };
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.calls.resourceConfirms).toHaveLength(1);
    expect(f.calls.resourceConfirms[0].p_expected).toMatchObject({ kind: 'waitlist_feedback', resource: { status: 'seated', customer_phone: '55912345678', seated_at: '2026-10-04T15:00:00Z' } });
    expect(f.calls.finishes).toEqual([{ outcome: 'local_preflight_refused', reason: 'final_resource_changed' }]);
  });
  it.each(['status','expires_at','rule_id'])('voucher %s drift during LAST prepare refuses the existing benefit without a POST', async field => {
    const f = createDispatchFixture(), v = voucherFixture();
    f.rows.vouchers = v.rows.vouchers; f.rows.voucher_rules = v.rows.voucher_rules;
    Object.assign(f.row, { kind: 'voucher_issued', reservation_id: null, voucher_id: v.intent.voucherId, fact_at: v.intent.factAt,
      expires_at: '2026-10-12T15:00:00Z', initial_catalog_key: 'mkt_voucher_programado_v1' });
    f.consentEvents.push({ unit_id: f.ids.unit, customer_id: f.ids.customer, purpose: 'promotional', decision: 'opt_in', revision: 1 });
    const io = { ...f.io, readOne: async (table: string, columns: string, filters: Readonly<Record<string,string>>, latest?: string) => table === 'settings' && filters.key === 'giftback_message_template' ? null : f.io.readOne(table,columns,filters,latest),
      rpc: async (name: string, args: Record<string,unknown>) => name === 'issue_whatsapp_preference_token' ? true : f.io.rpc(name,args) };
    f.controls.duringLastPrepare = () => {
      f.rows.vouchers[0][field] = { status: 'used', expires_at: f.nowISO, rule_id: f.ids.foreignUnit }[field];
      f.controls.resourceConfirm = { allowed: false, reason: 'resource_changed' };
    };
    await createAutomationDispatcher(io).dispatchExistingJob(f.jobId);
    expect(f.calls.post).toBe(0); expect(f.calls.resourceConfirms).toHaveLength(1);
    expect(f.calls.resourceConfirms[0].p_expected).toMatchObject({ kind: 'voucher_issued', resource: { status: 'active', discount_percent: 15, code: 'VCH12345' } });
    expect(f.calls.finishes).toEqual([{ outcome: 'local_preflight_refused', reason: 'final_resource_changed' }]);
  });
  it.each(['throw','missing_id'])('invoked %s remains uncertain and never uses known-zero reset', async scenario => {
    const f = createDispatchFixture(); f.controls.adapterThrow = scenario === 'throw'; if (scenario === 'missing_id') f.controls.messageId = '';
    expect((await f.dispatch()).state).toBe('uncertain'); await f.dispatch();
    expect(f.calls.post).toBe(1); expect(f.calls.reconcile).toBe(0);
    expect(f.calls.finishes).toEqual([{ outcome: 'uncertain', reason: scenario === 'throw' ? 'post_ambiguous' : 'response_invalid' }]);
  });
  it('records a final gate pause with zero POST and no attempt consumption', async () => {
    const f = createDispatchFixture(); f.controls.afterPrepare = () => { f.controls.gate = false; };
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.row.attempts).toBe(0);
    expect(f.calls.finishes[0]).toMatchObject({ reason: 'final_gate_paused' });
  });
  it('malformed flag cannot masquerade as OFF', async () => {
    const f = createDispatchFixture(); f.controls.gate = 'false'; await f.dispatch();
    expect(f.row.error_code).toBe('dependency_unavailable'); expect(f.calls.post).toBe(0);
  });
  it('last current credential revision must match initial preparation, not historical revision', async () => {
    const f = createDispatchFixture(); f.row.initial_credential_revision = 0; f.controls.finalRevision = 2;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.calls.finishes[0]).toMatchObject({ reason: 'final_channel_changed' });
  });
});

describe('actual send-scheduled-whatsapp Request/authentication', () => {
  it('actual SDK handler refuses malformed final DTO before invoking its real adapter closure', async () => {
    const f = createAutomationEndpointIO('owner', true); f.controls.resourceConfirm = { allowed: true, extra: true };
    let posts = 0;
    const harness = createEdgeRequestHarness({ now: Date.parse(f.nowISO),
      env: { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SUPABASE_ANON_KEY: 'synthetic-anon', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
      createClient: () => f.db,
      transport: [{ method: 'POST', url: 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text', respond: async () => {
        posts++; return new Response(JSON.stringify({ messageId: 'must-not-be-invoked' }), { status: 200 });
      } }],
    });
    try {
      const response = await harness.request('send-scheduled-whatsapp', new Request('https://synthetic.invalid/functions/v1/send-scheduled-whatsapp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': 'synthetic-internal' }, body: JSON.stringify({ action: 'dispatch_existing', job_id: f.jobId }) }));
      expect(response.status).toBe(200); expect(f.unexpected).toEqual([]);
      expect(f.calls.resourceConfirms).toHaveLength(1); expect(posts).toBe(0); expect(f.calls.finishes).toEqual([]);
      expect(f.row.state).toBe('posting'); expect(f.row.provider_message_id).toBeNull();
    } finally { harness.dispose(); }
  });
  it('runs SDK handler through actual resources, Task8 last channel and one real adapter fetch', async () => {
    const f = createAutomationEndpointIO('owner', true);
    let posts = 0;
    const harness = createEdgeRequestHarness({ now: Date.parse(f.nowISO),
      env: { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SUPABASE_ANON_KEY: 'synthetic-anon', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
      createClient: () => f.db,
      transport: [{ method: 'POST', url: 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text', respond: async req => {
        posts++; expect(await req.json()).toMatchObject({ phone: '5555912345678' });
        return new Response(JSON.stringify({ messageId: 'actual-adapter-native' }), { status: 200 });
      } }],
    });
    try {
      const invoke = () => harness.request('send-scheduled-whatsapp', new Request('https://synthetic.invalid/functions/v1/send-scheduled-whatsapp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': 'synthetic-internal' }, body: JSON.stringify({ action: 'dispatch_existing', job_id: f.jobId }) }));
      const result = await invoke();
      expect(f.unexpected).toEqual([]); expect(await result.json()).toMatchObject({ state: 'reconciled' });
      await invoke(); expect(posts).toBe(1); expect(f.row.provider_message_id).toBe('actual-adapter-native');
      expect(f.queries.filter(q => q.table === 'whatsapp_template_bindings')).toHaveLength(2);
      expect(f.calls.resourceConfirms).toHaveLength(1);
      expect(f.calls.resourceConfirms[0].p_expected).toMatchObject({ version: 1, kind: 'confirmation' });
    } finally { harness.dispose(); }
  });
  async function request(role: Parameters<typeof createAutomationEndpointIO>[0], body: unknown, headers: Record<string, string> = {}) {
    const f = createAutomationEndpointIO(role);
    const harness = createEdgeRequestHarness({ now: Date.parse(f.nowISO),
      env: { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SUPABASE_ANON_KEY: 'synthetic-anon',
        INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' }, createClient: () => f.db });
    try {
      const response = await harness.request('send-scheduled-whatsapp', new Request('https://synthetic.invalid/functions/v1/send-scheduled-whatsapp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
      return { f, status: response.status, body: await response.json() };
    } finally { harness.dispose(); }
  }
  it('rejects internal intent with a JWT and no internal key before any database I/O', async () => {
    const result = await request('owner', { action: 'dispatch', kind: 'confirmation', resource_id: 'eeeeeeee-0000-0000-0000-000000000001' }, { Authorization: 'Bearer synthetic-jwt' });
    expect(result.status).toBe(401); expect(result.f.queries).toEqual([]); expect(result.f.calls.post).toBe(0);
  });
  it.each(['owner','gerente','operador','platform_admin'] as const)('authorized %s repairs the existing ledger via actual facade and handler', async role => {
    const seed = createAutomationEndpointIO(role);
    const result = await request(role, { action: 'resend', kind: 'confirmation', resource_id: seed.ids.reservation, unit_id: seed.ids.unit }, { Authorization: 'Bearer synthetic-jwt' });
    expect(result.status).toBe(200); expect(result.body.state).toBe('reconciled'); expect(result.f.calls.reconcile).toBe(1);
    expect(result.f.calls.post).toBe(0); expect(result.f.unexpected).toEqual([]);
  });
  it.each(['foreign','outsider','invalid'] as const)('rejects %s before service ledger access', async role => {
    const seed = createAutomationEndpointIO(role);
    const result = await request(role, { action: 'resend', kind: 'confirmation', resource_id: seed.ids.reservation, unit_id: seed.ids.unit }, { Authorization: 'Bearer synthetic-jwt' });
    expect([401,403]).toContain(result.status); expect(result.f.queries.some(q => q.table === 'whatsapp_automation_jobs')).toBe(false);
    expect(result.f.calls.reconcile).toBe(0);
  });
  it('refuses caller timestamps and unknown actions and invalid JSON', async () => {
    for (const body of ['{', { action: 'initialize_job' }, { action: 'dispatch_existing', job_id: '11111111-0000-4000-8000-000000000001', fact_at: '2026-10-05T00:00:00Z' }]) {
      const result = await request('owner', body, { 'x-internal-key': 'synthetic-internal' });
      expect(result.status).toBe(400); expect(result.f.queries).toEqual([]);
    }
  });
});

describe('actual template dispatcher rendering and consent I/O', () => {
  it('uses actual channel target, pinned v1 pt_BR and ordered parameters', async () => {
    const f = await createTemplateDispatchFixture(); await f.dispatch();
    expect(f.calls.post).toBe(1);
    expect(f.sent[0]).toMatchObject({ phoneNumberId: '1234567890', toPhone: '55912345678', name: 'res_confirmacao_v1', language: 'pt_BR' });
    expect(f.sent[0].parameters).toEqual(['Marina','Restaurante Exemplo','05/10/2026','20:30','4','RES123',`https://example.com/acompanhar/${f.ids.reservation}`]);
  });
  it.each([
    ['version',2], ['language','en_US'], ['name','other_v1'], ['observed_hash','wrong'], ['desired_hash','wrong'],
    ['requested_category','MARKETING'], ['effective_category','MARKETING'], ['local_status','blocked'], ['remote_status','PENDING'], ['remote_id',null],
  ])('refuses template %s drift', async (key, value) => {
    const f = await createTemplateDispatchFixture(); f.template[String(key)] = value; await f.dispatch();
    expect(f.calls.post).toBe(0); expect(f.row.error_code).toBe('template_unavailable');
  });
  it('stale GET failure is visible and never uses stale approval', async () => {
    const f = await createTemplateDispatchFixture(); f.template.last_synced_at = '2026-10-05T14:58:00Z'; f.templateControls.syncFails = true;
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.row.error_code).toBe('template_sync_failed');
  });
  it('persists only a cryptographic hash and freezes redacted safe history', async () => {
    const f = await createTemplateDispatchFixture(true); await f.dispatch();
    expect(f.calls.post).toBe(1); expect(f.hashes).toHaveLength(1); expect(f.hashes[0]).toMatch(/^[a-f0-9]{64}$/);
    const raw = f.sent[0].parameters.at(-1)?.split('/').at(-1);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(String(f.row.safe_log_body)).toContain('[redacted]');
    expect(JSON.stringify(f.row)).not.toContain(raw); expect(f.hashes[0]).not.toBe(raw);
  });
  it.each(['unknown','opt_out'])('does not infer promotional consent from %s/DNC=false', async decision => {
    const f = await createTemplateDispatchFixture(true); f.consentEvents[0].decision = decision; await f.dispatch();
    expect(f.calls.post).toBe(0); expect(f.hashes).toEqual([]); expect(f.row.error_code).toBe('consent_changed');
  });
  it('same-purpose final consent change requests the existing closed refusal (SQL result scripted)', async () => {
    const f = await createTemplateDispatchFixture(true); f.controls.afterPrepare = () => { f.consentEvents.push({ ...f.consentEvents[0], decision: 'opt_out', revision: 2 }); };
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.calls.finishes[0]).toMatchObject({ reason: 'final_consent_changed' });
  });
  it('respects SQL cost/slot refusal without an adapter call', async () => {
    const f = await createTemplateDispatchFixture(true); f.templateControls.prepareResult = false; await f.dispatch();
    expect(f.calls.post).toBe(0); expect(f.calls.finishes).toEqual([]);
  });
  it('only adapter-documented preproxy 429 carries a provider wait to SQL', async () => {
    const f = await createTemplateDispatchFixture();
    f.templateControls.outcome = { state: 'rejected', status: 429, retryable: true, retryAfterSeconds: 125, error: 'datafy_template_http_429', errorCode: 'RATE_LIMITED' };
    expect((await f.dispatch()).state).toBe('queued'); expect(f.row.state).toBe('retry_wait'); expect(f.calls.post).toBe(1);
    expect(f.calls.finishes[0]).toEqual({ outcome: 'rejected', reason: 'documented_preproxy_429', retry_after_seconds: 125 });
    f.controls.claimReturnsNull = true; // The real claim SQL owns retry_at/backoff; this is its scripted refusal.
    expect((await f.dispatch()).state).toBe('queued'); expect(f.row.state).toBe('retry_wait'); expect(f.calls.post).toBe(1);
  });
  it('scripted fifth-attempt durable rejection is terminal without a sixth POST', async () => {
    const f = await createTemplateDispatchFixture();
    f.controls.afterPrepare = () => { f.row.attempts = 5; };
    f.controls.durableRejection = { state: 'rejected', retry_at: null };
    f.templateControls.outcome = { state: 'rejected', status: 429, retryable: true, retryAfterSeconds: 4000, error: 'datafy_template_http_429', errorCode: 'RATE_LIMITED' };
    expect((await f.dispatch()).state).toBe('failed'); expect(f.row.state).toBe('rejected');
    expect(f.row.attempts).toBe(5); expect(f.calls.finishes[0]).toMatchObject({ retry_after_seconds: 4000 });
    const count = f.calls.operations.length; expect((await f.dispatch()).state).toBe('failed');
    expect(f.calls.operations.slice(count)).toEqual(['read:whatsapp_automation_jobs']); expect(f.calls.post).toBe(1);
  });
});

describe('trusted producer provenance and bounded adapter', () => {
  it.each(['voucher_issued','confirmation'] as const)('missing %s producer proof never enqueues', async kind => {
    const f = createDispatchFixture(); let enqueues = 0;
    const dispatcher = createAutomationDispatcher({ ...f.io,
      readOne: async (table, columns, filters, latest) => {
        if (table === 'whatsapp_automation_jobs' && filters.kind) return null;
        if (table === 'reservations' && columns === '*') return { ...f.rows.reservations[0] };
        if (table === 'whatsapp_automation_adoptions') return { adopted_at: '2026-10-05T00:00:00Z' };
        return f.io.readOne(table, columns, filters, latest);
      },
      rpc: async (name, args) => { if (name === 'enqueue_whatsapp_automation') enqueues++; return f.io.rpc(name, args); },
    });
    expect(await dispatcher.dispatchScheduledIntent({ kind, resourceId: f.ids.reservation, unitId: f.ids.unit })).toMatchObject({ state: 'not_enqueued', reason: 'provenance_refused' });
    expect(enqueues).toBe(0); expect(f.calls.post).toBe(0);
  });
  it.each(['before_adoption','wrong_resource','wrong_unit','valid_manual_notify'] as const)('actual outbox %s determines authority', async scenario => {
    const f = createDispatchFixture(); const enqueued: Record<string, unknown>[] = [];
    f.rows.reservations[0].source = 'whatsapp';
    const outboxId = '00000000-0000-4000-8000-000000000001';
    const dispatcher = createAutomationDispatcher({ ...f.io,
      readOne: async (table, columns, filters, latest) => {
        if (table === 'whatsapp_automation_jobs' && filters.kind) return null;
        if (table === 'reservations' && columns === '*') return { ...f.rows.reservations[0] };
        if (table === 'whatsapp_automation_adoptions') return { adopted_at: '2026-10-05T00:00:00Z' };
        if (table === 'notification_outbox' && filters.id === outboxId) return { id: outboxId,
          unit_id: scenario === 'wrong_unit' ? f.ids.foreignUnit : f.ids.unit,
          reservation_id: scenario === 'wrong_resource' ? f.ids.foreignUnit : f.ids.reservation,
          kind: 'confirmation', created_at: scenario === 'before_adoption' ? '2026-10-04T23:59:59Z' : f.nowISO };
        return f.io.readOne(table, columns, filters, latest);
      },
      rpc: async (name, args) => { if (name === 'enqueue_whatsapp_automation') { enqueued.push(args); return f.jobId; } return f.io.rpc(name, args); },
    });
    const result = await dispatcher.dispatchScheduledIntent({ kind: 'confirmation', resourceId: f.ids.reservation, outboxId });
    if (scenario === 'valid_manual_notify') {
      expect(enqueued).toHaveLength(1); expect(f.calls.post).toBe(1);
      expect(enqueued[0]).toMatchObject({ p_intent: { source_event_key: `outbox:${outboxId}`, fact_at: '2026-10-05T20:30:00-03:00' } });
    } else { expect(result.state).toBe('not_enqueued'); expect(enqueued).toEqual([]); expect(f.calls.post).toBe(0); }
  });
  it('15s timeout is uncertain; late acceptance uses the original fence and never retries POST', async () => {
    vi.useFakeTimers();
    try {
      const f = createDispatchFixture();
      let resolveSend!: (value: { ok: boolean; providerMessageId: string }) => void;
      const pending = new Promise<{ ok: boolean; providerMessageId: string }>(resolve => { resolveSend = resolve; });
      const deferred: Promise<unknown>[] = [], fences: unknown[] = [];
      const dispatcher = createAutomationDispatcher({ ...f.io, defer: work => { deferred.push(work); },
        rpc: (name, args) => { if (name === 'finish_whatsapp_automation') fences.push(args.p_fence); return f.io.rpc(name, args); },
        prepareScheduledChannel: async () => {
          const result = await f.io.prepareScheduledChannel();
          if (!result.ok) return result;
          return { ok: true as const, channel: { ...result.channel, sendText: () => { f.calls.post++; return pending; } } };
        },
      });
      const dispatch = dispatcher.dispatchExistingJob(f.jobId);
      for (let i = 0; i < 150 && f.calls.post === 0; i++) await Promise.resolve();
      expect(f.calls.post).toBe(1);
      await vi.advanceTimersByTimeAsync(15_001);
      expect((await dispatch).state).toBe('uncertain'); expect(f.row.provider_message_id).toBeNull();
      resolveSend({ ok: true, providerMessageId: 'late-native' }); await Promise.all(deferred);
      expect(f.row.provider_message_id).toBe('late-native'); expect(f.row.state).toBe('reconciled');
      expect(new Set(fences).size).toBe(1); expect(f.calls.post).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('consent purpose authority through the real dispatcher', () => {
  type ConsentFixture = Pick<ReturnType<typeof createDispatchFixture>, 'ids' | 'consentEvents' | 'calls' | 'row' | 'jobId'>;
  function addEvent(f: ConsentFixture, purpose: 'operational' | 'promotional', decision: string, revision: number) {
    f.consentEvents.push({ unit_id: f.ids.unit, customer_id: f.ids.customer, purpose, decision, revision });
  }
  function expectAuthority(f: ConsentFixture, purpose: string, revision: number | null) {
    expect(f.calls.consentReads).toEqual([0, 1].map(() => ({ columns: 'decision,revision',
      predicates: { unit_id: f.ids.unit, customer_id: f.ids.customer, purpose }, latest: 'revision' })));
    expect(f.calls.prepares).toHaveLength(1);
    expect(f.calls.confirms).toEqual(f.calls.prepares);
    expect(f.calls.prepares[0]).toMatchObject({ p_job_id: f.jobId, p_fence: f.row.claim_token, p_consent_revision: revision });
  }
  // SQL success/refusal responses below are scripted I/O, not evidence of database guards.
  it.each([['text', null], ['text', 7], ['template', null], ['template', 7]] as const)('operational %s revision %s ignores promotional opt_out', async (transport, revision) => {
    const f = transport === 'text' ? createDispatchFixture() : await createTemplateDispatchFixture();
    addEvent(f, 'promotional', 'opt_out', 40);
    addEvent(f, 'promotional', 'opt_in', 2);
    if (revision !== null) {
      addEvent(f, 'operational', 'opt_in', revision);
      addEvent(f, 'operational', 'opt_out', 3);
    }
    expect(await f.dispatch()).toMatchObject({ state: 'reconciled' });
    expect(f.calls.post).toBe(1);
    expectAuthority(f, 'operational', revision);
    await f.dispatch();
    expect(f.calls.post).toBe(1);
  });
  it('unrelated promotional opt_in never supplies the absent operational revision', async () => {
    const f = createDispatchFixture(); addEvent(f, 'promotional', 'opt_in', 41);
    await f.dispatch(); expect(f.calls.post).toBe(1); expectAuthority(f, 'operational', null);
  });
  it('explicit current operational opt_out refuses despite promotional opt_in', async () => {
    const f = createDispatchFixture();
    addEvent(f, 'operational', 'opt_out', 8); addEvent(f, 'operational', 'opt_in', 1);
    addEvent(f, 'promotional', 'opt_in', 42);
    expect(await f.dispatch()).toMatchObject({ state: 'blocked' });
    expect(f.row.error_code).toBe('consent_changed'); expect(f.calls.post).toBe(0);
    expect(f.calls.prepares).toEqual([]); expect(f.calls.confirms).toEqual([]);
    expect(f.calls.consentReads[0].predicates.purpose).toBe('operational');
  });
  it('promotional latest opt_in/revision remains authority despite operational opt_out', async () => {
    const f = await createTemplateDispatchFixture(true);
    addEvent(f, 'promotional', 'opt_in', 9); addEvent(f, 'promotional', 'opt_out', 4);
    addEvent(f, 'operational', 'opt_out', 50); addEvent(f, 'operational', 'opt_in', 3);
    await f.dispatch(); expect(f.calls.post).toBe(1); expectAuthority(f, 'promotional', 9);
  });
  it.each(['absent', 'unknown', 'opt_out'])('promotional %s stays blocked despite operational opt_in', async decision => {
    const f = await createTemplateDispatchFixture(true); f.consentEvents.length = 0;
    addEvent(f, 'operational', 'opt_in', 51);
    if (decision !== 'absent') { addEvent(f, 'promotional', decision, 10); addEvent(f, 'promotional', 'opt_in', 2); }
    await f.dispatch(); expect(f.calls.post).toBe(0); expect(f.row.error_code).toBe('consent_changed');
    expect(f.calls.prepares).toEqual([]); expect(f.calls.confirms).toEqual([]); expect(f.hashes).toEqual([]);
  });
  it.each([
    ['operational', 'opt_out'], ['operational', 'opt_in'], ['promotional', 'opt_out'], ['promotional', 'opt_in'],
  ] as const)('final same-purpose %s %s revision change requests final_consent_changed with zero POST', async (purpose, decision) => {
    const f = purpose === 'operational' ? createDispatchFixture() : await createTemplateDispatchFixture(true);
    addEvent(f, purpose, 'opt_in', 11);
    addEvent(f, purpose === 'operational' ? 'promotional' : 'operational', 'opt_in', 60);
    f.controls.afterPrepare = () => addEvent(f, purpose, decision, 12);
    await f.dispatch();
    expect(f.calls.prepares[0]).toMatchObject({ p_consent_revision: 11 });
    expect(f.calls.confirms).toEqual([]); expect(f.calls.post).toBe(0);
    expect(f.calls.finishes).toEqual([{ outcome: 'local_preflight_refused', reason: 'final_consent_changed' }]);
    expect(f.calls.consentReads.map(read => read.predicates.purpose)).toEqual([purpose, purpose]);
    // Clock/claim are unchanged; the fixture's finish result does not prove SQL reset semantics.
    expect(f.calls.sqlNow).toBeLessThan(Date.parse(String(f.row.claimed_until)));
  });
  it.each(['operational', 'promotional'] as const)('changing unrelated purpose does not drift %s revision', async purpose => {
    const f = purpose === 'operational' ? createDispatchFixture() : await createTemplateDispatchFixture(true);
    const unrelated = purpose === 'operational' ? 'promotional' : 'operational';
    addEvent(f, purpose, 'opt_in', 13); addEvent(f, unrelated, 'opt_in', 70);
    f.controls.afterPrepare = () => addEvent(f, unrelated, 'opt_out', 71);
    await f.dispatch(); expect(f.calls.post).toBe(1); expectAuthority(f, purpose, 13);
    expect(f.calls.finishes).toEqual([{ outcome: 'accepted', reason: 'provider_accepted', provider_message_id: purpose === 'operational' ? 'native-test-1' : 'native-template-1' }]);
  });
  it.each(['text', 'template'] as const)('consent READ %s fixture applies exact scope, projection and latest order', async transport => {
    const f = transport === 'text' ? createDispatchFixture() : await createTemplateDispatchFixture(true);
    f.consentEvents.length = 0;
    addEvent(f, 'promotional', 'opt_out', 90); addEvent(f, 'operational', 'opt_in', 15); addEvent(f, 'operational', 'opt_out', 5);
    f.consentEvents.push({ ...f.consentEvents[1], unit_id: f.ids.foreignUnit, revision: 100 },
      { ...f.consentEvents[1], customer_id: f.ids.reservation, revision: 101 });
    const predicates = { unit_id: f.ids.unit, customer_id: f.ids.customer, purpose: 'operational' };
    const read = (filters = predicates, columns = 'decision,revision', latest: string | undefined = 'revision') =>
      f.io.readOne('whatsapp_message_consent_events', columns, filters, latest);
    expect(await read()).toEqual({ decision: 'opt_in', revision: 15 });
    expect(await read({ ...predicates, purpose: 'promotional' })).toEqual({ decision: 'opt_out', revision: 90 });
    expect(await read({ ...predicates, customer_id: f.ids.foreignUnit })).toBeNull();
    await expect(read(predicates, '*')).rejects.toThrow('unexpected_consent_query');
    await expect(read(predicates, 'decision,revision', 'created_at')).rejects.toThrow('unexpected_consent_query');
    await expect(f.io.readOne('whatsapp_message_consent_events', 'decision,revision', predicates)).rejects.toThrow('unexpected_consent_query');
    await expect(read({ ...predicates, purpose: 'all' })).rejects.toThrow('unexpected_consent_query');
    await expect(f.io.readOne('whatsapp_message_consent_events', 'decision,revision', { unit_id: f.ids.unit, customer_id: f.ids.customer }, 'revision')).rejects.toThrow('unexpected_consent_query');
    await expect(f.io.readOne('whatsapp_message_consent_events', 'decision,revision', { ...predicates, extra: 'unexpected' }, 'revision')).rejects.toThrow('unexpected_consent_query');
  });
});

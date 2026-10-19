// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createCutoverDedupFixture } from '../test/fixtures/whatsapp-cutover-dedup-fixture';

const opened: ReturnType<typeof createCutoverDedupFixture>[] = [];
function fixture() { const f = createCutoverDedupFixture(); opened.push(f); return f; }
afterEach(() => opened.splice(0).forEach(f => f.dispose()));
function noGuardReplies(f: ReturnType<typeof fixture>) {
  Object.keys(f.legacyRpcReplies).forEach(name => { f.legacyRpcReplies[name] = []; });
}
function payload(f: ReturnType<typeof fixture>, kind: string) {
  f.base.rows.waitlist.push({ id: f.base.ids.reservation, unit_id: f.base.ids.unit, customer_id: f.base.ids.customer });
  f.base.rows.vouchers.push({ ...f.producer.voucher });
  f.base.rows.voucher_rules.push({ id: f.producer.ruleId, unit_id: f.base.ids.unit, trigger_type: 'birthday' });
  return { kind, unit_id: f.base.ids.unit, phone: '11900000000', message: 'synthetic content', fact_at: f.base.nowISO,
    ...(kind === 'voucher_issued' ? { voucher_id: f.producer.voucher.id }
      : kind.startsWith('waitlist_') ? { waitlist_id: f.base.ids.reservation } : { reservation_id: f.base.ids.reservation }) };
}

describe('actual legacy forwarding handler derives the guarded fact', () => {
  it.each(['reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','waitlist_table_ready','voucher_issued'])('guards %s with the verified resource and static origin', async kind => {
    const f = fixture();
    const body = payload(f, kind);
    const response = await f.request(0, 'send-whatsapp', { ...body, origin: 'forged-origin',
      legacyAutomation: { kind: 'confirmation', resourceId: 'forged-resource', origin: 'forged-origin' }, fence: 'forged-fence' });
    expect(response.status).toBe(200); expect(f.posts).toHaveLength(1);
    expect(f.legacyCalls[0]).toEqual({ name: 'claim_whatsapp_legacy_automation_post', args: {
      p_kind: kind, p_resource_id: kind === 'voucher_issued' ? f.producer.voucher.id : f.base.ids.reservation,
      p_channel_id: f.producer.row.channel_id, p_expected_credential_revision: 1, p_origin: 'send-whatsapp' } });
    expect(f.events.findIndex(event => event.kind === 'rpc:finish_whatsapp_legacy_automation_post'))
      .toBeLessThan(f.events.findIndex(event => event.kind === 'notification:insert'));
    f.assertNoUnexpectedIo();
  });
  it.each(['confirmation','cancellation'])('refuses %s on the generic endpoint instead of bypassing the guard', async kind => {
    const f = fixture(); noGuardReplies(f);
    expect((await f.request(0, 'send-whatsapp', payload(f, kind))).status).toBe(400);
    expect(f.posts).toHaveLength(0); expect(f.notifications).toHaveLength(0); f.assertNoUnexpectedIo();
  });
  it.each(['missing','wrong_dimension','foreign_unit','after_rating'])('refuses false resource %s before guard/provider I/O', async mode => {
    const f = fixture(); noGuardReplies(f);
    const body: Record<string, unknown> = payload(f, 'voucher_issued');
    if (mode === 'missing') delete body.voucher_id;
    if (mode === 'wrong_dimension') body.reservation_id = f.base.ids.reservation;
    if (mode === 'foreign_unit') f.base.rows.vouchers[0].unit_id = f.base.ids.foreignUnit;
    if (mode === 'after_rating') f.base.rows.voucher_rules[0].trigger_type = 'after_rating';
    expect([400, 403]).toContain((await f.request(0, 'send-whatsapp', body)).status);
    expect(f.posts).toHaveLength(0); expect(f.notifications).toHaveLength(0); expect(f.legacyCalls).toHaveLength(0);
    f.assertNoUnexpectedIo();
  });
  it.each(['network','503','429','missing_id'])('does not repeat an ambiguous actual adapter POST: %s', async failure => {
    const f = fixture();
    f.controls.providerThrows = failure === 'network';
    f.controls.providerStatus = failure === '503' ? 503 : failure === '429' ? 429 : 200;
    f.controls.omitMessageId = failure === 'missing_id';
    f.legacyRpcReplies.finish_whatsapp_legacy_automation_post = [{ recorded: true, state: 'uncertain' }];
    const response = await f.request(0, 'send-whatsapp', payload(f, 'reminder_d1'));
    expect(response.status).toBe(502); expect(f.posts).toHaveLength(1); expect(f.notifications).toHaveLength(0);
    expect(f.legacyCalls.at(-1)).toMatchObject({ name: 'finish_whatsapp_legacy_automation_post',
      args: { p_outcome: 'uncertain', p_provider_message_id: null } });
    f.assertNoUnexpectedIo();
  });
  it('a channel dependency before claim leaves no ambiguous receipt and recovers to one POST', async () => {
    const f = fixture(); const body = payload(f, 'reminder_d1');
    f.producer.controls.queryError = 'whatsapp_channels';
    expect((await f.request(0, 'send-whatsapp', body)).status).toBe(502);
    expect(f.posts).toHaveLength(0); expect(f.notifications).toHaveLength(0); expect(f.legacyCalls).toHaveLength(0);
    f.producer.controls.queryError = '';
    expect((await f.request(1, 'send-whatsapp', body)).status).toBe(200);
    expect(f.posts).toHaveLength(1); expect(f.notifications).toHaveLength(1); f.assertNoUnexpectedIo();
  });
  it('a lost claim response fails closed without repeating RPC or writing a projection', async () => {
    const f = fixture(); noGuardReplies(f);
    f.legacyRpcReplies.claim_whatsapp_legacy_automation_post = [new Error('synthetic response lost')];
    expect((await f.request(0, 'send-whatsapp', payload(f, 'reminder_d1'))).status).toBe(502);
    expect(f.posts).toHaveLength(0); expect(f.notifications).toHaveLength(0); expect(f.legacyCalls).toHaveLength(1);
    f.assertNoUnexpectedIo();
  });
  it('projection transport failure after fenced acceptance does not synthesize a failed receipt or repeat POST', async () => {
    const f = fixture(); f.controls.notificationWriteThrows = true;
    f.legacyRpcReplies.claim_whatsapp_legacy_automation_post.push({ allowed: false, reason: 'history_accepted' });
    const body = payload(f, 'reminder_d1');
    expect((await f.request(0, 'send-whatsapp', body)).status).toBe(500);
    expect(f.legacyCalls.at(-1)).toMatchObject({ name: 'finish_whatsapp_legacy_automation_post', args: { p_outcome: 'accepted' } });
    f.controls.notificationWriteThrows = false;
    expect((await f.request(1, 'send-whatsapp', body)).status).toBe(502);
    expect(f.posts).toHaveLength(1); expect(f.notifications).toHaveLength(0);
    expect(f.events.filter(event => event.kind === 'notification:insert')).toHaveLength(1);
    f.assertNoUnexpectedIo();
  });
  it('keeps a genuinely unscoped/manual message on the original no-guard path', async () => {
    const f = fixture(); noGuardReplies(f);
    expect((await f.request(0, 'send-whatsapp', { unit_id: f.base.ids.unit, phone: '11900000000', message: 'synthetic manual' })).status).toBe(200);
    expect(f.posts).toHaveLength(1); expect(f.notifications).toHaveLength(0); expect(f.legacyCalls).toHaveLength(0);
    f.assertNoUnexpectedIo();
  });
});

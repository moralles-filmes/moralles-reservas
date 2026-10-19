// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createCutoverDedupFixture } from '../test/fixtures/whatsapp-cutover-dedup-fixture';

const opened: ReturnType<typeof createCutoverDedupFixture>[] = [];
function fixture() { const f = createCutoverDedupFixture(); opened.push(f); return f; }
afterEach(() => opened.splice(0).forEach(f => f.dispose()));
// The corrected API may refuse earlier. A closed refusal is valid; neither a
// particular successful predecessor path nor its final-confirm call is required.
function expectClosedResponse(response: Response) {
  expect([200, 202, 409, 503]).toContain(response.status);
}

// Task 1 RED controls now exercise the actual Task 3 JS guard against explicit
// SQL replies. Every scripted guard reply must be consumed by real handlers.
// PostgreSQL two-session/lock evidence remains a separate mandatory gate.
describe('cutover exclusivity through actual Edge handlers', () => {
  it('positive: a new eligible legacy fact makes one POST and records its provider ID', async () => {
    const f = fixture();
    const response = await f.request(0, 'send-confirmation');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ whatsapp: { sent: true } });
    expect(f.posts).toHaveLength(1);
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toMatchObject({ kind: 'confirmation', status: 'sent', provider_message_id: f.posts[0].id });
    expect(f.events.findIndex(event => event.kind === 'provider:accepted'))
      .toBeLessThan(f.events.findIndex(event => event.kind === 'notification:insert'));
    expect(f.events.findIndex(event => event.kind === 'rpc:finish_whatsapp_legacy_automation_post'))
      .toBeLessThan(f.events.findIndex(event => event.kind === 'notification:insert'));
    expect(f.sessions[0].manifest.has('send-confirmation:send-confirmation/index.ts')).toBe(true);
    f.assertNoUnexpectedIo();
  });

  it('positive: an already persisted legacy acceptance suppresses the actual outbox worker', async () => {
    const f = fixture();
    expect((await f.request(0, 'send-confirmation')).status).toBe(200);
    expect((await f.request(1, 'process-notification-outbox')).status).toBe(200);
    expect(f.posts).toHaveLength(1);
    expect(f.producer.outbox).toMatchObject({ status: 'done', last_error: 'expired:already_sent' });
    f.assertNoUnexpectedIo();
  });

  it('RED: two legacy Edge isolates must not POST the same confirmation while the first response is held', async () => {
    const f = fixture(); f.controls.holdFirstPost = true;
    f.legacyRpcReplies.claim_whatsapp_legacy_automation_post.push({ allowed: false, reason: 'intent_owned' });
    const first = f.request(0, 'send-confirmation');
    try {
      await f.waitForFirstPost();
      expect(f.notifications).toHaveLength(0);
      const second = await f.request(1, 'send-confirmation');
      expectClosedResponse(second);
    } finally { f.releaseFirstPost(); await first; }
    f.assertNoUnexpectedIo();
    expect(f.posts.length, 'same resource/kind crossed two actual provider POST boundaries').toBeLessThanOrEqual(1);
  });

  it('RED: a legacy reminder in flight must exclude a new eligible managed producer after adoption', async () => {
    const f = fixture(); f.controls.holdFirstPost = true;
    const first = f.request(0, 'process-reservation-reminders');
    try {
      await f.waitForFirstPost();
      expect(f.notifications).toHaveLength(0);
      const adoptedAt = '2026-10-05T15:00:01.000Z';
      expect(f.posts[0].endpoint).toBe('send-whatsapp');
      expect(f.sessions[0].manifest.has('process-reservation-reminders:process-reservation-reminders/index.ts')).toBe(true);
      await f.setClock(1, '2026-10-05T15:00:02.000Z');
      f.observeAdoptedState(adoptedAt);
      f.producer.rpcReplies.enqueue_whatsapp_automation = [{ data: null, error: null }];
      expect(Date.parse(f.posts[0].at)).toBeLessThan(Date.parse(adoptedAt));
      expect(Date.parse(adoptedAt)).toBeLessThan(f.sessions[1].now);
      const managed = await f.request(1, 'process-reservation-reminders');
      expectClosedResponse(managed);
    } finally { f.releaseFirstPost(); await first; }
    f.assertNoUnexpectedIo();
    if (f.posts.length > 1) expect(f.posts[1].endpoint).toBe('send-scheduled-whatsapp');
    expect(f.posts.length, 'legacy provider request and managed provider request share the same fact').toBeLessThanOrEqual(1);
  });

  it('positive: confirmation created before causal adoption is suppressed before managed enqueue', async () => {
    const f = fixture(); f.controls.holdFirstPost = true;
    const first = f.request(0, 'send-confirmation');
    try {
      await f.waitForFirstPost();
      const adoptedAt = '2026-10-05T15:00:01.000Z';
      await f.setClock(1, '2026-10-05T15:00:02.000Z');
      f.observeAdoptedState(adoptedAt);
      expect(Date.parse(String(f.producer.outbox.created_at))).toBeLessThan(Date.parse(adoptedAt));
      expect(Date.parse(f.posts[0].at)).toBeLessThan(Date.parse(adoptedAt));
      const response = await f.request(1, 'send-scheduled-whatsapp', { action: 'enqueue', kind: 'confirmation',
        resource_id: f.base.ids.reservation, unit_id: f.base.ids.unit, outbox_id: f.producer.outboxId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'not_enqueued', reason: 'producer_before_adoption' });
      expect(f.producer.trace.some(call => call.name === 'enqueue_whatsapp_automation')).toBe(false);
    } finally { f.releaseFirstPost(); await first; }
    expect(f.posts).toHaveLength(1);
    f.assertNoUnexpectedIo();
  });

  it('RED: legacy acceptance followed by notification write failure must survive outbox reentry', async () => {
    const f = fixture(); f.controls.notificationWriteFailures = 1;
    f.legacyRpcReplies.claim_whatsapp_legacy_automation_post.push({ allowed: false, reason: 'history_accepted' });
    const accepted = await f.request(0, 'send-confirmation');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ whatsapp: { sent: true } });
    expect(f.posts).toHaveLength(1);
    expect(f.notifications).toHaveLength(0);
    expect(f.events.filter(event => event.kind === 'notification:write_error')).toHaveLength(1);
    expectClosedResponse(await f.request(1, 'process-notification-outbox'));
    f.assertNoUnexpectedIo();
    expect(f.posts.length, 'provider already accepted; missing receipt does not prove zero POST').toBeLessThanOrEqual(1);
  });

  it('RED: failed historical receipt with a provider ID must not authorize another legacy POST', async () => {
    const f = fixture();
    f.legacyRpcReplies.claim_whatsapp_legacy_automation_post = [{ allowed: false, reason: 'history_uncertain' }];
    f.legacyRpcReplies.confirm_whatsapp_legacy_automation_post = [];
    f.legacyRpcReplies.finish_whatsapp_legacy_automation_post = [];
    f.notifications.push({ id: '55555555-0000-4000-8000-000000000001', unit_id: f.base.ids.unit,
      reservation_id: f.base.ids.reservation, kind: 'confirmation', status: 'failed',
      provider_message_id: 'synthetic-historical-accepted', whatsapp_provider: 'zapi',
      whatsapp_channel_id: f.producer.row.channel_id });
    const response = await f.request(0, 'send-confirmation', { resend_whatsapp_only: true });
    expectClosedResponse(response);
    expect(f.notifications[0]).toMatchObject({ status: 'failed', provider_message_id: 'synthetic-historical-accepted' });
    f.assertNoUnexpectedIo();
    expect(f.posts.length, 'delivery failure does not erase historical provider acceptance').toBe(0);
  });
});

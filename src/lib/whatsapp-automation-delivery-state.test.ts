import { describe, expect, it } from 'vitest';
import { DELIVERY_STATES, parseAutomationDeliveryState } from './whatsapp-automation-delivery-state';
const id = '10000000-0000-0000-0000-000000000001';
function fixture() {
  return { version: 1, generated_at: '2026-10-09T12:00:00Z',
    counts: { ...Object.fromEntries(DELIVERY_STATES.map(s => [s, s === 'blocked' ? 1 : 0])), total: 1, outstanding: 1 },
    oldest_nonterminal_at: '2026-01-01T12:00:00Z', has_more: false,
    rows: [{ job_id: id, kind: 'confirmation', state: 'blocked', pin_phase: 'preconfiguration', reason: 'channel_unconfigured',
      created_at: '2026-01-01T12:00:00Z', expires_at: '2026-01-02T12:00:00Z', finished_at: null,
      reconcile_required: false, has_pending_receipt: false, outstanding: true, reservation_id: id, waitlist_id: null, voucher_id: null }] };
}
describe('authorized technical delivery DTO', () => {
  it('keeps old preconfiguration outstanding without current configuration', () => {
    expect(parseAutomationDeliveryState(fixture(), 50).oldest_nonterminal_at).toBe('2026-01-01T12:00:00Z');
  });
  it.each(['extra', 'count', 'resource', 'duplicate', 'reason', 'oldest', 'timestamp', 'preconfiguration'])('rejects whole response: %s', fault => {
    const dto = fixture();
    if (fault === 'extra') Object.assign(dto.rows[0], { phone: 'not allowed' });
    if (fault === 'count') dto.counts.total = 2;
    if (fault === 'resource') dto.rows[0].reservation_id = null;
    if (fault === 'duplicate') dto.rows.push({ ...dto.rows[0] });
    if (fault === 'reason') dto.rows[0].reason = 'provider payload';
    if (fault === 'oldest') dto.oldest_nonterminal_at = null;
    if (fault === 'timestamp') dto.generated_at = 'infinity';
    if (fault === 'preconfiguration') dto.rows[0].reconcile_required = true;
    expect(() => parseAutomationDeliveryState(dto, 50)).toThrow('automation_delivery_state_invalid');
  });
  it('accepts cancellation on a reservation and table-ready on a waitlist entry', () => {
    const cancelled = fixture();
    Object.assign(cancelled.rows[0], { kind: 'cancellation', reason: 'reservation_not_cancelled' });
    expect(parseAutomationDeliveryState(cancelled, 50).rows[0]).toMatchObject({ kind: 'cancellation', reason: 'reservation_not_cancelled', reservation_id: id });
    const ready = fixture();
    Object.assign(ready.rows[0], { kind: 'waitlist_table_ready', reservation_id: null, waitlist_id: id });
    expect(parseAutomationDeliveryState(ready, 50).rows[0]).toMatchObject({ kind: 'waitlist_table_ready', waitlist_id: id });
    const wrong = fixture();
    Object.assign(wrong.rows[0], { kind: 'cancellation', reservation_id: null, waitlist_id: id });
    expect(() => parseAutomationDeliveryState(wrong, 50)).toThrow('automation_delivery_state_invalid');
  });
});

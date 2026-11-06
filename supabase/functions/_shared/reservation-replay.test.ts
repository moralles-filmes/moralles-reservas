// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { pickSameRequest, REPLAY_WINDOW_MINUTES, type ReplayRow } from './reservation-replay';
import { findRecentSameRequest } from './adapters/reservation-replay';

const NOW = Date.parse('2026-11-06T22:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const row = (over: Partial<ReplayRow> = {}): ReplayRow => ({
  id: 'r1', reservation_code: 'ABCD2345', status: 'confirmed', payment_status: 'not_required',
  table_id: 't1', time: '19:30:00', party_size: 4, created_at: minutesAgo(2), occupant_tables: [], ...over,
});
const params = { time: '19:30', partySize: 4 };

describe('pickSameRequest', () => {
  it('returns the recent active reservation with the same time and party size', () => {
    expect(pickSameRequest([row()], params, NOW)).toEqual({
      id: 'r1', reservationCode: 'ABCD2345', status: 'confirmed', paymentStatus: 'not_required',
      tableId: 't1', tableIds: ['t1'], time: '19:30',
    });
  });
  it('ignores a different time, party size, cancelled status or a reservation outside the window', () => {
    expect(pickSameRequest([row({ time: '20:00:00' })], params, NOW)).toBeNull();
    expect(pickSameRequest([row({ party_size: 5 })], params, NOW)).toBeNull();
    expect(pickSameRequest([row({ status: 'cancelled' })], params, NOW)).toBeNull();
    expect(pickSameRequest([row({ created_at: minutesAgo(REPLAY_WINDOW_MINUTES + 1) })], params, NOW)).toBeNull();
    expect(pickSameRequest([row({ created_at: minutesAgo(REPLAY_WINDOW_MINUTES) })], params, NOW)).not.toBeNull();
  });
  it('picks the newest match and merges combination tables without repeating the main table', () => {
    const picked = pickSameRequest([
      row({ id: 'old', created_at: minutesAgo(10) }),
      row({ id: 'new', created_at: minutesAgo(1), occupant_tables: [{ table_id: 't1' }, { table_id: 't2' }] }),
    ], params, NOW);
    expect(picked?.id).toBe('new');
    expect(picked?.tableIds).toEqual(['t1', 't2']);
  });
  it('with a ledger only considers the contact reservations', () => {
    expect(pickSameRequest([row()], { ...params, reservationIds: ['other'] }, NOW)).toBeNull();
    expect(pickSameRequest([row()], { ...params, reservationIds: ['r1'] }, NOW)?.id).toBe('r1');
  });
  it('a floating reservation returns no tables', () => {
    expect(pickSameRequest([row({ table_id: null })], params, NOW)?.tableIds).toEqual([]);
  });
});

function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const query: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'order']) {
    query[m] = (...args: unknown[]) => { calls.push([m, args]); return query; };
  }
  query.limit = (...args: unknown[]) => { calls.push(['limit', args]); return Promise.resolve(result); };
  const from = vi.fn(() => query);
  return { client: { from }, calls, from };
}

describe('findRecentSameRequest', () => {
  const base = { unitId: 'u1', customerId: 'c1', date: '2026-11-07', time: '19:30', partySize: 4 };

  it('always filters by unit and customer', async () => {
    const { client, calls } = fakeClient({ data: [row()], error: null });
    expect((await findRecentSameRequest(client, base, NOW))?.id).toBe('r1');
    expect(calls).toContainEqual(['eq', ['unit_id', 'u1']]);
    expect(calls).toContainEqual(['eq', ['customer_id', 'c1']]);
    expect(calls).toContainEqual(['eq', ['date', '2026-11-07']]);
    expect(calls).toContainEqual(['gte', ['created_at', minutesAgo(REPLAY_WINDOW_MINUTES)]]);
  });
  it('restricts to the ledger and skips the query when the ledger is empty', async () => {
    const withLedger = fakeClient({ data: [row()], error: null });
    await findRecentSameRequest(withLedger.client, { ...base, reservationIds: ['r1'] }, NOW);
    expect(withLedger.calls).toContainEqual(['in', ['id', ['r1']]]);
    const empty = fakeClient({ data: [row()], error: null });
    expect(await findRecentSameRequest(empty.client, { ...base, reservationIds: [] }, NOW)).toBeNull();
    expect(empty.from).not.toHaveBeenCalled();
  });
  it('a read error falls back to the normal flow (null), without throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient({ data: null, error: { code: '57014', message: 'secret detail' } });
    expect(await findRecentSameRequest(client, base, NOW)).toBeNull();
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret detail');
    spy.mockRestore();
  });
});

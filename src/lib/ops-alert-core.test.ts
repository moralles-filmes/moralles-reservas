import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideInboundAlerts } from '../../supabase/functions/_shared/ops-alert-core';
import { createOpsAlertSender } from '../../supabase/functions/_shared/ops-alert-sender';
import { createOpsAlerts } from '../../supabase/functions/_shared/ops-alert-runtime';
import { MAX_PENDING_BACKLOG_AGE_MS as frontendLimit } from './whatsapp-inbound-backlog';
import { MAX_PENDING_BACKLOG_AGE_MS as backendLimit } from '../../supabase/functions/_shared/whatsapp-inbound-queue-core';
const now = '2026-10-15T12:00:00Z';
const unit = { unitId: 'u', channelId: null, newDeadSince: 2, deadWatermark: '2026-10-15T11:59:00Z', oldestNonTerminalAt: null, lastSent: {} };
describe('operational alerts', () => {
  it('wires both entrypoints to the shared runtime, preserving template export', () => {
    const health = readFileSync('supabase/functions/process-whatsapp-channel-health/index.ts', 'utf8');
    const channels = readFileSync('supabase/functions/manage-channels/index.ts', 'utf8');
    expect(health).toContain('WHATSAPP_OPS_ALERT_URL');
    expect(health).toContain('.inbound()');
    expect(health).toContain('opsAlerts,');
    expect(channels).toContain('.subscriptionFailure(event)');
    expect(readFileSync('supabase/functions/_shared/whatsapp-template-worker.ts', 'utf8')).toContain('createOpsAlertSender as createTemplateAlertSender');
  });
  it('uses the same backlog limit for backend and panel', () => expect(frontendLimit).toBe(backendLimit));
  it('alerts new dead only, with a closed payload', () => {
    const [a] = decideInboundAlerts({ now, units: [unit], maxBacklogAgeMs: 60000 });
    expect(a.payload.count).toBe(2);
    expect(Object.keys(JSON.parse(JSON.stringify(a.payload))).sort()).toEqual(['event','unit_id','channel_id','count','generated_at'].sort());
    expect(a.newWatermark).toBe(unit.deadWatermark);
    expect(decideInboundAlerts({ now, units: [{ ...unit, newDeadSince: 0 }], maxBacklogAgeMs: 60000 })).toEqual([]);
  });
  it('alerts stalled backlog, suppresses within 30 minutes, fails closed on invalid clock', () => {
    const u = { ...unit, newDeadSince: 0, oldestNonTerminalAt: '2026-10-15T11:00:00Z' };
    expect(decideInboundAlerts({ now, units: [u], maxBacklogAgeMs: 60000 })[0].payload.oldest_age_seconds).toBe(3600);
    expect(decideInboundAlerts({ now, units: [{ ...u, lastSent: { inbound_backlog_stalled: '2026-10-15T11:45:00Z' } }], maxBacklogAgeMs: 60000 })).toEqual([]);
    expect(decideInboundAlerts({ now: 'bad', units: [u], maxBacklogAgeMs: 1 })).toEqual([]);
  });
  it('sender preserves transport behavior without exposing failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    expect(await createOpsAlertSender(undefined, fetcher)({})).toEqual({ delivered: false, reason: 'unconfigured' });
    expect(await createOpsAlertSender('http://invalid', fetcher)({})).toEqual({ delivered: false, reason: 'unconfigured' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await createOpsAlertSender('https://alerts.example/hook', fetcher)({ event: 'safe' })).toEqual({ delivered: true });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', body: '{"event":"safe"}' });
    fetcher.mockRejectedValue(new Error('credential in URL'));
    expect(await createOpsAlertSender('https://alerts.example', fetcher)({})).toEqual({ delivered: false, reason: 'delivery_failed' });
  });
});

describe('sender and ledger runtime', () => {
  function setup(delivered = true, ledgerFailed = false) {
    const select = vi.fn().mockResolvedValue({ data: ledgerFailed ? [] : [{ unit_id: 'u' }], error: null });
    const upsert = vi.fn().mockReturnValue({ select });
    const rpc = vi.fn().mockResolvedValue({ data: { now, units: [unit] }, error: null });
    const db = { rpc, from: vi.fn().mockReturnValue({ upsert }) };
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: delivered ? 200 : 503 }));
    const log = vi.fn();
    // This fake implements only the transport methods used by the adapter.
    const alerts = createOpsAlerts(db as unknown as Parameters<typeof createOpsAlerts>[0], 'https://alerts.example', log, fetcher);
    return { alerts, db, rpc, upsert, fetcher, log };
  }
  it('records the observed watermark only after successful HTTP', async () => {
    const s = setup();
    await s.alerts.inbound();
    expect(s.fetcher.mock.invocationCallOrder[0]).toBeLessThan(s.upsert.mock.invocationCallOrder[0]);
    expect(s.upsert.mock.calls[0][0]).toMatchObject({ unit_id: 'u', last_watermark: unit.deadWatermark, last_sent_at: now });
  });
  it('keeps ledger untouched on rejection and reports unconfigured', async () => {
    const s = setup(false);
    expect((await s.alerts.inbound()).results).toEqual([{ delivered: false, reason: 'delivery_failed' }]);
    expect(s.upsert).not.toHaveBeenCalled();
    const alerts = createOpsAlerts(s.db as unknown as Parameters<typeof createOpsAlerts>[0], undefined, s.log, s.fetcher);
    expect((await alerts.inbound()).results).toEqual([{ delivered: false, reason: 'unconfigured' }]);
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unconfigured' }));
  });
  it('reports local persistence failure separately from accepted delivery', async () => {
    const s = setup(true, true);
    expect((await s.alerts.inbound()).results).toEqual([{ delivered: true, reason: 'ledger_failed' }]);
  });
  it('preserves accepted delivery when ledger transport throws', async () => {
    const s = setup();
    s.upsert.mockImplementation(() => { throw new Error('private database URL'); });
    expect((await s.alerts.inbound()).results).toEqual([{ delivered: true, reason: 'ledger_failed' }]);
  });
  it('subscription callback filters operational reason and throttles per tenant/type', async () => {
    const s = setup();
    await s.alerts.subscriptionFailure({ unitId: 'u', channelId: 'c', reason: 'private' } as { unitId: string; channelId: string });
    expect(s.rpc).toHaveBeenCalledWith('observe_whatsapp_ops_alerts', { p_unit_id: 'u' });
    expect(JSON.parse(s.fetcher.mock.calls[0][1].body)).toEqual({ event: 'datafy_subscription_failed', unit_id: 'u', channel_id: 'c', generated_at: now });
    s.rpc.mockResolvedValue({ data: { now, units: [{ ...unit, lastSent: { datafy_subscription_failed: now } }] }, error: null });
    await s.alerts.subscriptionFailure({ unitId: 'u', channelId: 'c' });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    s.rpc.mockResolvedValue({ data: null, error: {} });
    await expect(s.alerts.subscriptionFailure({ unitId: 'u', channelId: 'c' })).resolves.toBeUndefined();
    expect(s.upsert).toHaveBeenCalledTimes(1);
  });
});

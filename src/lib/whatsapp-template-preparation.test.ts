import { describe, expect, it, vi } from 'vitest';
import { createTemplatePreparationService, selectVersionedPreparationClaims, type TemplatePreparationClaim, type TemplatePreparationDependencies } from '../../supabase/functions/_shared/whatsapp-template-preparation.ts';
import { refreshVerifiedDatafyTemplateHealth } from '../../supabase/functions/_shared/whatsapp-template-health.ts';

const claim: TemplatePreparationClaim = {
  onboarding_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000001',
  unit_id: '30000000-0000-4000-8000-000000000001',
  organization_id: '40000000-0000-4000-8000-000000000001', credential_revision: 2,
};
function fixture() {
  const channel = { id: claim.channel_id, unit_id: claim.unit_id, provider: 'datafy', status: 'connected', is_active: false,
    template_credential_revision: 2, last_health_check_at: '2026-10-17T18:59:00Z' };
  const binding = { id: '50000000-0000-4000-8000-000000000001', account_id: '60000000-0000-4000-8000-000000000001',
    generation: 1, channel_credential_revision: 2, verified_at: '2026-10-17T18:59:00Z' };
  const deps: TemplatePreparationDependencies = {
    now: vi.fn(() => Date.parse('2026-10-17T19:00:00Z')),
    read: vi.fn(async () => ({ enrollment: 'eligible' as const, onboarding_id: claim.onboarding_id, onboarding_state: 'completed', state: 'pending' as const })),
    loadChannel: vi.fn(async () => channel),
    refreshHealth: vi.fn(async () => undefined),
    ensureAccount: vi.fn(async () => undefined),
    loadBinding: vi.fn(async () => binding),
    authorize: vi.fn(async () => true),
    requestSync: vi.fn(async () => undefined),
    mark: vi.fn(async () => true),
  };
  return { deps, channel, binding, prepare: createTemplatePreparationService(deps).prepare };
}

describe('Datafy template preparation', () => {
  it('routes v2 recovery without accepting legacy preparation evidence or stale policy', async () => {
    const f = fixture();
    const v2 = { ...claim, version: 2 as const };
    expect(await f.prepare(v2)).toEqual({ state: 'skipped' });
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'stale', version: 2, state: 'pending', onboarding_id: claim.onboarding_id });
    expect(await f.prepare(v2)).toEqual({ state: 'skipped' });
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', version: 2, origin: 'auto', state: 'pending', onboarding_id: claim.onboarding_id, onboarding_state: 'completed' });
    expect(await f.prepare(v2)).toEqual({ state: 'ready' });
    expect(f.deps.read).toHaveBeenCalledWith(claim.unit_id, claim.channel_id, 2);
    expect(f.deps.authorize).toHaveBeenCalledWith(v2, f.binding);
  });
  it('gives both preparation versions a first-priority tick without claiming extra work', async () => {
    const order: number[] = [];
    const select = vi.fn(async (version: 1 | 2) => { order.push(version); return [{ ...claim, version }]; });
    for (const tick of [0, 1, 2, 3]) await selectVersionedPreparationClaims(select, tick * 300_000);
    expect(order).toEqual([2, 2, 1, 1]);
    expect(order.filter((_v, tick) => tick % 2 === 0)).toEqual([2, 1]);
    const fallback = vi.fn(async (version: 1 | 2) => version === 2 ? [] : [{ ...claim, version }]);
    expect(await selectVersionedPreparationClaims(fallback, 0)).toEqual([{ ...claim, version: 1 }]);
    expect(fallback.mock.calls).toEqual([[2], [1]]);
    const failed = vi.fn(async () => { throw new Error('dependency_unavailable'); });
    await expect(selectVersionedPreparationClaims(failed, 0)).rejects.toThrow('dependency_unavailable');
    expect(failed).toHaveBeenCalledOnce();
  });
  it('does not discover, grant or sync an old, disabled or excluded connection', async () => {
    for (const enrollment of ['legacy', 'disabled', 'excluded'] as const) {
      const f = fixture();
      vi.mocked(f.deps.read).mockResolvedValue({ enrollment, state: null });
      expect(await f.prepare(claim)).toEqual({ state: 'skipped' });
      expect(f.deps.mark).not.toHaveBeenCalled();
      expect(f.deps.ensureAccount).not.toHaveBeenCalled();
      expect(f.deps.authorize).not.toHaveBeenCalled();
    }
  });
  it('keeps a connected but unsubscribed onboarding pending without provider or grant I/O', async () => {
    const f = fixture();
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'connected', state: 'pending' });
    expect(await f.prepare(claim)).toEqual({ state: 'pending', reason: 'connection_pending' });
    expect(f.deps.mark).toHaveBeenCalledWith(claim, 'pending', 'connection_pending');
    expect(f.deps.ensureAccount).not.toHaveBeenCalled();
    expect(f.deps.authorize).not.toHaveBeenCalled();
  });
  it('renews stale health even for a connected inactive channel, then binds, grants and requests sync', async () => {
    const f = fixture();
    f.channel.last_health_check_at = '2026-10-17T18:00:00Z';
    vi.mocked(f.deps.refreshHealth).mockImplementation(async () => { f.channel.last_health_check_at = '2026-10-17T19:00:00Z'; });
    expect(await f.prepare(claim)).toEqual({ state: 'ready' });
    expect(f.deps.refreshHealth).toHaveBeenCalledOnce();
    expect(f.deps.ensureAccount).toHaveBeenCalledWith(claim.channel_id);
    expect(f.deps.authorize).toHaveBeenCalledWith(claim, f.binding);
    expect(f.deps.requestSync).toHaveBeenCalledWith(f.binding.account_id);
    expect(f.deps.mark).toHaveBeenLastCalledWith(claim, 'ready', null);
  });
  it('persists a safe pending reason after discovery fails without issuing a grant', async () => {
    const f = fixture();
    vi.mocked(f.deps.ensureAccount).mockRejectedValue(new Error('private provider payload'));
    expect(await f.prepare(claim)).toEqual({ state: 'pending', reason: 'provider_unavailable' });
    expect(f.deps.mark).toHaveBeenLastCalledWith(claim, 'pending', 'provider_unavailable');
    expect(f.deps.authorize).not.toHaveBeenCalled();
    expect(f.deps.requestSync).not.toHaveBeenCalled();
  });
  it('fails closed on a revoked policy or changed credential after enrollment', async () => {
    const f = fixture();
    vi.mocked(f.deps.authorize).mockResolvedValue(false);
    expect(await f.prepare(claim)).toEqual({ state: 'needs_review', reason: 'policy_changed' });
    expect(f.deps.requestSync).not.toHaveBeenCalled();
    const other = fixture();
    other.channel.template_credential_revision = 3;
    expect(await other.prepare(claim)).toEqual({ state: 'needs_review', reason: 'policy_changed' });
    expect(other.deps.ensureAccount).not.toHaveBeenCalled();
  });
  it('does not repeat an already ready preparation or continue after a lost state fence', async () => {
    const ready = fixture();
    vi.mocked(ready.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id, onboarding_state: 'completed', state: 'ready' });
    expect(await ready.prepare(claim)).toEqual({ state: 'ready' });
    expect(ready.deps.ensureAccount).not.toHaveBeenCalled();
    const lost = fixture();
    vi.mocked(lost.deps.mark).mockResolvedValue(false);
    expect(await lost.prepare(claim)).toEqual({ state: 'skipped' });
    expect(lost.deps.ensureAccount).not.toHaveBeenCalled();
  });
  it('never retries a previously ready connection whose SQL pins now require review', async () => {
    const f = fixture();
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'needs_review', reason_code: 'manual_review' });
    expect(await f.prepare(claim, true)).toEqual({ state: 'needs_review', reason: 'manual_review' });
    expect(f.deps.mark).not.toHaveBeenCalled();
    expect(f.deps.ensureAccount).not.toHaveBeenCalled();
    expect(f.deps.authorize).not.toHaveBeenCalled();
  });
  it('renews health for a ready inactive channel without binding, grant, sync or POST work', async () => {
    const f = fixture();
    f.channel.last_health_check_at = '2026-10-17T18:50:00Z';
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready' });
    vi.mocked(f.deps.refreshHealth).mockImplementation(async () => { f.channel.last_health_check_at = '2026-10-17T19:00:00Z'; });
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    expect(f.deps.refreshHealth).toHaveBeenCalledOnce();
    expect(f.deps.mark).toHaveBeenCalledWith(claim, 'ready', null);
    expect(f.deps.ensureAccount).not.toHaveBeenCalled();
    expect(f.deps.authorize).not.toHaveBeenCalled();
    expect(f.deps.requestSync).not.toHaveBeenCalled();
  });
  it('probes a ready inactive provider_error and retries later without regrant if the GET fails', async () => {
    const f = fixture();
    f.channel.status = 'provider_error';
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready' });
    vi.mocked(f.deps.refreshHealth).mockImplementation(async () => {
      f.channel.status = 'connected'; f.channel.last_health_check_at = '2026-10-17T19:00:00Z';
    });
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    expect(f.deps.authorize).not.toHaveBeenCalled();
    const failed = fixture();
    failed.channel.status = 'provider_error';
    vi.mocked(failed.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready' });
    vi.mocked(failed.deps.refreshHealth).mockRejectedValue(new Error('provider timeout'));
    expect(await failed.prepare(claim, true)).toEqual({ state: 'pending', reason: 'provider_unavailable' });
    expect(failed.deps.mark).toHaveBeenCalledWith(claim, 'ready', 'provider_unavailable');
    expect(failed.deps.ensureAccount).not.toHaveBeenCalled();
    expect(failed.deps.authorize).not.toHaveBeenCalled();
  });
  it('persists a safe ready heartbeat failure on /me identity mismatch, then recovers without any grant or sync', async () => {
    const f = fixture();
    f.channel.last_health_check_at = '2026-10-17T18:50:00Z';
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready' });
    const requestMe = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { phone_number_id: '222222' } })
      .mockResolvedValueOnce({ status: 200, body: { phone_number_id: '111111' } });
    vi.mocked(f.deps.refreshHealth).mockImplementation(async () => refreshVerifiedDatafyTemplateHealth({
      expectedPhoneNumberId: '111111', requestMe,
      recordConnected: async () => { f.channel.status = 'connected'; f.channel.last_health_check_at = '2026-10-17T19:00:00Z'; },
    }));
    expect(await f.prepare(claim, true)).toEqual({ state: 'pending', reason: 'provider_unavailable' });
    expect(f.channel.last_health_check_at).toBe('2026-10-17T18:50:00Z');
    expect(f.deps.mark).toHaveBeenLastCalledWith(claim, 'ready', 'provider_unavailable');
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready', reason_code: 'provider_unavailable' });
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    expect(f.deps.mark).toHaveBeenLastCalledWith(claim, 'ready', null);
    expect(f.deps.ensureAccount).not.toHaveBeenCalled();
    expect(f.deps.authorize).not.toHaveBeenCalled();
    expect(f.deps.requestSync).not.toHaveBeenCalled();
  });
  it('clears a durable ready health error when another read has already restored freshness', async () => {
    const f = fixture();
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'ready', reason_code: 'provider_unavailable' });
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    expect(f.deps.refreshHealth).not.toHaveBeenCalled();
    expect(f.deps.mark).toHaveBeenCalledWith(claim, 'ready', null);
    expect(f.deps.authorize).not.toHaveBeenCalled();
  });
  it('recovers pending inactive provider_error with health GET before discovery and grant', async () => {
    const f = fixture();
    f.channel.status = 'provider_error';
    vi.mocked(f.deps.refreshHealth).mockImplementation(async () => {
      f.channel.status = 'connected'; f.channel.last_health_check_at = '2026-10-17T19:00:00Z';
    });
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    expect(f.deps.refreshHealth).toHaveBeenCalledOnce();
    expect(f.deps.authorize).toHaveBeenCalledOnce();
  });
  it('respects callback retry backoff but lets a claimed worker or completed subscription proceed', async () => {
    const f = fixture();
    vi.mocked(f.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'discovering', reason_code: 'provider_unavailable', next_attempt_at: '2026-10-17T19:02:00Z' });
    expect(await f.prepare(claim)).toEqual({ state: 'skipped' });
    expect(f.deps.ensureAccount).not.toHaveBeenCalled();
    expect(await f.prepare(claim, true)).toEqual({ state: 'ready' });
    const subscription = fixture();
    vi.mocked(subscription.deps.read).mockResolvedValue({ enrollment: 'eligible', onboarding_id: claim.onboarding_id,
      onboarding_state: 'completed', state: 'pending', reason_code: 'connection_pending', next_attempt_at: '2026-10-17T19:02:00Z' });
    expect(await subscription.prepare(claim)).toEqual({ state: 'ready' });
  });
});

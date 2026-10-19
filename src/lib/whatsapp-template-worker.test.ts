import { describe, expect, it, vi } from 'vitest';
import { createTemplateWorker, createTemplateAlertSender, type TemplateWorkerJob } from '../../supabase/functions/_shared/whatsapp-template-worker.ts';

function fixture(count = 30) {
  const deps = {
    authenticate: vi.fn(() => true), now: vi.fn(() => 0),
    selectAccounts: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]),
    requestSync: vi.fn(async (): Promise<string | null> => null),
    listJobs: vi.fn(async () => Array.from({ length: count }, (_, i) => ({ id: String(i) }))),
    claim: vi.fn(async (id: string): Promise<TemplateWorkerJob | null> => ({ id, account_id: 'a', operation: 'sync', claim_token: 'f',
      target_key: 'account', state: 'claimed', binding_id: 'b', binding_generation: 1, posting_started_at: null })),
    sync: vi.fn(async () => ({ state: 'synced', processed: 7 })),
    provision: vi.fn(async () => ({ state: 'accepted', processed: 1 })),
    complete: vi.fn(async () => true), purge: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ failed: 0, uncertain: 0, oldest_age_seconds: 0 })),
    alert: vi.fn(async () => ({ delivered: true })),
  };
  return { deps, ...createTemplateWorker(deps) };
}
describe('internal catalog worker', () => {
  it('counts recovery and catalog work within the same total budget of twenty', async () => {
    const f = fixture(30);
    const claim = { onboarding_id: 'o', channel_id: 'c', unit_id: 'u', credential_revision: 1, version: 2 as const };
    const prepareChannel = vi.fn(async () => ({ state: 'ready' as const }));
    const run = createTemplateWorker({ ...f.deps, selectPreparations: async () => [claim], prepareChannel });
    const body = await (await run.handle(new Request('https://local.test', { method: 'POST' }))).json();
    expect(body).toMatchObject({ preparations: 1, claims: 19 });
    expect(f.deps.claim).toHaveBeenCalledTimes(19);
  });
  it('recovers one enrolled connection after existing account work and keeps failures visible', async () => {
    const f = fixture(0);
    f.deps.now.mockReturnValue(300_000); // account-priority cron slot
    const claim = { onboarding_id: 'o', channel_id: 'c', unit_id: 'u', organization_id: 'g', credential_revision: 1 };
    const selectPreparations = vi.fn(async () => Array.from({ length: 9 }, () => claim));
    const prepareChannel = vi.fn(async () => ({ state: 'pending' as const }));
    const run = createTemplateWorker({ ...f.deps, selectPreparations, prepareChannel });
    const response = await run.handle(new Request('https://local.test', { method: 'POST' }));
    expect(response.status).toBe(503);
    expect(prepareChannel).toHaveBeenCalledOnce();
    expect(selectPreparations.mock.invocationCallOrder[0]).toBeGreaterThan(f.deps.selectAccounts.mock.invocationCallOrder[0]);
    expect(await response.json()).toMatchObject({ preparations: 1, failures: 1 });
  });
  it('keeps queued jobs and health monitoring alive when the preparation selector fails', async () => {
    const f = fixture(1);
    const selectPreparations = vi.fn(async (): Promise<never[]> => { throw new Error('selector unavailable'); });
    const run = createTemplateWorker({ ...f.deps, selectPreparations, prepareChannel: vi.fn() });
    const response = await run.handle(new Request('https://local.test', { method: 'POST' }));
    expect(response.status).toBe(503);
    expect(f.deps.sync).toHaveBeenCalled();
    expect(f.deps.purge).toHaveBeenCalledOnce();
    expect(f.deps.health).toHaveBeenCalledOnce();
    expect(f.deps.alert).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ preparations: 0, failures: 1 });
  });
  it('does not begin a recovery GET when existing jobs have consumed the time budget', async () => {
    const f = fixture(1);
    f.deps.now.mockReturnValue(300_000); // account-priority cron slot
    f.deps.sync.mockImplementation(async () => { f.deps.now.mockReturnValue(345_000); return { state: 'synced', processed: 1 }; });
    const selectPreparations = vi.fn(async () => []);
    const run = createTemplateWorker({ ...f.deps, selectPreparations, prepareChannel: vi.fn() });
    expect((await run.handle(new Request('https://local.test', { method: 'POST' }))).status).toBe(200);
    expect(f.deps.complete).toHaveBeenCalled();
    expect(selectPreparations).not.toHaveBeenCalled();
  });
  it('alternates a fair recovery slot with account slots across a sustained backlog', async () => {
    const f = fixture(30);
    let clock = 0;
    f.deps.now.mockImplementation(() => clock);
    f.deps.sync.mockImplementation(async () => { clock += 20_000; return { state: 'synced', processed: 1 }; });
    const claim = { onboarding_id: 'o', channel_id: 'c', unit_id: 'u', credential_revision: 1 };
    const selectPreparations = vi.fn(async () => [claim]);
    const prepareChannel = vi.fn(async () => { clock += 40_000; return { state: 'ready' as const }; });
    const run = createTemplateWorker({ ...f.deps, selectPreparations, prepareChannel });
    const accountProgress: number[] = [];
    for (const start of [0, 300_000, 600_000]) {
      clock = start;
      const before = f.deps.sync.mock.calls.length;
      const response = await run.handle(new Request('https://local.test', { method: 'POST' }));
      expect(response.status).toBe(200);
      accountProgress.push(f.deps.sync.mock.calls.length - before);
    }
    expect(prepareChannel).toHaveBeenCalledTimes(2);
    expect(accountProgress).toEqual([1, 3, 1]);
    expect(f.deps.complete.mock.calls.length).toBe(f.deps.sync.mock.calls.length);
    expect(selectPreparations).toHaveBeenCalledTimes(2);
  });
  it('continues to provision when the current sync retires an abandoned sync already in the pending page', async () => {
    const f = fixture();
    f.deps.selectAccounts.mockResolvedValue([{ id: 'a' }]);
    f.deps.requestSync.mockResolvedValue('current');
    f.deps.listJobs.mockResolvedValue([{ id: 'old' }, { id: 'provision' }]);
    let currentCompleted = false;
    f.deps.complete.mockImplementation(async () => { currentCompleted = true; return true; });
    f.deps.claim.mockImplementation(async id => {
      if (id === 'old') { expect(currentCompleted).toBe(true); return null; }
      if (id === 'provision') expect(currentCompleted).toBe(true);
      return { id, account_id: 'a', operation: id === 'provision' ? 'provision' : 'sync', claim_token: 'f',
        target_key: 'account', state: 'claimed', binding_id: 'b', binding_generation: 1, posting_started_at: null };
    });
    const response = await f.handle(new Request('https://local.test', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(f.deps.claim.mock.calls.map(([id]) => id)).toEqual(['current', 'old', 'provision']);
    expect(f.deps.sync).toHaveBeenCalledOnce();
    expect(f.deps.provision).toHaveBeenCalledOnce();
    expect(f.deps.complete).toHaveBeenCalledWith(expect.objectContaining({ id: 'current' }), true, 'template_synced');
  });
  it('runs the current sync first even when older revisions fill the pending page', async () => {
    const f = fixture(); f.deps.requestSync.mockResolvedValue('current');
    await f.handle(new Request('https://local.test', { method: 'POST' }));
    expect(f.deps.claim.mock.calls[0]).toEqual(['current']);
    expect(f.deps.claim).toHaveBeenCalledTimes(20);
  });
  it('authenticates before selecting or purging', async () => {
    const f = fixture(); f.deps.authenticate.mockReturnValue(false);
    expect((await f.handle(new Request('https://local.test', { method: 'POST' }))).status).toBe(401);
    expect(f.deps.selectAccounts).not.toHaveBeenCalled(); expect(f.deps.purge).not.toHaveBeenCalled();
  });
  it('reports monitoring delivery separately from logs and refuses redirects or unsafe configuration', async () => {
    const payload = { type: 'whatsapp_template_pipeline' as const, failed: 1, uncertain: 0, oldest_age_seconds: 0 };
    const http = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await createTemplateAlertSender(undefined, http)(payload)).toEqual({ delivered: false, reason: 'unconfigured' });
    expect(await createTemplateAlertSender('http://monitor.test', http)(payload)).toEqual({ delivered: false, reason: 'unconfigured' });
    expect(http).not.toHaveBeenCalled();
    expect(await createTemplateAlertSender('https://monitor.test/hook', http)(payload)).toEqual({ delivered: true });
    expect(http).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
    http.mockRejectedValueOnce(new Error('secret URL must not escape'));
    expect(await createTemplateAlertSender('https://monitor.test/hook', http)(payload)).toEqual({ delivered: false, reason: 'delivery_failed' });
  });
  it('caps actual claims at20, even across accounts and templates', async () => {
    const f = fixture(); const response = await f.handle(new Request('https://local.test', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(f.deps.claim).toHaveBeenCalledTimes(20);
    expect(f.deps.sync).toHaveBeenCalledTimes(20);
    expect(f.deps.provision).not.toHaveBeenCalled();
  });
  it('only stops before another job and completes work already started', async () => {
    const f = fixture();
    f.deps.sync.mockImplementation(async () => { f.deps.now.mockReturnValue(100_000); return { state: 'synced', processed: 7 }; });
    await f.handle(new Request('https://local.test', { method: 'POST' }));
    expect(f.deps.claim).toHaveBeenCalledOnce(); expect(f.deps.complete).toHaveBeenCalledOnce();
  });
  it('records failed GET and signals backlog even with zero failed jobs', async () => {
    const f = fixture(1); f.deps.sync.mockResolvedValue({ state: 'failed', processed: 0 });
    f.deps.health.mockResolvedValue({ failed: 0, uncertain: 0, oldest_age_seconds: 7200 });
    expect((await f.handle(new Request('https://local.test', { method: 'POST' }))).status).toBe(503);
    expect(f.deps.complete).toHaveBeenCalledWith(expect.anything(), false, 'template_get_failed');
    expect(f.deps.alert).toHaveBeenCalledOnce();
  });
});

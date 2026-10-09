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

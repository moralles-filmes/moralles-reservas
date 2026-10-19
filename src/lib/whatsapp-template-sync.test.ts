import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatafyTemplateTransport } from '../../supabase/functions/_shared/datafy-client.ts';
import { TEMPLATE_CATALOG, catalogHash } from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';
import { submissionPayloadHash } from '../../supabase/functions/_shared/whatsapp-template-submission-hash.ts';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2.ts';
import { APPROVED_CATALOG_DIGESTS } from '../../supabase/functions/_shared/whatsapp-template-cohort.ts';
import { createTemplateSyncService, selectTemplateBindings, type TemplateBindingCandidate, type TemplateSyncDependencies, type TemplateSyncContext } from '../../supabase/functions/_shared/whatsapp-template-sync.ts';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
const definition = TEMPLATE_CATALOG.res_confirmacao_v1;
const remote = () => ({ id: '789', name: definition.name, language: 'pt_BR', status: 'APPROVED',
  category: 'UTILITY', parameter_format: 'POSITIONAL', components: definition.components });
async function fixture(pages: unknown[] = [{ data: [remote()] }]) {
  let calls = 0;
  const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify(pages[Math.min(calls++, pages.length - 1)])));
  const context: TemplateSyncContext = { accountId: 'a', wabaId: '456', bindingId: 'b', generation: 1,
    unitId: 'unit', channelId: 'channel', credentialRevision: 0,
    credentials: { access_token: 'fake' }, catalogEnabled: true, submissionAuthorized: true, provisionBindingId: 'b',
    selection: { state: 'v1', version: 1, digest: APPROVED_CATALOG_DIGESTS[1], grant_binding_id: 'b', generation: 1, credential_revision: 0 },
    templates: [{ id: 't', logical_id: definition.id, version: 1, name: definition.name, language: 'pt_BR',
      desired_hash: await catalogHash(definition), requested_category: 'UTILITY', remote_id: null,
      remote_status: 'UNKNOWN', quality: 'UNKNOWN', submission_attempted_at: null }], jobs: [] };
  const deps: TemplateSyncDependencies = {
    load: vi.fn(async () => context), seed: vi.fn(async () => undefined),
    getTransport: () => createDatafyTemplateTransport({ fetchImpl }),
    begin: vi.fn(async () => ({ account_generation: 1, capture_id: 'capture', binding_id: 'b', binding_generation: 1,
      credential_revision: 0, templates: [{ id: 't', epoch: 2 }] })),
    publish: vi.fn(async () => true), enqueueProvision: vi.fn(async () => undefined),
    finish: vi.fn(async () => true), prepare: vi.fn(async () => true), confirm: vi.fn(async () => true),
    prePostCheck: vi.fn(async () => true),
    finalCheck: vi.fn(async () => null),
  };
  return { ...createTemplateSyncService(deps), deps, context, fetchImpl };
}
describe('production sync with fake HTTP transport', () => {
  it('seeds and enqueues only the selected v2 while reconciling protected v1 history', async () => {
    const f = await fixture([{ data: [] }]);
    const v2 = TEMPLATE_V2_CATALOG.res_confirmacao_v2;
    f.context.selection = { state: 'ready', version: 2, digest: APPROVED_CATALOG_DIGESTS[2], grant_binding_id: 'b', generation: 1, credential_revision: 0 };
    f.context.templates.push({ ...f.context.templates[0], id: 't2', logical_id: v2.id, version: 2, name: v2.name,
      desired_hash: await catalogHash(v2) });
    await f.syncTemplateAccount('a');
    expect(f.deps.seed).toHaveBeenCalledWith('a', Object.values(TEMPLATE_V2_CATALOG));
    expect(f.deps.enqueueProvision).toHaveBeenCalledOnce();
    expect(f.deps.enqueueProvision).toHaveBeenCalledWith('b', v2);
    expect(f.deps.publish).toHaveBeenCalledWith('a', expect.anything(), expect.arrayContaining([
      expect.objectContaining({ id: 't' }), expect.objectContaining({ id: 't2' }),
    ]));
  });
  it.each(['pending', 'paused'] as const)('keeps GET reconciliation but blocks seeding, enqueue and POST when selection is %s', async state => {
    const f = await fixture([{ data: [] }]);
    f.context.selection = { state, version: null };
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced' });
    expect(f.deps.seed).not.toHaveBeenCalled();
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
    expect(await f.provisionTemplate('a', { id: 'j', target_key: definition.id, revision: 1,
      state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null })).toMatchObject({ state: 'paused' });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('uses the exact v2 payload with revision 2 and refuses stale v1 work in a v2 cohort', async () => {
    const f = await fixture([{ data: [] }]);
    const v2 = TEMPLATE_V2_CATALOG.res_confirmacao_v2;
    f.context.selection = { state: 'ready', version: 2, digest: APPROVED_CATALOG_DIGESTS[2], grant_binding_id: 'b', generation: 1, credential_revision: 0 };
    f.context.templates.push({ ...f.context.templates[0], id: 't2', logical_id: v2.id, version: 2, name: v2.name,
      desired_hash: await catalogHash(v2) });
    const job = { id: 'j', target_key: v2.id, revision: 2, state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null };
    f.fetchImpl.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { id: '789', status: 'PENDING' } : { data: [] })));
    expect(await f.provisionTemplate('a', job)).toMatchObject({ state: 'accepted', processed: 1 });
    expect(f.deps.prepare).toHaveBeenCalledWith(job, await submissionPayloadHash(v2));
    expect(JSON.parse(String(f.fetchImpl.mock.calls[1][1]?.body))).toMatchObject({ name: v2.name });
    expect(await f.provisionTemplate('a', { ...job, target_key: definition.id, revision: 1 })).toMatchObject({ state: 'paused', processed: 0 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not seed or perform HTTP if authoritative selection loading fails', async () => {
    const f = await fixture();
    vi.mocked(f.deps.load).mockRejectedValue(new Error('template_selection_unavailable'));
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'failed' });
    expect(f.deps.seed).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([['0001', '0002'], ['0002', '0001']])('selects authorized initial CREATE independently of GET UUID order (%s, %s)', async (a, b) => {
    const candidate = (id: string, authorized: boolean): TemplateBindingCandidate => ({
      id, unit_id: 'unit', channel_id: id, provider: 'datafy', generation: 1,
      channel_credential_revision: 2, verified_at: '2026-10-04', submission_authorized_at: authorized ? '2026-10-04' : null,
      channel: { id, unit_id: 'unit', provider: 'datafy', template_credential_revision: 2, status: 'connected', credentials: { access_token: 'fake' } },
    });
    const candidates = [candidate(b, true), candidate(a, false)];
    const selected = selectTemplateBindings(candidates);
    const f = await fixture([{ data: [] }]);
    f.context.bindingId = selected.chosen!.id;
    f.context.submissionAuthorized = !!selected.chosen!.submission_authorized_at;
    f.context.provisionBindingId = selected.provisionBindingId;
    vi.mocked(f.deps.begin).mockResolvedValue({ account_generation: 1, capture_id: 'capture', binding_id: selected.chosen!.id,
      binding_generation: 1, credential_revision: 0, templates: [{ id: 't', epoch: 2 }] });
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced' });
    expect(f.deps.publish).toHaveBeenCalledWith('a', expect.objectContaining({ binding_id: '0001' }), expect.anything());
    expect(f.deps.enqueueProvision).toHaveBeenCalledOnce();
    expect(f.deps.enqueueProvision).toHaveBeenCalledWith(b, definition);
    expect(candidates.find(c => c.id === a)!.submission_authorized_at).toBeNull();
    expect(selectTemplateBindings(candidates, a).chosen!.submission_authorized_at).toBeNull();
    for (const invalid of [
      { ...candidate(b, true), verified_at: null },
      { ...candidate(b, true), channel_credential_revision: 1 },
      { ...candidate(b, true), channel: { ...candidate(b, true).channel!, status: 'disconnected' } },
      { ...candidate(b, true), unit_id: 'other' },
      { ...candidate(b, true), provider: 'official' },
    ]) expect(selectTemplateBindings([candidate(a, false), invalid]).provisionBindingId).toBeNull();
  });
  it('enqueues initial missing content on the separately authorized binding, preserving the GET capture', async () => {
    const f = await fixture([{ data: [] }]);
    f.context.submissionAuthorized = false;
    f.context.provisionBindingId = 'authorized-other';
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced' });
    expect(f.deps.publish).toHaveBeenCalledWith('a', expect.objectContaining({ binding_id: 'b' }), expect.anything());
    expect(f.deps.enqueueProvision).toHaveBeenCalledOnce();
    expect(f.deps.enqueueProvision).toHaveBeenCalledWith('authorized-other', definition);
    expect(f.context.submissionAuthorized).toBe(false);
  });
  it('never borrows GET authorization when there is no current provisioning binding', async () => {
    const f = await fixture([{ data: [] }]);
    f.context.provisionBindingId = null;
    await f.syncTemplateAccount('a');
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
  });
  it('derives pending from accepted publication without an observed hash', async () => {
    const f = await fixture([{ data: [] }]);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ templateStates: { t: 'pending' } });
  });
  it('marks incompatible provider content as review work before any POST', async () => {
    const f = await fixture([{ data: [{ ...remote(), components: [{ type: 'BODY', text: 'External content' }] }] }]);
    vi.mocked(f.deps.prepare).mockResolvedValue(false);
    const result = await f.provisionTemplate('a', { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null });
    expect(result.state).toBe('conflict'); expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.deps.confirm).not.toHaveBeenCalled();
  });
  it('does not POST if asynchronous final checks outlive the SQL lease', async () => {
    const f = await fixture([{ data: [] }]);
    vi.mocked(f.deps.finalCheck).mockImplementation(async () => { vi.mocked(f.deps.confirm).mockResolvedValue(false); return null; });
    await f.provisionTemplate('a', { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.deps.confirm).toHaveBeenCalledOnce();
    expect(f.deps.finish).toHaveBeenCalledWith('j', 'f', { outcome: 'local_preflight_refused', reason: 'final_channel_changed' });
  });
  it('binds prepare, confirm and the final SQL check to the full body including examples', async () => {
    const f = await fixture([{ data: [] }]);
    const job = { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b',
      binding_generation: 1, posting_started_at: null };
    vi.mocked(f.deps.prePostCheck).mockResolvedValue(false);
    expect(await f.provisionTemplate('a', job)).toMatchObject({ state: 'paused', processed: 0 });
    const hash = await submissionPayloadHash(definition);
    expect(f.deps.prepare).toHaveBeenCalledWith(job, hash);
    expect(f.deps.confirm).toHaveBeenCalledWith(job, hash);
    expect(f.deps.prePostCheck).toHaveBeenCalledWith(job, hash);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); // GET only; the SQL refusal is before POST.
    expect(await submissionPayloadHash({ ...definition, examples: [['different']] })).not.toBe(hash);
  });
  it('refuses a modified stored hash or category before preparing a POST', async () => {
    const f = await fixture([{ data: [] }]);
    f.context.templates[0].desired_hash = '0'.repeat(64);
    const job = { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b',
      binding_generation: 1, posting_started_at: null };
    expect(await f.provisionTemplate('a', job)).toMatchObject({ state: 'conflict', processed: 0 });
    expect(f.deps.prepare).not.toHaveBeenCalled();
    f.context.templates[0].desired_hash = await catalogHash(definition);
    f.context.templates[0].requested_category = 'MARKETING';
    expect(await f.provisionTemplate('a', job)).toMatchObject({ state: 'conflict', processed: 0 });
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('uses the job binding for CREATE and the captured account binding for GET', async () => {
    const f = await fixture([{ data: [] }]);
    const postContext = { ...f.context, bindingId: 'other', generation: 3, credentials: { access_token: 'fake-other' } };
    vi.mocked(f.deps.load).mockImplementation(async (_a, binding) => binding ? postContext : f.context);
    f.fetchImpl.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { id: '789', status: 'PENDING' } : { data: [] })));
    await f.provisionTemplate('a', { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'other', binding_generation: 3, posting_started_at: null });
    expect(f.deps.finalCheck).toHaveBeenCalledWith(postContext);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer fake-other' });
  });
  it.each(['final_service_suspended', 'final_channel_changed', 'final_gate_paused'] as const)('records known zero POST after prepare: %s', async reason => {
    const f = await fixture([{ data: [] }]);
    vi.mocked(f.deps.finalCheck).mockResolvedValue(reason);
    await f.provisionTemplate('a', { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.deps.finish).toHaveBeenCalledWith('j', 'f', { outcome: 'local_preflight_refused', reason });
  });
  it('refuses a capture from a different binding before remote GET', async () => {
    const f = await fixture();
    vi.mocked(f.deps.begin).mockResolvedValueOnce({ account_generation: 1, capture_id: 'new', binding_id: 'other', binding_generation: 1, credential_revision: 0, templates: [] });
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'failed' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('reads both pages on the fixed origin and excludes examples from full structural hash', async () => {
    const f = await fixture([{ data: [], paging: { next: 'https://evil.test', cursors: { after: 'cursor+' } } },
      { data: [{ ...remote(), components: definition.components.map(c => ({ ...c, example: { body_text: [['different']] } })) }] }]);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced', processed: 1 });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl.mock.calls[1][0]).toContain('https://cloud.datafyapi.com.br/v1/456/message_templates?');
    expect(f.deps.publish).toHaveBeenCalledWith('a', expect.anything(), [expect.objectContaining({ observed_hash: f.context.templates[0].desired_hash })]);
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
  });
  it('refuses a cursor cycle without publishing old approval', async () => {
    const f = await fixture([{ data: [], paging: { next: 'ignored', cursors: { after: 'same' } } }]);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'failed' });
    expect(f.deps.publish).not.toHaveBeenCalled();
  });
  it('keeps unknown remote component fields in conflict hash', async () => {
    const f = await fixture([{ data: [{ ...remote(), components: [...definition.components, { type: 'BUTTONS', buttons: [] }] }] }]);
    await f.syncTemplateAccount('a');
    const snapshots = vi.mocked(f.deps.publish).mock.calls[0][2];
    expect(snapshots[0].observed_hash).not.toBe(f.context.templates[0].desired_hash);
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
  });
  it('event during GET makes publication stale and cannot schedule creation', async () => {
    const f = await fixture([{ data: [] }]);
    vi.mocked(f.deps.publish).mockResolvedValue(false);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'stale' });
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
  });
  it('failed GET never publishes prior usability', async () => {
    const f = await fixture();
    f.fetchImpl.mockRejectedValueOnce(new Error('private transport detail'));
    expect(await f.syncTemplateAccount('a')).toEqual({ state: 'failed', processed: 0, reason: 'template_get_failed' });
    expect(f.deps.publish).not.toHaveBeenCalled();
  });
  it('catalog OFF permits safety GET but no seed/create; v2 never provisions', async () => {
    const f = await fixture([{ data: [] }]);
    f.context.catalogEnabled = false;
    await f.syncTemplateAccount('a');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.deps.seed).not.toHaveBeenCalled();
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
    f.context.catalogEnabled = true;
    f.context.templates[0].version = 2;
    await f.syncTemplateAccount('a');
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
  });
  it.each(['REJECTED', 'DISABLED', 'DELETED'])('missing GET preserves %s without recreation', async remote_status => {
    const f = await fixture([{ data: [] }]);
    f.context.templates[0].remote_status = remote_status;
    await f.syncTemplateAccount('a');
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
    expect(f.deps.publish).toHaveBeenCalledWith('a', expect.anything(), [expect.objectContaining({ remote_status })]);
  });
  it('create timeout then exact GET repairs with only one POST', async () => {
    const f = await fixture([{ data: [] }]);
    const job = { id: 'j', target_key: definition.id, state: 'claimed', claim_token: 'f', binding_id: 'b', binding_generation: 1, posting_started_at: null };
    let posted = 0;
    f.fetchImpl.mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') { posted++; throw new Error('timeout'); }
      return new Response(JSON.stringify({ data: posted ? [remote()] : [] }));
    });
    await f.provisionTemplate('a', job);
    expect(f.deps.finish).toHaveBeenLastCalledWith('j', 'f', { outcome: 'uncertain', reason: 'post_ambiguous' });
    f.context.jobs = [{ ...job, state: 'uncertain', posting_started_at: '2026-10-03T12:00:00Z' }];
    await f.syncTemplateAccount('a');
    expect(f.deps.finish).toHaveBeenLastCalledWith('j', 'f', { outcome: 'accepted', reason: 'provider_accepted' });
    expect(posted).toBe(1);
  });
  it('missing GET never authorizes repost of uncertain or accepted evidence', async () => {
    const f = await fixture([{ data: [] }]);
    f.context.templates[0].submission_attempted_at = '2026-10-03T12:00:00Z';
    f.context.jobs = [{ id: 'j', target_key: definition.id, state: 'uncertain', claim_token: 'f',
      binding_id: 'b', binding_generation: 1, posting_started_at: '2026-10-03T12:00:00Z' }];
    await f.syncTemplateAccount('a');
    expect(f.deps.enqueueProvision).not.toHaveBeenCalled();
    expect(f.deps.finish).not.toHaveBeenCalled();
  });
});

import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVED_CATALOG_DIGESTS } from '../../supabase/functions/_shared/whatsapp-template-cohort.ts';
import { TEMPLATE_CATALOG, catalogHash } from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2.ts';

const transport = vi.hoisted(() => ({ listTemplates: vi.fn(), createTemplate: vi.fn() }));
vi.mock('../../supabase/functions/_shared/whatsapp-providers.ts', () => ({ getWhatsAppProvider: () => ({
  capabilities: { templateManagement: true }, ...transport,
}) }));
vi.mock('../../supabase/functions/_shared/platform-flags.ts', () => ({ readCurrentBooleanFlag: async () => ({ enabled: true, readFailed: false }) }));
vi.mock('../../supabase/functions/_shared/whatsapp-service-gate.ts', () => ({ clearWhatsAppGateCache: vi.fn(), resolveWhatsAppGateByUnit: async () => ({ enforced: { sending: false } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  transport.listTemplates.mockResolvedValue({ templates: [], nextCursor: null });
  transport.createTemplate.mockResolvedValue({ state: 'accepted', status: 200, remoteId: 'remote', remoteStatus: 'PENDING', category: 'UTILITY' });
});

async function fixture(version: 1 | 2, held = false) {
  // The Deno runtime is checked by `deno check`; a computed import executes it
  // here without pulling remote SDK values/Deno globals into the browser tsc project.
  const runtimePath = '../../supabase/functions/_shared/whatsapp-template-runtime.ts';
  const { createTemplateRuntime } = await import(runtimePath);
  const definition = version === 2 ? TEMPLATE_V2_CATALOG.res_confirmacao_v2 : TEMPLATE_CATALOG.res_confirmacao_v1;
  const templates: Record<string, unknown>[] = [{ id: 't', logical_id: definition.id, name: definition.name, version,
    language: 'pt_BR', desired_hash: await catalogHash(definition), requested_category: 'UTILITY', remote_id: null,
    remote_status: 'UNKNOWN', quality: 'UNKNOWN', submission_attempted_at: null }];
  const writes = vi.fn();
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: { code: string } | null }> => {
    let data: unknown = true;
    if (name === 'get_whatsapp_template_catalog_selection') data = held ? { state: 'pending', version: null }
      : { state: version === 2 ? 'ready' : 'v1', version, digest: APPROVED_CATALOG_DIGESTS[version],
        grant_binding_id: 'b', generation: 1, credential_revision: 0 };
    if (name === 'begin_whatsapp_template_sync') data = { account_generation: 1, capture_id: 'capture', binding_id: 'b',
      binding_generation: 1, credential_revision: 0, templates: templates.map(t => ({ id: t.id, epoch: 1 })) };
    return { data, error: null };
  });
  function from(table: string) {
    const value = () => table === 'whatsapp_template_accounts' ? { id: 'a', waba_id: 'waba', binding_generation: 1 }
      : table === 'whatsapp_channels' ? { id: 'c', unit_id: 'u', provider: 'datafy', status: 'connected', is_active: true,
        credentials: { access_token: 'fake', phone_number_id: 'phone' }, template_credential_revision: 0 }
      : table === 'whatsapp_template_bindings' ? [{ id: 'b', unit_id: 'u', channel_id: 'c', provider: 'datafy', generation: 1,
        channel_credential_revision: 0, verified_at: '2026-10-19', submission_authorized_at: '2026-10-19' }]
      : table === 'whatsapp_remote_templates' ? templates : [];
    const result = () => ({ data: value(), error: null });
    const query = {
      select: (_columns: string) => query, eq: (_key: string, _value: unknown) => query,
      not: (_key: string, _operator: string, _value: unknown) => query, order: (_key: string) => query,
      range: (_from: number, _to: number) => query,
      single: async () => result(), maybeSingle: async () => result(),
      upsert: async (rows: Record<string, unknown>[]) => { writes(rows); return { error: null }; },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  }
  const db = { from, rpc };
  return { ...createTemplateRuntime(db), rpc, writes, definition };
}

describe('actual runtime versioned SQL wiring', () => {
  it.each([1, 2] as const)('uses only the %i cohort and its matching SQL overload at every POST fence', async version => {
    const f = await fixture(version);
    const job = { id: 'j', revision: version, target_key: f.definition.id, state: 'claimed', claim_token: 'f',
      binding_id: 'b', binding_generation: 1, posting_started_at: null };
    expect(await f.provisionTemplate('a', job)).toEqual({ state: 'accepted', processed: 1 });
    expect(f.writes).toHaveBeenCalledOnce();
    expect(f.writes.mock.calls[0][0]).toHaveLength(9);
    expect(f.writes.mock.calls[0][0].every((row: Record<string, unknown>) => row.version === version)).toBe(true);
    for (const name of ['prepare_whatsapp_template_provision', 'confirm_whatsapp_template_post', 'check_whatsapp_template_submission']) {
      const call = f.rpc.mock.calls.find(([called]) => called === name)!;
      expect(call[1]).toMatchObject({ p_job_id: 'j', p_fence: 'f', p_generation: 1 });
      expect(Object.keys(call[1])).toHaveLength(version === 2 ? 5 : 4);
      if (version === 2) expect(call[1].p_version).toBe(2);
    }
    expect(transport.createTemplate).toHaveBeenCalledWith(expect.anything(), { wabaId: 'waba', definition: f.definition });
  });
  it('does not seed or enqueue from a legacy grant when SQL holds the future v2 cohort', async () => {
    const f = await fixture(1, true);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced' });
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([name]) => name === 'enqueue_whatsapp_template_job')).toBe(false);
    expect(transport.listTemplates).toHaveBeenCalledOnce();
    expect(transport.createTemplate).not.toHaveBeenCalled();
  });
  it('routes enqueue by true version without granting authority from the presence of a draft', async () => {
    const f = await fixture(2);
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'synced' });
    expect(f.rpc).toHaveBeenCalledWith('enqueue_whatsapp_template_job', {
      p_binding_id: 'b', p_operation: 'provision', p_target_key: 'res_confirmacao_v2', p_revision: 2, p_version: 2,
    });
    expect(transport.createTemplate).not.toHaveBeenCalled();
  });
  it('fails closed before seed or HTTP when the selection RPC fails', async () => {
    const f = await fixture(2);
    f.rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    expect(await f.syncTemplateAccount('a')).toMatchObject({ state: 'failed' });
    expect(f.writes).not.toHaveBeenCalled();
    expect(transport.listTemplates).not.toHaveBeenCalled();
    expect(transport.createTemplate).not.toHaveBeenCalled();
  });
  it('rechecks the v2 private grant after confirm and records zero POST when revoked', async () => {
    const f = await fixture(2);
    const real = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => name === 'check_whatsapp_template_submission'
      ? { data: false, error: null } : real(name, args));
    const job = { id: 'j', revision: 2, target_key: f.definition.id, state: 'claimed', claim_token: 'f',
      binding_id: 'b', binding_generation: 1, posting_started_at: null };
    expect(await f.provisionTemplate('a', job)).toEqual({ state: 'paused', processed: 0 });
    expect(f.rpc).toHaveBeenCalledWith('finish_whatsapp_template_job', { p_job_id: 'j', p_fence: 'f',
      p_result: { outcome: 'local_preflight_refused', reason: 'final_gate_paused' } });
    expect(transport.createTemplate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createTemplateManagementHandler, type TemplateManagementDependencies } from '../../supabase/functions/_shared/whatsapp-template-management.ts';

const id = '00000000-0000-4000-8000-000000000001';
const jwt = 'local-test-original-jwt';
const request = (body: unknown, token = jwt) => new Request('https://example.test/manage', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
function fixture() {
  const deps: TemplateManagementDependencies = {
    authenticate: vi.fn(async () => ({ id })),
    access: vi.fn(async () => ({ role: 'owner' as const, isPlatformAdmin: false, exists: true })),
    snapshot: vi.fn(async () => ({ channel: null, binding: null, unitAdopted: false, templates: [], jobs: [], generatedAt: '2026-10-09T10:00:00Z' })),
    onboardingSnapshot: vi.fn(async () => ({ channel: null, binding: null, preparation: null, unitAdopted: false,
      templates: [], jobs: [], generatedAt: '2026-10-09T10:00:00Z' })),
    callerRpc: vi.fn(async () => ({ data: id, error: null })),
  };
  return { deps, run: createTemplateManagementHandler(deps) };
}
describe('actual management Request factory', () => {
  it('reads onboarding catalog only by authenticated unit and refuses operator or caller channel', async () => {
    const { deps, run } = fixture();
    expect(await (await run(request({ action: 'onboarding_catalog_snapshot', unit_id: id }))).json())
      .toEqual({ channelId: null, templatePreparation: null, templates: [], generatedAt: '2026-10-09T10:00:00Z' });
    expect(deps.onboardingSnapshot).toHaveBeenCalledWith(id);
    expect(deps.callerRpc).not.toHaveBeenCalled();
    expect((await run(request({ action: 'onboarding_catalog_snapshot', unit_id: id, channel_id: id }))).status).toBe(400);
    vi.mocked(deps.access).mockResolvedValue({ role: 'operador', isPlatformAdmin: false, exists: true });
    expect((await run(request({ action: 'onboarding_catalog_snapshot', unit_id: id }))).status).toBe(403);
  });
  it('requires real platform admin and original JWT for a global auto policy change', async () => {
    const { deps, run } = fixture();
    const body = { action: 'set_auto_policy', enabled: true, expected_revision: 0 };
    expect((await run(request(body))).status).toBe(403);
    expect(deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(deps.access).mockResolvedValue({ role: null, isPlatformAdmin: true, exists: true });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { enabled: true, revision: 1, catalog_digest: 'a'.repeat(64), updated_at: '2026-10-17T19:00:00Z' }, error: null });
    expect(await (await run(request(body))).json()).toEqual({ enabled: true, revision: 1, catalogDigest: 'a'.repeat(64), updatedAt: '2026-10-17T19:00:00Z' });
    expect(deps.callerRpc).toHaveBeenCalledWith(jwt, 'configure_whatsapp_template_auto_policy', { p_enabled: true, p_expected_revision: 0 });
    expect((await run(request({ ...body, actor_id: id }))).status).toBe(400);
  });
  it('forwards the exact authenticated token and no caller actor to SQL', async () => {
    const { deps, run } = fixture();
    const response = await run(request({ action: 'sync', unit_id: id, channel_id: id, expected_binding_generation: 2 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'requested', requestId: id });
    expect(deps.authenticate).toHaveBeenCalledWith(jwt);
    expect(deps.callerRpc).toHaveBeenCalledWith(jwt, 'request_whatsapp_template_sync_for_channel', { p_channel_id: id, p_expected_binding_generation: 2 });
  });
  it('does not convert query failure or malformed RPC into absence', async () => {
    const { deps, run } = fixture();
    const body = { action: 'consent_snapshot', unit_id: id, customer_id: id, purpose: 'promotional' };
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: null, error: { code: 'XX000', message: 'private details' } });
    expect(await (await run(request(body))).json()).toEqual({ error: 'dependency_unavailable' });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { purpose: 'promotional', status: 'unknown', revision: null }, error: null });
    expect(await (await run(request(body))).json()).toEqual({ purpose: 'promotional', status: 'unknown', revision: null });
    vi.mocked(deps.access).mockRejectedValue(new Error('private role query'));
    expect((await run(request(body))).status).toBe(503);
  });
  it('uniformly rejects foreign/missing and operator mutations before RPC', async () => {
    const { deps, run } = fixture();
    const body = { action: 'consent_snapshot', unit_id: id, customer_id: id, purpose: 'promotional' };
    for (const access of [{ role: null, isPlatformAdmin: false, exists: false }, { role: 'operador' as const, isPlatformAdmin: false, exists: true }]) {
      vi.mocked(deps.access).mockResolvedValue(access);
      expect(await (await run(request(body))).json()).toEqual({ error: 'forbidden' });
    }
    expect(deps.callerRpc).not.toHaveBeenCalled();
  });
  it('snapshot reads no sync/provider and administrative stop maps false honestly', async () => {
    const { deps, run } = fixture();
    expect((await run(request({ action: 'snapshot', unit_id: id }))).status).toBe(200);
    expect(deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(deps.access).mockResolvedValue({ role: null, isPlatformAdmin: true, exists: true });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: false, error: null });
    expect(await (await run(request({ action: 'release_channel', channel_id: id, scope: 'dispatch', enabled: false, expected_credential_revision: 0, expected_binding_generation: null }))).json()).toEqual({ error: 'not_eligible' });
  });
  it('uses actual RPC errors for closed status without exposing dependency details', async () => {
    const { deps, run } = fixture();
    const body = { action: 'sync', unit_id: id, channel_id: id, expected_binding_generation: 1 };
    for (const [code, status, error] of [['42501', 403, 'forbidden'], ['22023', 400, 'invalid_request'], ['PT409', 409, 'configuration_changed'], ['PT503', 503, 'dependency_unavailable']] as const) {
      vi.mocked(deps.callerRpc).mockResolvedValue({ data: null, error: { code, message: 'private token and SQL detail' } });
      const response = await run(request(body));
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
    }
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: null, error: null });
    expect(await (await run(request(body))).json()).toEqual({ status: 'unavailable' });
    for (const data of ['', {}, false, undefined]) {
      vi.mocked(deps.callerRpc).mockResolvedValue({ data, error: null });
      expect((await run(request(body))).status).toBe(503);
    }
  });
  it('guards authentication, methods, body and role dependencies before all RPC I/O', async () => {
    const { deps, run } = fixture();
    expect((await run(new Request('https://example.test', { method: 'OPTIONS' }))).status).toBe(204);
    expect((await run(new Request('https://example.test'))).status).toBe(405);
    expect((await run(new Request('https://example.test', { method: 'POST' }))).status).toBe(401);
    for (const body of [{ action: 'bulk' }, { action: 'snapshot', unit_id: id, actor_id: id }, { action: 'snapshot', unit_id: 'invalid' }, 'a'.repeat(8193)]) expect((await run(request(body))).status).toBe(400);
    vi.mocked(deps.authenticate).mockResolvedValue(null);
    expect((await run(request({ action: 'snapshot', unit_id: id }))).status).toBe(401);
    vi.mocked(deps.authenticate).mockRejectedValue(new Error('auth unavailable'));
    expect((await run(request({ action: 'snapshot', unit_id: id }))).status).toBe(503);
    expect(deps.callerRpc).not.toHaveBeenCalled(); expect(deps.snapshot).not.toHaveBeenCalled();
  });
  it('rejects catalog revalidation for members while dispatching administrative actions with exact assertions', async () => {
    const { deps, run } = fixture();
    const asserted = { job_id: id, expected_channel_id: id, expected_binding_generation: 4 };
    const body = { action: 'revalidate_job', target: 'catalog', ...asserted };
    expect((await run(request(body))).status).toBe(403); expect(deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(deps.access).mockResolvedValue({ role: null, isPlatformAdmin: true, exists: true });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: true, error: null });
    for (const [input, name] of [[body, 'revalidate_whatsapp_template_job'], [{ action: 'initialize_job', ...asserted }, 'initialize_whatsapp_automation_job'], [{ action: 'revalidate_job', target: 'automation', ...asserted }, 'revalidate_whatsapp_automation_job']] as const) {
      expect(await (await run(request(input))).json()).toEqual({ status: 'updated' });
      expect(deps.callerRpc).toHaveBeenLastCalledWith(jwt, name, { p_job_id: id, p_expected_channel_id: id, p_expected_binding_generation: 4 });
    }
  });
  it('returns only its consent mutation event, and reads a later optout separately', async () => {
    const { deps, run } = fixture();
    const body = { action: 'record_consent', unit_id: id, customer_id: id, purpose: 'operational', decision: 'opt_in', source_code: 'signed_form', observed_at: '2026-10-09T10:00:00Z', evidence_reference: 'private individual reference' };
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: 4, error: null });
    const response = await run(request(body));
    expect(await response.json()).toEqual({ revision: 4, purpose: 'operational', decision: 'opt_in' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(deps.callerRpc).toHaveBeenLastCalledWith(jwt, 'record_whatsapp_message_consent', { p_unit_id: id, p_customer_id: id, p_purpose: 'operational', p_decision: 'opt_in', p_source_code: 'signed_form', p_observed_at: body.observed_at, p_evidence_reference: body.evidence_reference });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { purpose: 'operational', status: 'opt_out', revision: 5 }, error: null });
    expect(await (await run(request({ action: 'consent_snapshot', unit_id: id, customer_id: id, purpose: 'operational' }))).json()).toEqual({ purpose: 'operational', status: 'opt_out', revision: 5 });
  });
  it('treats snapshot read failure as unavailable rather than an empty or unadopted unit', async () => {
    const { deps, run } = fixture();
    vi.mocked(deps.snapshot).mockRejectedValue(new Error('adoption query failure'));
    const response = await run(request({ action: 'snapshot', unit_id: id }));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'dependency_unavailable' });
    expect(deps.callerRpc).not.toHaveBeenCalled();
  });
});

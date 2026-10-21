import { describe, expect, it, vi } from 'vitest';
import { createTemplateManagementHandler, type TemplateManagementDependencies } from '../../supabase/functions/_shared/whatsapp-template-management.ts';

const id = '00000000-0000-4000-8000-000000000001';
const jwt = 'original-user-jwt';
const req = (body: unknown) => new Request('https://example.test/manage-whatsapp-templates', {
  method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
});
const kinds = ['confirmation', 'reminder_d1', 'survey_d1', 'waitlist_entered', 'cancellation', 'waitlist_table_ready'] as const;
const absentSnapshot = {
  eligible: false, auto_cohort: false, rollout_ready: false, global_dispatch_enabled: false,
  admin_paused: false, can_manage: false, unit_id: id, channel_id: null,
  binding_id: null, binding_generation: null, credential_revision: null,
  provider_subscription_confirmed: false,
  kinds: kinds.map(kind => ({ kind, enabled: false, revision: 0, enabled_at: null,
    ready: false, reason_code: 'binding_changed', variants: [] })),
};
function setup() {
  const deps: TemplateManagementDependencies = {
    authenticate: vi.fn(async () => ({ id })),
    access: vi.fn(async () => ({ role: 'owner' as const, isPlatformAdmin: false, exists: true })),
    snapshot: vi.fn(async () => { throw Error('not used'); }),
    onboardingSnapshot: vi.fn(async () => { throw Error('not used'); }),
    callerRpc: vi.fn(async () => ({ data: absentSnapshot, error: null })),
  };
  return { deps, run: createTemplateManagementHandler(deps) };
}

describe('store v2 service preference boundary', () => {
  it('reads a privacy-safe unit snapshot for an operator through the original JWT', async () => {
    const { deps, run } = setup();
    vi.mocked(deps.access).mockResolvedValue({ role: 'operador', isPlatformAdmin: false, exists: true });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { ...absentSnapshot, internal_secret: 'never-return', kinds: absentSnapshot.kinds.map(k => ({ ...k, private_note: 'never-return' })) }, error: null });
    const response = await run(req({ action: 'service_preferences_snapshot', unit_id: id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(absentSnapshot);
    expect(deps.callerRpc).toHaveBeenCalledWith(jwt, 'get_whatsapp_v2_service_preferences', { p_unit_id: id });
    expect((await run(req({ action: 'service_preferences_snapshot', unit_id: id, channel_id: id }))).status).toBe(400);
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { ...absentSnapshot, channel_id: id, credential_revision: 0 }, error: null });
    expect(await (await run(req({ action: 'service_preferences_snapshot', unit_id: id }))).json())
      .toEqual({ ...absentSnapshot, channel_id: id, credential_revision: 0 });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { ...absentSnapshot, global_dispatch_enabled: true }, error: null });
    expect(await (await run(req({ action: 'service_preferences_snapshot', unit_id: id }))).json())
      .toEqual({ ...absentSnapshot, global_dispatch_enabled: true });
  });

  it('allows owner or gerente to enable one pinned service kind and denies operator or marketing', async () => {
    const { deps, run } = setup();
    const body = { action: 'set_service_preference', binding_id: id, kind: 'confirmation', enabled: true,
      expected_revision: 0, expected_generation: 1, expected_credential_revision: 0 };
    vi.mocked(deps.access).mockResolvedValue({ role: 'operador', isPlatformAdmin: false, exists: true });
    expect((await run(req(body))).status).toBe(403);
    expect(deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(deps.access).mockResolvedValue({ role: 'gerente', isPlatformAdmin: false, exists: true });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { kind: 'confirmation', enabled: true, revision: 1,
      enabled_at: '2026-10-21T18:00:00Z', private_note: 'never-return' }, error: null });
    expect(await (await run(req(body))).json()).toEqual({ kind: 'confirmation', enabled: true,
      revision: 1, enabled_at: '2026-10-21T18:00:00Z' });
    expect(deps.callerRpc).toHaveBeenCalledWith(jwt, 'set_whatsapp_v2_service_preference', {
      p_binding_id: id, p_kind: 'confirmation', p_enabled: true, p_expected_revision: 0,
      p_expected_generation: 1, p_expected_credential_revision: 0,
    });
    expect((await run(req({ ...body, kind: 'voucher_issued' }))).status).toBe(400);
    expect((await run(req({ ...body, actor_id: id }))).status).toBe(400);
  });

  it('fails closed on stale pins, readiness refusal, malformed SQL projection and foreign scope', async () => {
    const { deps, run } = setup();
    const body = { action: 'set_service_preference', binding_id: id, kind: 'reminder_d1', enabled: true,
      expected_revision: 0, expected_generation: 1, expected_credential_revision: 0 };
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: null, error: { code: 'PT409', message: 'private detail' } });
    expect(await (await run(req(body))).json()).toEqual({ error: 'configuration_changed' });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: null, error: { code: 'P0A01', message: 'private detail' } });
    expect(await (await run(req(body))).json()).toEqual({ error: 'not_eligible' });
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: { kind: 'reminder_d1', enabled: true, revision: 1, enabled_at: null }, error: null });
    expect((await run(req(body))).status).toBe(503);
    const { admin_paused: _omitted, ...missingPause } = absentSnapshot;
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: missingPause, error: null });
    expect((await run(req({ action: 'service_preferences_snapshot', unit_id: id }))).status).toBe(503);
    const { global_dispatch_enabled: _missingDispatch, ...missingDispatch } = absentSnapshot;
    vi.mocked(deps.callerRpc).mockResolvedValue({ data: missingDispatch, error: null });
    expect((await run(req({ action: 'service_preferences_snapshot', unit_id: id }))).status).toBe(503);
    vi.mocked(deps.access).mockResolvedValue({ role: null, isPlatformAdmin: false, exists: false });
    expect((await run(req(body))).status).toBe(403);
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { SCHEDULED_KINDS } from '../../supabase/functions/_shared/whatsapp-automation-core';
import { awaitingDispatchChannel, decodeAutomationDispatchStatus, decodeAutomationVersionSelection,
  decodeAutomationVersionSnapshot, resolveActiveDispatchBinding } from '../../supabase/functions/_shared/whatsapp-automation-version-access';
import { createTemplateManagementHandler, type TemplateManagementDependencies } from '../../supabase/functions/_shared/whatsapp-template-management';

const unit = '00000000-0000-4000-8000-000000000001';
const channel = '00000000-0000-4000-8000-000000000002';
const binding = '00000000-0000-4000-8000-000000000003';
const other = '00000000-0000-4000-8000-000000000004';
const jwt = 'synthetic-original-user-jwt';
const names = { confirmation: ['res_confirmacao_v2', 'res_confirmacao_desconto_v2'], reminder_d1: ['res_lembrete_dia_v2'],
  survey_d1: ['res_pesquisa_reserva_v2'], waitlist_entered: ['fila_entrada_v2'], waitlist_feedback: ['fila_feedback_v2'],
  voucher_issued: ['mkt_voucher_programado_v2'], cancellation: ['res_cancelada_v2'], waitlist_table_ready: ['fila_mesa_pronta_v2'] };
const snapshot = () => ({ binding_id: binding, channel_id: channel, generation: 2, credential_revision: 3,
  entries: SCHEDULED_KINDS.map(kind => ({ kind, selected_version: 1, selection_source: 'legacy', revision: 0,
    v2_ready: true, v2_reason_code: 'ready', variants: names[kind].map(logical_id => ({ logical_id, status: 'APPROVED', ready: true })) })) });
const body = { action: 'select_dispatch_version', binding_id: binding, kind: 'confirmation', version: 2,
  expected_revision: 0, expected_generation: 2, expected_credential_revision: 3 };
const request = (input: unknown) => new Request('https://fixture.invalid/manage', { method: 'POST',
  headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify(input) });
function fixture() {
  const deps: TemplateManagementDependencies = {
    authenticate: vi.fn(async () => ({ id: unit })),
    access: vi.fn(async () => ({ role: null, isPlatformAdmin: true, exists: true })),
    snapshot: vi.fn(), onboardingSnapshot: vi.fn(),
    resolveBinding: vi.fn(async () => binding), resolveActiveBinding: vi.fn(async () => binding),
    callerRpc: vi.fn(async () => ({ data: snapshot(), error: null })),
  };
  return { deps, run: createTemplateManagementHandler(deps) };
}

describe('versioned management uses the real authenticated Request factory', () => {
  it('resolves the getter binding after access and passes only the original JWT to SQL', async () => {
    const f = fixture();
    expect(await (await f.run(request({ action: 'dispatch_version_snapshot', channel_id: channel }))).json()).toEqual(snapshot());
    expect(f.deps.resolveBinding).toHaveBeenCalledTimes(1); expect(f.deps.resolveBinding).toHaveBeenCalledWith(channel);
    expect(f.deps.callerRpc).toHaveBeenCalledTimes(1); expect(f.deps.callerRpc).toHaveBeenCalledWith(jwt, 'get_whatsapp_automation_version_selections', { p_binding_id: binding });
    expect(f.deps.access).toHaveBeenCalledWith(unit, { action: 'dispatch_version_snapshot', channel_id: channel });
  });
  it.each(['owner', 'gerente', 'operador'] as const)('refuses %s administrative version actions before discovery or RPC', async role => {
    const f = fixture(); vi.mocked(f.deps.access).mockResolvedValue({ role, isPlatformAdmin: false, exists: true });
    expect((await f.run(request(body))).status).toBe(403);
    expect((await f.run(request({ action: 'dispatch_version_snapshot', channel_id: channel }))).status).toBe(403);
    expect(f.deps.resolveBinding).not.toHaveBeenCalled(); expect(f.deps.callerRpc).not.toHaveBeenCalled();
  });
  it('keeps all selection CAS pins and records explicit v1 as well as v2', async () => {
    const f = fixture();
    for (const version of [1, 2]) {
      vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: { state: 'selected', version, revision: 1 }, error: null });
      expect(await (await f.run(request({ ...body, version }))).json()).toEqual({ state: 'selected', version, revision: 1 });
      expect(f.deps.callerRpc).toHaveBeenLastCalledWith(jwt, 'set_whatsapp_automation_version_selection', {
        p_binding_id: binding, p_kind: 'confirmation', p_version: version, p_expected_revision: 0,
        p_expected_generation: 2, p_expected_credential_revision: 3,
      });
    }
    expect(f.deps.resolveBinding).not.toHaveBeenCalled();
  });
  it.each(['stale', 'not_ready', 'refused'])('returns SQL %s without inferring a missing override as v1', async state => {
    const f = fixture(); vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: { state, version: null, revision: 0 }, error: null });
    expect(await (await f.run(request(body))).json()).toEqual({ state, version: null, revision: 0 });
  });
  it.each([{ actor_id: unit }, { provider: 'datafy' }, { unit_id: unit }, { bulk: true }])('rejects extra authority keys %j', async extra => {
    const f = fixture(); expect((await f.run(request({ ...body, ...extra }))).status).toBe(400);
    expect(f.deps.access).not.toHaveBeenCalled(); expect(f.deps.callerRpc).not.toHaveBeenCalled();
  });
  it('separates six-argument v2 MARKETING authorization from unchanged five-argument v1', async () => {
    const f = fixture(); vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: other, error: null });
    const cost = { channel_id: channel, expected_binding_generation: 2, category: 'MARKETING',
      valid_from: '2026-10-19T10:00:00-03:00', valid_until: '2026-10-20T10:00:00-03:00' };
    expect((await f.run(request({ action: 'authorize_marketing_cost_v2', ...cost, version: 2 }))).status).toBe(200);
    expect(f.deps.callerRpc).toHaveBeenLastCalledWith(jwt, 'authorize_whatsapp_marketing_cost', {
      p_channel_id: channel, p_expected_binding_generation: 2, p_category: 'MARKETING',
      p_valid_from: cost.valid_from, p_valid_until: cost.valid_until, p_version: 2,
    });
    expect((await f.run(request({ action: 'authorize_marketing_cost', ...cost }))).status).toBe(200);
    expect(vi.mocked(f.deps.callerRpc).mock.calls.at(-1)?.[2]).not.toHaveProperty('p_version');
    expect((await f.run(request({ action: 'authorize_marketing_cost_v2', ...cost, version: 1 }))).status).toBe(400);
  });
  it('distinguishes a missing binding from read failure and sanitizes malformed dependency data', async () => {
    const f = fixture(); const input = { action: 'dispatch_version_snapshot', channel_id: channel };
    vi.mocked(f.deps.resolveBinding!).mockResolvedValue(null);
    expect(await (await f.run(request(input))).json()).toEqual({ error: 'not_eligible' });
    expect(f.deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(f.deps.resolveBinding!).mockRejectedValue(new Error('private SQL detail'));
    expect(await (await f.run(request(input))).json()).toEqual({ error: 'dependency_unavailable' });
    vi.mocked(f.deps.resolveBinding!).mockResolvedValue(binding);
    vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: { ...snapshot(), channel_id: other }, error: null });
    expect((await f.run(request(input))).status).toBe(503);
    vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: null, error: { code: '42501', message: 'private SQL detail' } });
    expect(await (await f.run(request(input))).json()).toEqual({ error: 'forbidden' });
  });
  it('derives store binding by authorized unit and uses a separate privacy-safe RPC', async () => {
    const f = fixture(); vi.mocked(f.deps.access).mockResolvedValue({ role: 'operador', isPlatformAdmin: false, exists: true });
    const status = { ...awaitingDispatchChannel(), channel_id: channel, generation: 2, credential_revision: 3 };
    vi.mocked(f.deps.callerRpc).mockResolvedValue({ data: status, error: null });
    expect(await (await f.run(request({ action: 'dispatch_status', unit_id: unit }))).json()).toEqual(status);
    expect(f.deps.resolveActiveBinding).toHaveBeenCalledTimes(1); expect(f.deps.resolveActiveBinding).toHaveBeenCalledWith(unit);
    expect(f.deps.callerRpc).toHaveBeenCalledTimes(1); expect(f.deps.callerRpc).toHaveBeenCalledWith(jwt, 'get_whatsapp_automation_dispatch_status', { p_binding_id: binding });
    expect(f.deps.resolveBinding).not.toHaveBeenCalled();
    vi.mocked(f.deps.access).mockResolvedValue({ role: null, isPlatformAdmin: false, exists: false });
    expect((await f.run(request({ action: 'dispatch_status', unit_id: other }))).status).toBe(403);
    expect(f.deps.resolveActiveBinding).toHaveBeenCalledTimes(1);
  });
  it('projects absence as awaiting channel without RPC and never treats discovery failure as absence', async () => {
    const f = fixture(); vi.mocked(f.deps.resolveActiveBinding!).mockResolvedValue(null);
    expect(await (await f.run(request({ action: 'dispatch_status', unit_id: unit }))).json()).toEqual(awaitingDispatchChannel());
    expect(f.deps.callerRpc).not.toHaveBeenCalled();
    vi.mocked(f.deps.resolveActiveBinding!).mockRejectedValue(new Error('private channel query'));
    expect((await f.run(request({ action: 'dispatch_status', unit_id: unit }))).status).toBe(503);
    expect(f.deps.callerRpc).not.toHaveBeenCalled();
  });
});

describe('strict DTO dependencies reject inconsistent version authority', () => {
  it.each(['duplicate', 'extra', 'wrong_variant', 'unapproved_ready', 'incoherent_reason', 'wrong_source', 'null_source'])('rejects %s snapshots', mutation => {
    const value = snapshot();
    if (mutation === 'duplicate') value.entries[1] = value.entries[0];
    if (mutation === 'extra') Object.assign(value.entries[0], { actor_id: unit });
    if (mutation === 'wrong_variant') value.entries[0].variants[0].logical_id = 'res_confirmacao_v1';
    if (mutation === 'unapproved_ready') value.entries[0].variants[0].status = 'PENDING';
    if (mutation === 'incoherent_reason') value.entries[0].v2_reason_code = 'meta_pending';
    if (mutation === 'wrong_source') value.entries[0].selected_version = 2;
    if (mutation === 'null_source') value.entries[0].selection_source = null;
    expect(() => decodeAutomationVersionSnapshot(value, binding, channel)).toThrow('dependency_unavailable');
  });
  it('keeps null unresolved selection explicit and closes malformed setter states', () => {
    const value = snapshot(); Object.assign(value.entries[0], { selected_version: null, selection_source: null, v2_ready: false, v2_reason_code: 'dependency_unavailable' });
    expect(decodeAutomationVersionSnapshot(value, binding, channel).entries[0].selected_version).toBeNull();
    for (const invalid of [{ state: ['stale'], version: null, revision: 0 }, { state: 'selected', version: 1, revision: 1 },
      { state: 'selected', version: 2, revision: 0 }, { state: 'stale', version: null, revision: 1 }]) {
      expect(() => decodeAutomationVersionSelection(invalid, 2, 0)).toThrow('dependency_unavailable');
    }
  });
  it('accepts canonical store identities and rejects leaked or mismatched fields', () => {
    const value = { ...awaitingDispatchChannel(), channel_id: channel, generation: 2, credential_revision: 3 };
    Object.assign(value.entries[0], { template_version: 2, logical_id: 'res_confirmacao_v2', readiness: 'awaiting_dispatch', reason_code: 'dispatch_paused' });
    expect(decodeAutomationDispatchStatus(value).entries[0].template_version).toBe(2);
    expect(() => decodeAutomationDispatchStatus({ ...value, actor_id: unit })).toThrow('dependency_unavailable');
    value.entries[0].logical_id = 'res_confirmacao_v1';
    expect(() => decodeAutomationDispatchStatus(value)).toThrow('dependency_unavailable');
    expect(() => decodeAutomationDispatchStatus({ ...awaitingDispatchChannel(), generation: 2 })).toThrow('dependency_unavailable');
    expect(() => decodeAutomationDispatchStatus({ ...value, channel_id: null, generation: null, credential_revision: null })).toThrow('dependency_unavailable');
  });
});

describe('server-side active channel discovery', () => {
  const record = (id = channel, active: boolean | null = true) => ({ id, unit_id: unit, is_active: active, status: 'connected', created_at: '2026-10-19T10:00:00Z' });
  const io = () => ({ channels: vi.fn(async () => [record()]), binding: vi.fn(async (id: string) => ({ id: binding, channel_id: id, unit_id: unit })) });
  it('resolves only the active unit-owned channel and binding', async () => {
    const f = io(); expect(await resolveActiveDispatchBinding(unit, f)).toBe(binding);
    expect(f.channels).toHaveBeenCalledWith(unit); expect(f.binding).toHaveBeenCalledWith(channel);
  });
  it('preserves deterministic legacy selection and returns genuine absence explicitly', async () => {
    const f = io(); f.channels.mockResolvedValue([record(other, null), record(channel, null)]);
    expect(await resolveActiveDispatchBinding(unit, f)).toBe(binding); expect(f.binding).toHaveBeenLastCalledWith(channel);
    f.channels.mockResolvedValue([record(channel, false)]);
    expect(await resolveActiveDispatchBinding(unit, f)).toBeNull(); expect(f.binding).toHaveBeenCalledTimes(1);
  });
  it.each(['duplicate_active', 'foreign_channel', 'foreign_binding', 'malformed_date', 'dependency_failure'])('closes %s without inventing v1', async mutation => {
    const f = io();
    if (mutation === 'duplicate_active') f.channels.mockResolvedValue([record(), record(other)]);
    if (mutation === 'foreign_channel') f.channels.mockResolvedValue([{ ...record(), unit_id: other }]);
    if (mutation === 'foreign_binding') f.binding.mockResolvedValue({ id: binding, channel_id: channel, unit_id: other });
    if (mutation === 'malformed_date') f.channels.mockResolvedValue([{ ...record(), created_at: 'invalid' }]);
    if (mutation === 'dependency_failure') f.channels.mockRejectedValue(new Error('private read'));
    await expect(resolveActiveDispatchBinding(unit, f)).rejects.toThrow();
  });
});

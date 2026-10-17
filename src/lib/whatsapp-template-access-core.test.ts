import { describe, expect, it } from 'vitest';
import { canManageTemplateAction, canManageTemplateRequest, decodeConsentState, decodeSyncResult,
  parseTemplateManagementRequest, projectTemplateSnapshot } from '../../supabase/functions/_shared/whatsapp-template-access-core.ts';

const id = '00000000-0000-4000-8000-000000000001';
describe('template management closed authority', () => {
  it('distinguishes member read, manager mutation and administrative authority', () => {
    expect(canManageTemplateAction('operador', 'snapshot', false)).toBe(true);
    for (const action of ['record_consent', 'consent_snapshot', 'release_channel', 'initialize_job', 'configure_promotion_frequency'] as const)
      expect(canManageTemplateAction('operador', action, false)).toBe(false);
    expect(canManageTemplateAction(null, 'release_channel', true)).toBe(true);
    expect(canManageTemplateRequest('owner', { action: 'revalidate_job', target: 'catalog', job_id: id, expected_channel_id: id, expected_binding_generation: 1 }, false)).toBe(false);
    expect(canManageTemplateRequest('gerente', { action: 'revalidate_job', target: 'automation', job_id: id, expected_channel_id: id, expected_binding_generation: 1 }, false)).toBe(true);
  });
  it('rejects extra authority, missing assertions, unknown origins and ambiguous scopes', () => {
    const release = { action: 'release_channel', channel_id: id, scope: 'dispatch', enabled: false, expected_credential_revision: 0, expected_binding_generation: 1 };
    expect(parseTemplateManagementRequest(release)).toEqual(release);
    for (const value of [{ ...release, actor_id: id }, { ...release, scope: undefined }, { ...release, scope: ['dispatch'] }, { ...release, enabled: 'false' }, { ...release, expected_binding_generation: -1 }])
      expect(parseTemplateManagementRequest(value)).toBeNull();
    expect(parseTemplateManagementRequest({ action: 'consent_snapshot', unit_id: id, customer_id: id, purpose: 'promotional' })).not.toBeNull();
    expect(parseTemplateManagementRequest({ action: 'consent_snapshot', unit_id: id, customer_id: id, purpose: 'all' })).toBeNull();
    const consent = { action: 'record_consent', unit_id: id, customer_id: id, purpose: 'operational', decision: 'opt_in', source_code: 'in_person', observed_at: '2026-10-09T10:00:00Z', evidence_reference: 'individual signed record' };
    expect(parseTemplateManagementRequest(consent)).toEqual(consent);
    for (const value of [{ ...consent, source_code: ['in_person'] }, { ...consent, observed_at: '2026-02-31T10:00:00Z' }, { ...consent, evidence_reference: '\nprivate transcript' }, { ...consent, source_code: 'preference_link' }]) expect(parseTemplateManagementRequest(value)).toBeNull();
  });
  it('distinguishes absent consent from failure and rejects personal/extra DTO fields', () => {
    expect(decodeConsentState({ purpose: 'operational', status: 'unknown', revision: null }, 'operational')).toEqual({ purpose: 'operational', status: 'unknown', revision: null });
    expect(decodeConsentState({ purpose: 'promotional', status: 'opt_out', revision: 2 }, 'promotional')).toEqual({ purpose: 'promotional', status: 'opt_out', revision: 2 });
    for (const value of [null, {}, { purpose: 'operational', status: 'unknown', revision: 1 }, { purpose: 'operational', status: 'opt_in', revision: 0 }, { purpose: 'operational', status: 'opt_in', revision: 1, reference: 'private' }])
      expect(() => decodeConsentState(value, 'operational')).toThrow('dependency_unavailable');
  });
  it('reports requested without claiming creation or execution', () => {
    expect(decodeSyncResult(id)).toEqual({ status: 'requested', requestId: id });
    expect(decodeSyncResult(null)).toEqual({ status: 'unavailable' });
    for (const value of [undefined, {}, '', 'secret']) expect(() => decodeSyncResult(value)).toThrow('dependency_unavailable');
  });
  it('projects only closed fields while preserving incomplete jobs and original facts', () => {
    const result = projectTemplateSnapshot({ channel: null, binding: null, unitAdopted: true, templates: [], jobs: [{ id, target: 'automation', kind: 'confirmation', state: 'blocked', pin_phase: 'preconfiguration', channel_id: null, initial_catalog_key: 'res_confirmacao_v1', error_code: 'channel_unconfigured', attempts: 0, fact_at: '2026-10-09T10:00:00Z', expires_at: '2026-10-09T11:00:00Z', safe_log_body: 'private', credentials: { token: 'private' } }], generatedAt: '2026-10-09T10:01:00Z' });
    expect(result.mode).toBe('unavailable');
    expect(result.configuration).toEqual({ bindingGeneration: null, credentialRevision: null, catalogAuthorized: false, dispatchEnabled: false, adopted: true });
    expect(result.blockedJobs).toHaveLength(1);
    expect(result.blockedJobs[0]).toMatchObject({ pinPhase: 'preconfiguration', channelId: null, factAt: '2026-10-09T10:00:00Z', deadline: '2026-10-09T11:00:00Z' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('projects cancellation and table-ready jobs with their catalog ids and the nine templates', () => {
    const job = (kind: string, key: string) => ({ id, target: 'automation', kind, state: 'blocked', pin_phase: 'preconfiguration', channel_id: null, initial_catalog_key: key, error_code: kind === 'cancellation' ? 'reservation_not_cancelled' : 'waitlist_not_waiting', attempts: 0, fact_at: '2026-10-09T10:00:00Z', expires_at: '2026-10-09T11:00:00Z' });
    const result = projectTemplateSnapshot({ channel: null, binding: null, unitAdopted: true, templates: [], jobs: [job('cancellation', 'res_cancelada_v1'), job('waitlist_table_ready', 'fila_mesa_pronta_v1')], generatedAt: '2026-10-09T10:01:00Z' });
    expect(result.blockedJobs.map(j => ['kind' in j ? j.kind : null, j.logicalId, j.reason])).toEqual([['cancellation', 'res_cancelada_v1', 'reservation_not_cancelled'], ['waitlist_table_ready', 'fila_mesa_pronta_v1', 'waitlist_not_waiting']]);
    expect(result.templates.map(t => t.logicalId)).toContain('res_cancelada_v1');
    expect(result.templates).toHaveLength(9);
    expect(() => projectTemplateSnapshot({ channel: null, binding: null, unitAdopted: true, templates: [], jobs: [job('waitlist_called', 'fila_mesa_pronta_v1')], generatedAt: '2026-10-09T10:01:00Z' })).toThrow('dependency_unavailable');
  });
  it('does not invent snapshot assertions from malformed dependencies', () => {
    const base = { channel: { id, provider: 'zapi', template_credential_revision: 0 }, binding: { generation: 1, submission_authorized_at: null, submission_authorized_by: null, dispatch_enabled: false }, unitAdopted: false, templates: [], jobs: [], generatedAt: '2026-10-09T10:01:00Z' };
    expect(projectTemplateSnapshot(base).configuration.credentialRevision).toBe(0);
    expect(projectTemplateSnapshot({ ...base, binding: null }).configuration.bindingGeneration).toBeNull();
    for (const generation of [null, undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => projectTemplateSnapshot({ ...base, binding: { ...base.binding, generation } })).toThrow('dependency_unavailable');
    expect(() => projectTemplateSnapshot({ ...base, binding: { ...base.binding, submission_authorized_at: '2026-10-09T10:01:00Z' } })).toThrow('dependency_unavailable');
    expect(() => projectTemplateSnapshot({ ...base, channel: { ...base.channel, template_credential_revision: null } })).toThrow('dependency_unavailable');
  });
});

import { describe, expect, it } from 'vitest';
import { canManageTemplateAction, canManageTemplateRequest, decodeConsentState, decodeSyncResult,
  parseTemplateManagementRequest, projectTemplateSnapshot, projectTemplatePreparation, projectOnboardingCatalogSnapshot } from '../../supabase/functions/_shared/whatsapp-template-access-core.ts';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2.ts';
import { APPROVED_CATALOG_DIGESTS } from '../../supabase/functions/_shared/whatsapp-template-cohort.ts';

const id = '00000000-0000-4000-8000-000000000001';
describe('template management closed authority', () => {
  it('projects exactly selected v2 plus v1 history with canonical paragraphs, emoji and independent approval', () => {
    const row = (logical_id: string, version: number, remote_status: string) => ({ logical_id, version, remote_status,
      local_status: remote_status === 'APPROVED' ? 'usable' : 'pending', effective_category: 'UTILITY', quality: 'UNKNOWN',
      desired_hash: 'same', observed_hash: 'same', sync_required: false, last_synced_at: '2026-10-19T14:00:00Z', body: 'remote private text', credentials: 'private' });
    const input = { channel: { id, provider: 'datafy', template_credential_revision: 0 },
      binding: { generation: 1, dispatch_enabled: false, submission_authorized_at: null, submission_authorized_by: null },
      catalogSelection: { state: 'ready', version: 2, digest: APPROVED_CATALOG_DIGESTS[2], generation: 1, credential_revision: 0, grant_binding_id: id },
      preparation: { version: 2, origin: 'manual', enrollment: 'eligible', state: 'ready', reason_code: null, updated_at: '2026-10-19T14:00:00Z', actor_id: id, credentials: 'private' },
      unitAdopted: false, templates: [row('res_confirmacao_v1', 1, 'APPROVED'), row('res_confirmacao_v2', 2, 'PENDING')], jobs: [], generatedAt: '2026-10-19T14:01:00Z' };
    const result = projectTemplateSnapshot(input, true);
    expect(result.templates).toHaveLength(10);
    expect(result.templates.filter(t => t.version === 2)).toHaveLength(9);
    expect(result.templates.find(t => t.logicalId === 'res_confirmacao_v1')).toMatchObject({ body: TEMPLATE_CATALOG.res_confirmacao_v1.body, remoteStatus: 'APPROVED' });
    expect(result.templates.find(t => t.logicalId === 'res_confirmacao_v2')).toMatchObject({ body: TEMPLATE_V2_CATALOG.res_confirmacao_v2.body, remoteStatus: 'PENDING', version: 2 });
    expect(result.catalogSelection).toEqual({ state: 'ready', version: 2, digest: APPROVED_CATALOG_DIGESTS[2] });
    expect(result.templatePreparation).toEqual({ version: 2, origin: 'manual', enrollment: 'eligible', state: 'ready', reason: null, updatedAt: '2026-10-19T14:00:00Z' });
    expect(result.configuration.dispatchEnabled).toBe(false);
    const serialized = JSON.stringify(result);
    for (const privateField of ['private', 'actor_id', 'grant_binding_id', 'credential_revision']) expect(serialized).not.toContain(privateField);
    expect(projectTemplateSnapshot(input).templates).toHaveLength(9);
    expect(projectTemplateSnapshot(input)).not.toHaveProperty('catalogSelection');
    expect(projectTemplateSnapshot({ ...input, templates: [...Object.keys(TEMPLATE_CATALOG).map(key => row(key, 1, 'APPROVED')), ...Object.keys(TEMPLATE_V2_CATALOG).map(key => row(key, 2, 'PENDING'))] }, true).templates).toHaveLength(18);
  });
  it('projects a connected onboarding with nine safe model states, and no channel as empty', () => {
    const base = { channel: { id, provider: 'datafy', template_credential_revision: 0 }, binding: null,
      preparation: { enrollment: 'eligible', state: 'pending', reason_code: null, updated_at: '2026-10-17T19:00:00Z', private: 'do not return' },
      unitAdopted: false, templates: [], jobs: [], generatedAt: '2026-10-17T19:00:01Z' };
    const projected = projectOnboardingCatalogSnapshot(base);
    expect(projected.channelId).toBe(id);
    expect(projected.templates).toHaveLength(9);
    expect(projected).not.toHaveProperty('bindingGeneration');
    expect(projected).not.toHaveProperty('credentialRevision');
    const versioned = projectOnboardingCatalogSnapshot(base, true);
    expect(versioned).toMatchObject({ channelId: id, bindingGeneration: null, credentialRevision: 0 });
    const bound = projectOnboardingCatalogSnapshot({ ...base,
      binding: { generation: 7, dispatch_enabled: false, submission_authorized_at: null, submission_authorized_by: null,
        private_actor: id, private_grant: 'internal' } }, true);
    expect(bound).toMatchObject({ channelId: id, bindingGeneration: 7, credentialRevision: 0 });
    expect(Object.keys(bound).sort()).toEqual(['bindingGeneration', 'catalogSelection', 'channelId', 'credentialRevision',
      'generatedAt', 'templatePreparation', 'templates'].sort());
    expect(JSON.stringify(bound)).not.toContain('private_');
    expect(projectOnboardingCatalogSnapshot({ ...base, channel: null }, true)).toMatchObject({
      channelId: null, bindingGeneration: null, credentialRevision: null });
    expect(JSON.stringify(projected)).not.toContain('do not return');
    expect(projectOnboardingCatalogSnapshot({ ...base, channel: null })).toEqual({ channelId: null,
      templatePreparation: { enrollment: 'eligible', state: 'pending', reason: null, updatedAt: '2026-10-17T19:00:00Z' },
      templates: [], generatedAt: '2026-10-17T19:00:01Z' });
  });
  it('projects only safe preparation state and never leaks internal enrollment metadata', () => {
    const raw = { enrollment: 'eligible', state: 'pending', reason_code: 'health_stale', updated_at: '2026-10-17T19:00:00Z',
      onboarding_id: id, organization_id: id, remote_payload: 'private' };
    expect(projectTemplatePreparation(raw)).toEqual({ enrollment: 'eligible', state: 'pending', reason: 'health_stale', updatedAt: '2026-10-17T19:00:00Z' });
    expect(JSON.stringify(projectTemplatePreparation(raw))).not.toContain('private');
    expect(() => projectTemplatePreparation({ ...raw, reason_code: 'private provider error' })).toThrow('dependency_unavailable');
  });
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

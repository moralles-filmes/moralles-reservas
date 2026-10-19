import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../supabase/functions/_shared/whatsapp-template-access-core';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { fetchAuthorizedTemplateSnapshot } from './useWhatsappTemplates';

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
beforeEach(() => { io.invoke.mockReset(); });

const unitId = '10000000-0000-4000-8000-000000000001';
const job = (kind: string) => ({ id: '50000000-0000-4000-8000-000000000001', target: 'automation', kind, state: 'blocked', pin_phase: 'preconfiguration',
  channel_id: null, initial_catalog_key: kind === 'cancellation' ? 'res_cancelada_v1' : 'fila_mesa_pronta_v1', error_code: kind === 'cancellation' ? 'reservation_not_cancelled' : 'waitlist_not_waiting',
  attempts: 0, fact_at: '2026-10-09T10:00:00Z', expires_at: '2026-10-09T11:00:00Z' });
const full = (jobs: Record<string, unknown>[] = []) => projectTemplateSnapshot({ channel: null, binding: null, unitAdopted: false, templates: [], jobs, generatedAt: '2026-10-09T12:00:00Z' });
const serve = (snapshot: unknown) => io.invoke.mockResolvedValue({ data: snapshot, error: null });
const OLD_SEVEN = ['res_confirmacao_v1', 'res_confirmacao_desconto_v1', 'res_lembrete_dia_v1', 'res_pesquisa_reserva_v1', 'fila_entrada_v1', 'fila_feedback_v1', 'mkt_voucher_programado_v1'];
const v2Templates = () => Object.values(TEMPLATE_V2_CATALOG).map(template => ({
  ...full().templates[0], logicalId: template.id, version: template.version, name: template.name,
  body: template.body, footer: template.footer, requestedCategory: template.requestedCategory,
}));
const bound = () => projectTemplateSnapshot({
  channel: { id: '30000000-0000-4000-8000-000000000001', provider: 'datafy', template_credential_revision: 0 },
  binding: { generation: 1, submission_authorized_at: null, submission_authorized_by: null, dispatch_enabled: false }, unitAdopted: false,
  templates: [], jobs: [], generatedAt: '2026-10-19T13:00:00Z',
});

describe('snapshot tolerates a catalog subset from an older Edge Function', () => {
  it('accepts the full nine-template catalog with the two new job kinds', async () => {
    serve(full([job('cancellation'), { ...job('waitlist_table_ready'), id: '50000000-0000-4000-8000-000000000002' }]));
    const snapshot = await fetchAuthorizedTemplateSnapshot(unitId);
    expect(snapshot.templates).toHaveLength(Object.keys(TEMPLATE_CATALOG).length);
    expect(snapshot.blockedJobs.map(j => j.target === 'automation' ? j.kind : null)).toEqual(['cancellation', 'waitlist_table_ready']);
  });
  it('accepts the seven-template catalog of the previous Edge Function', async () => {
    const snapshot = full();
    serve({ ...snapshot, templates: snapshot.templates.filter(t => OLD_SEVEN.includes(t.logicalId)) });
    expect((await fetchAuthorizedTemplateSnapshot(unitId)).templates.map(t => t.logicalId)).toEqual(OLD_SEVEN);
  });
  it('accepts all eighteen historical definitions and preserves each real version and fixed copy', async () => {
    serve({ ...full(), templates: [...full().templates, ...v2Templates()] });
    const snapshot = await fetchAuthorizedTemplateSnapshot(unitId);
    expect(snapshot.templates).toHaveLength(18);
    const reminder = snapshot.templates.find(template => template.logicalId === 'res_lembrete_dia_v2');
    expect(reminder).toMatchObject({ version: 2, body: TEMPLATE_V2_CATALOG.res_lembrete_dia_v2.body });
    expect(reminder.body).toContain('🕒\n\n');
  });
  it('accepts a mixed version subset during bundle rollout', async () => {
    serve({ ...full(), templates: [full().templates[0], v2Templates()[2]] });
    expect((await fetchAuthorizedTemplateSnapshot(unitId)).templates.map(template => template.version)).toEqual([1, 2]);
  });
  it('reads the v2 snapshot action and preserves only safe selection/preparation metadata', async () => {
    serve({ ...bound(), catalogSelection: { state: 'ready', version: 2, digest: 'b'.repeat(64) },
      templatePreparation: { enrollment: 'eligible', state: 'ready', reason: null, updatedAt: null, version: 2, origin: 'manual' } });
    const snapshot = await fetchAuthorizedTemplateSnapshot(unitId);
    expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'snapshot_v2', unit_id: unitId } });
    expect(snapshot.catalogSelection).toEqual({ state: 'ready', version: 2, digest: 'b'.repeat(64) });
    expect(snapshot.templatePreparation).toMatchObject({ version: 2, origin: 'manual' });
  });
  it('keeps historical template states and diagnostics when v2 preparation is stale', async () => {
    const templates = [
      { ...bound().templates[0], remoteStatus: 'APPROVED', localStatus: 'usable', hashMatches: true, syncRequired: false },
      { ...v2Templates()[0], remoteStatus: 'PENDING', localStatus: 'pending' },
    ];
    const templatePreparation = { enrollment: 'stale', state: 'needs_review', reason: 'policy_changed', updatedAt: '2026-10-19T13:00:00Z', version: 2, origin: 'auto' };
    serve({ ...bound(), templates, templatePreparation, catalogSelection: { state: 'paused', version: null, digest: null } });
    const snapshot = await fetchAuthorizedTemplateSnapshot(unitId);
    expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'snapshot_v2', unit_id: unitId } });
    expect(snapshot.templatePreparation).toEqual(templatePreparation);
    expect(snapshot.templates).toEqual(templates);
    expect(snapshot.catalogSelection).toEqual({ state: 'paused', version: null, digest: null });
    serve({ ...bound(), templates, templatePreparation: { ...templatePreparation, grant_binding_id: 'private' } });
    await expect(fetchAuthorizedTemplateSnapshot(unitId)).rejects.toThrow('dependency_unavailable');
  });
  it.each([
    { state: 'ready', version: 1, digest: 'b'.repeat(64) },
    { state: 'v1', version: 2, digest: 'b'.repeat(64) },
    { state: 'paused', version: 2, digest: 'b'.repeat(64) },
    { state: 'ready', version: 2, digest: 'bad' },
    { state: 'ready', version: 2, digest: 'b'.repeat(64), grant_binding_id: 'private' },
  ])('rejects inconsistent or internal catalogSelection metadata %j', async catalogSelection => {
    serve({ ...bound(), catalogSelection });
    await expect(fetchAuthorizedTemplateSnapshot(unitId)).rejects.toThrow('dependency_unavailable');
  });
  it.each(['wrong_version', 'wrong_body', 'wrong_category', 'unknown_version', 'oversized_history'])('refuses a %s historical catalog', async fault => {
    const templates: Record<string, unknown>[] = [...full().templates, ...v2Templates()];
    if (fault === 'wrong_version') templates[9] = { ...templates[9], version: 1 };
    if (fault === 'wrong_body') templates[9] = { ...templates[9], body: TEMPLATE_V2_CATALOG.res_confirmacao_v2.body.replace(/\n\n/g, '\n') };
    if (fault === 'wrong_category') templates[9] = { ...templates[9], requestedCategory: 'MARKETING' };
    if (fault === 'unknown_version') templates[9] = { ...templates[9], version: 3 };
    if (fault === 'oversized_history') templates.push(templates[9]);
    serve({ ...full(), templates });
    await expect(fetchAuthorizedTemplateSnapshot(unitId)).rejects.toThrow('dependency_unavailable');
  });
  it.each(['duplicate', 'unknown', 'oversized'])('refuses a %s template list', async fault => {
    const snapshot = full();
    const templates: Record<string, unknown>[] = [...snapshot.templates];
    if (fault === 'duplicate') templates[1] = templates[0];
    if (fault === 'unknown') templates[0] = { ...templates[0], logicalId: 'res_inexistente_v1' };
    if (fault === 'oversized') templates.push(templates[0]);
    serve({ ...snapshot, templates });
    await expect(fetchAuthorizedTemplateSnapshot(unitId)).rejects.toThrow('dependency_unavailable');
  });
});

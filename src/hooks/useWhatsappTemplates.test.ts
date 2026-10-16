import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../supabase/functions/_shared/whatsapp-template-access-core';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
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

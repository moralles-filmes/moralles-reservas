import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { useWhatsappTemplates } from '@/hooks/useWhatsappTemplates';
import { OfficialAutomationTemplate, TemplateStatus } from './OfficialAutomationTemplate';

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
beforeEach(() => { io.invoke.mockReset(); });

const template = projectTemplateSnapshot({
  channel: null, binding: null, unitAdopted: false,
  templates: [], jobs: [], generatedAt: '2026-10-09T12:00:00Z'
}).templates[6];

it('shows fixed body/footer, unknown quality and pending status without an editor', () => {
  const sync = vi.fn();
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, effectiveCategory: null, quality: 'UNKNOWN', localStatus: 'pending', remoteStatus: 'PENDING' }} onSync={sync} />);
  expect(screen.getByText('Em análise na Meta')).toBeInTheDocument();
  expect(screen.getByText('Qualidade desconhecida')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === template.body)).toBeInTheDocument();
  expect(screen.getByText(template.footer)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar sincronização' }));
  expect(sync).toHaveBeenCalledOnce();
});

it('does not infer a provider POST from local pending with unknown remote status', () => {
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, effectiveCategory: null,
    quality: 'UNKNOWN', localStatus: 'pending', remoteStatus: 'UNKNOWN' }} onSync={vi.fn()} canSync={false} />);
  expect(screen.getByText('Estado remoto ainda não confirmado')).toBeInTheDocument();
  expect(screen.queryByText('Em análise na Meta')).not.toBeInTheDocument();
});

it('does not equate approved remote status with current integrity or synchronization', () => {
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, effectiveCategory: null, quality: 'UNKNOWN', remoteStatus: 'APPROVED', localStatus: 'usable', hashMatches: false, syncRequired: true }} onSync={vi.fn()} canSync={false} />);
  expect(screen.getByText(/Conteúdo ainda não conferido/)).toBeInTheDocument();
  expect(screen.getByText(/Sincronização necessária/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('does not present a marketing model with RED quality as usable even if the snapshot is inconsistent', () => {
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, requestedCategory: 'MARKETING',
    effectiveCategory: 'MARKETING', quality: 'RED', remoteStatus: 'APPROVED', localStatus: 'usable',
    hashMatches: true, syncRequired: false }} onSync={vi.fn()} canSync={false} />);
  expect(screen.getByText('Aprovação ou integridade pendente')).toBeInTheDocument();
  expect(screen.queryByText('Modelo disponível')).not.toBeInTheDocument();
});

const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const logicalId = 'mkt_voucher_programado_v1' as const;
function job(target: 'automation' | 'catalog', state: string, index = 1) {
  const common = { id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`, target, state, channel_id: channelId, error_code: 'template_unavailable', attempts: 0 };
  return target === 'automation'
    ? { ...common, initial_catalog_key: logicalId, kind: 'voucher_issued', pin_phase: 'bound', fact_at: '2026-10-09T12:00:00Z', expires_at: '2099-10-09T12:00:00Z' }
    : { ...common, target_key: logicalId, created_at: '2026-10-09T12:00:00Z', due_at: '2026-10-09T12:00:00Z' };
}
function StatusHarness({ role }: { role: 'gerente' | 'operador' }) {
  return <TemplateStatus controls={useWhatsappTemplates(unitId, role)} logicalIds={[logicalId]} />;
}
function mountStatus(jobs: Record<string, unknown>[], role: 'gerente' | 'operador' = 'gerente') {
  const snapshot = projectTemplateSnapshot({
    channel: { id: channelId, provider: 'datafy', template_credential_revision: 0 },
    binding: { generation: 1, submission_authorized_at: null, submission_authorized_by: null, dispatch_enabled: false },
    unitAdopted: false, templates: [], jobs, generatedAt: '2026-10-09T12:00:00Z',
  });
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => ({
    data: body.action === 'snapshot' ? snapshot : { status: 'updated' }, error: null,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><StatusHarness role={role} /></QueryClientProvider>);
}

it.each([
  ['automation', 'queued'], ['automation', 'claimed'], ['automation', 'posting'], ['automation', 'retry_wait'],
  ['automation', 'accepted'], ['automation', 'reconciled'], ['automation', 'expired'],
  ['catalog', 'queued'], ['catalog', 'claimed'], ['catalog', 'posting'], ['catalog', 'accepted'], ['catalog', 'done'],
] as const)('%s %s does not show a message impediment or a correction action', async (target, state) => {
  mountStatus([job(target, state)]);
  await screen.findByText(/Canal: Datafy/);
  expect(screen.queryByText(/impedida de continuar/)).not.toBeInTheDocument();
  expect(screen.queryByText(/precisa de conferência/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Confira a análise e a sincronização/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verificar correção' })).not.toBeInTheDocument();
});

it.each(['gerente', 'operador'] as const)('keeps mixed diagnostics visible to %s and never offers correction for uncertain results', async role => {
  const diagnostics = [
    ...['blocked', 'needs_review', 'uncertain', 'paused', 'rejected', 'failed'].map(state => job('automation', state)),
    ...['needs_review', 'uncertain', 'paused', 'rejected', 'failed'].map(state => job('catalog', state)),
    job('automation', 'accepted'), job('catalog', 'done'),
  ].map((item, index) => ({ ...item, id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
  mountStatus(diagnostics, role);
  await screen.findByText(/Canal: Datafy/);
  expect(screen.getAllByText(/impedida de continuar/)).toHaveLength(5);
  expect(screen.getAllByText(/preparação deste modelo precisa de revisão/)).toHaveLength(4);
  const uncertain = screen.getAllByText(/precisa de conferência/);
  expect(uncertain).toHaveLength(2);
  for (const message of uncertain) {
    expect(within(message.parentElement!).queryByRole('button')).not.toBeInTheDocument();
  }
  expect(screen.queryAllByRole('button', { name: 'Verificar correção' })).toHaveLength(role === 'gerente' ? 2 : 0);
});

it('does not ask the store to synchronize models when the channel has a verified binding', async () => {
  mountStatus([]);
  await screen.findByText(/Canal: Datafy/);
  expect(screen.getByText(/catálogo deste canal ainda não foi liberado/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Solicitar sincronização' })).not.toBeInTheDocument();
});

it('lets a manager request correction for an eligible bound blocked automation with its current assertions', async () => {
  const blocked = job('automation', 'blocked');
  mountStatus([blocked]);
  fireEvent.click(await screen.findByRole('button', { name: 'Verificar correção' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: {
    action: 'revalidate_job', target: 'automation', job_id: blocked.id,
    expected_channel_id: channelId, expected_binding_generation: 1,
  } }));
});

it('does not show diagnostics from a different or missing logical model', async () => {
  mountStatus([
    { ...job('automation', 'blocked'), initial_catalog_key: 'res_lembrete_dia_v1' },
    { ...job('catalog', 'uncertain', 2), target_key: 'fila_entrada_v1' },
    { ...job('automation', 'failed', 3), initial_catalog_key: null },
  ]);
  await screen.findByText(/Canal: Datafy/);
  expect(screen.queryByText(/impedida de continuar/)).not.toBeInTheDocument();
  expect(screen.queryByText(/precisa de conferência/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verificar correção' })).not.toBeInTheDocument();
});

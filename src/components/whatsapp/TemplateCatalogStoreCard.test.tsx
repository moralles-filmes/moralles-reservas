// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';
import { TemplateCatalogStoreCard } from './TemplateCatalogStoreCard';
import { storeTemplateStatus } from '@/features/whatsapp/template-status';

const io = vi.hoisted(() => ({ invoke: vi.fn(), reason: null as string | null }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const snapshot = () => ({
  channelId,
  templates: projectTemplateSnapshot({
    channel: { id: channelId, provider: 'datafy', template_credential_revision: 0 },
    binding: { generation: 1, submission_authorized_at: '2026-10-17T18:00:00Z', submission_authorized_by: '20000000-0000-4000-8000-000000000001', dispatch_enabled: false },
    unitAdopted: false, templates: [
      { logical_id: 'fila_entrada_v1', version: 1, desired_hash: 'fixed', observed_hash: null, effective_category: null, remote_status: 'UNKNOWN', local_status: 'pending', quality: 'UNKNOWN', sync_required: true, last_synced_at: null },
      { logical_id: 'fila_feedback_v1', version: 1, desired_hash: 'fixed', observed_hash: null, effective_category: 'MARKETING', remote_status: 'PENDING', local_status: 'pending', quality: 'UNKNOWN', sync_required: true, last_synced_at: '2026-10-17T18:00:00Z' },
    ], jobs: [], generatedAt: '2026-10-17T18:00:00Z',
  }).templates,
  templatePreparation: { enrollment: 'eligible', state: 'ready', reason: io.reason, updatedAt: '2026-10-17T18:00:00Z' },
  generatedAt: '2026-10-17T18:00:00Z',
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TemplateCatalogStoreCard unitId={unitId} /></QueryClientProvider>);
}
beforeEach(() => { io.reason = null; io.invoke.mockReset(); io.invoke.mockImplementation(async () => ({ data: snapshot(), error: null })); });

it('shows all nine read-only statuses without claiming UNKNOWN was submitted or ready means approved', async () => {
  mount();
  const list = await screen.findByRole('list', { name: 'Estado dos nove modelos oficiais' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(9);
  expect(screen.getByText(/não comprova as nove submissões nem aprovação pela Meta/)).toBeInTheDocument();
  const unknown = within(list).getByText('fila_entrada_v1').closest('li');
  expect(unknown).toHaveTextContent('Estado remoto ainda não confirmado');
  const pending = within(list).getByText('fila_feedback_v1').closest('li');
  expect(pending).toHaveTextContent('Em análise na Meta');
  expect(screen.queryByRole('button', { name: /sincronização|ativar/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'onboarding_catalog_snapshot')).toHaveLength(2));
});

it('does not label a mismatched remote approval as usable', () => {
  const base = snapshot().templates[0] as OfficialTemplateView;
  expect(storeTemplateStatus({ ...base, version: 1, localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: false, syncRequired: true })).toBe('Aprovação ou integridade pendente');
  expect(storeTemplateStatus({ ...base, version: 1, localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: true, syncRequired: false, effectiveCategory: base.requestedCategory })).toBe('Aprovado e disponível');
  expect(storeTemplateStatus({ ...base, localStatus: 'pending', remoteStatus: 'IN_APPEAL' })).toBe('Recurso em análise na Meta');
});

it('shows a ready binding health failure, then clears the alert after recovery', async () => {
  io.reason = 'provider_unavailable';
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar a Datafy agora');
  expect(screen.getByRole('alert')).toHaveTextContent('vínculo dos modelos continua registrado');
  expect(screen.queryByText(/Aprovado e disponível/)).not.toBeInTheDocument();
  io.reason = null;
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.getByText(/vínculo da conta de modelos está preparado/)).toBeInTheDocument();
});

it('labels a remote appeal explicitly without implying approval or another submission', async () => {
  const current = snapshot();
  current.templates = current.templates.map(template => template.logicalId === 'fila_entrada_v1'
    ? { ...template, remoteStatus: 'IN_APPEAL', localStatus: 'pending' } : template);
  io.invoke.mockResolvedValue({ data: current, error: null });
  mount();
  const list = await screen.findByRole('list', { name: 'Estado dos nove modelos oficiais' });
  const appeal = within(list).getByText('fila_entrada_v1').closest('li');
  expect(appeal).toHaveTextContent('Recurso em análise na Meta');
  expect(appeal).not.toHaveTextContent('Aprovado e disponível');
  expect(screen.queryByRole('button', { name: /sincronização|submeter/i })).not.toBeInTheDocument();
});

it('fails visibly when the snapshot is unavailable', async () => {
  io.invoke.mockResolvedValue({ data: null, error: new Error('unavailable') });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar o serviço');
  expect(screen.queryByRole('list', { name: 'Estado dos nove modelos oficiais' })).not.toBeInTheDocument();
});

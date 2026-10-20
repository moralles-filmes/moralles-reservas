// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectOnboardingCatalogSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { TEMPLATE_V2_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { TEMPLATE_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-core';
import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';
import { syntheticDispatchStatus } from '@/test/fixtures/whatsapp-dispatch-status';
import { storeDispatchStatusSchema } from '@/features/whatsapp/template-dispatch-versions';
import { TemplateCatalogStoreCard } from './TemplateCatalogStoreCard';
import { storeTemplateStatus } from '@/features/whatsapp/template-status';

const io = vi.hoisted(() => ({ invoke: vi.fn(), reason: null as string | null }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const rows = [...Object.values(TEMPLATE_CATALOG), ...Object.values(TEMPLATE_V2_CATALOG)].map(definition => ({
  logical_id: definition.id, version: definition.version, desired_hash: 'fixed', observed_hash: null,
  effective_category: null, remote_status: 'UNKNOWN', local_status: 'awaiting_connection',
  quality: 'UNKNOWN', sync_required: true, last_synced_at: null,
}));
const snapshot = () => ({
  ...projectOnboardingCatalogSnapshot({
    channel: { id: channelId, provider: 'datafy', template_credential_revision: 0 },
    binding: { generation: 1, submission_authorized_at: '2026-10-17T18:00:00Z', submission_authorized_by: '20000000-0000-4000-8000-000000000001', dispatch_enabled: false },
    unitAdopted: false, templates: rows.map(row => row.logical_id === 'fila_entrada_v1'
      ? { ...row, local_status: 'pending' }
      : row.logical_id === 'fila_feedback_v1'
        ? { ...row, effective_category: 'MARKETING', remote_status: 'PENDING', local_status: 'pending', last_synced_at: '2026-10-17T18:00:00Z' }
        : row), jobs: [], generatedAt: '2026-10-17T18:00:00Z',
  }, true),
  templatePreparation: { enrollment: 'eligible', state: 'ready', reason: io.reason, updatedAt: '2026-10-17T18:00:00Z' },
  generatedAt: '2026-10-17T18:00:00Z',
});
function reply(current: unknown = snapshot(), dispatch: unknown = syntheticDispatchStatus()) {
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => {
    if (body.action === 'onboarding_catalog_snapshot_v2') return { data: current, error: null };
    if (body.action === 'dispatch_status') return { data: dispatch, error: null };
    throw new Error('unexpected fixture request');
  });
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TemplateCatalogStoreCard unitId={unitId} /></QueryClientProvider>);
}
beforeEach(() => { io.reason = null; io.invoke.mockReset(); reply(); });

it('shows selected read-only texts and business states without technical names or version controls', async () => {
  mount();
  const list = await screen.findByRole('list', { name: 'Textos oficiais dos avisos' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(9);
  expect(within(list).getByText('Entrada na fila').closest('li')).toHaveTextContent('Estado remoto ainda não confirmado');
  expect(within(list).getByText('Pesquisa da fila').closest('li')).toHaveTextContent('Em análise na Meta');
  expect(screen.getByRole('list', { name: 'Estado de envio por finalidade' }).children).toHaveLength(8);
  expect(screen.queryByText(/_v[12]|Versão [12]/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /selecionar|sincronização|ativar|custo/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'dispatch_status')).toHaveLength(2));
  expect(io.invoke.mock.calls.every(([, options]) => ['onboarding_catalog_snapshot_v2', 'dispatch_status'].includes(options.body.action))).toBe(true);
});

it('does not label a mismatched remote approval as usable', () => {
  const base = snapshot().templates[0] as OfficialTemplateView;
  expect(storeTemplateStatus({ ...base, version: 1, localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: false, syncRequired: true })).toBe('Aprovação ou integridade pendente');
  expect(storeTemplateStatus({ ...base, version: 1, localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: true, syncRequired: false, effectiveCategory: base.requestedCategory })).toBe('Aprovado pela Meta');
  expect(storeTemplateStatus({ ...base, localStatus: 'pending', remoteStatus: 'IN_APPEAL' })).toBe('Recurso em análise na Meta');
});

it('separates remote approval from blocked quality for a v2 utility model', async () => {
  const current = snapshot();
  current.templates = current.templates.map(template => template.logicalId === 'res_confirmacao_v2'
    ? { ...template, localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: true,
      syncRequired: false, effectiveCategory: template.requestedCategory, quality: 'RED' }
    : template);
  reply(current, syntheticDispatchStatus(2)); mount();
  const list = await screen.findByRole('list', { name: 'Textos oficiais dos avisos' });
  const item = within(list).getByText('Confirmação de reserva').closest('li');
  expect(item).toHaveTextContent('Qualidade do modelo impede o envio');
  expect(item).toHaveTextContent('Estado na Meta: aprovado. A qualidade atual exige revisão antes do envio.');
  expect(within(item).queryByText('Aprovado pela Meta')).not.toBeInTheDocument();
});

it('keeps preparation health errors visible and clears them only after recovery', async () => {
  io.reason = 'provider_unavailable'; reply(); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar a Datafy agora');
  expect(screen.getByRole('alert')).toHaveTextContent('vínculo dos modelos continua registrado');
  io.reason = null; reply();
  const refresh = screen.getByRole('button', { name: 'Atualizar dados' });
  await waitFor(() => expect(refresh).toBeEnabled());
  fireEvent.click(refresh);
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'onboarding_catalog_snapshot_v2')).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it('labels an appeal without claiming approval or offering another submission', async () => {
  const current = snapshot();
  current.templates = current.templates.map(template => template.logicalId === 'fila_entrada_v1'
    ? { ...template, remoteStatus: 'IN_APPEAL', localStatus: 'pending' } : template);
  reply(current); mount(); const list = await screen.findByRole('list', { name: 'Textos oficiais dos avisos' });
  expect(within(list).getByText('Entrada na fila').closest('li')).toHaveTextContent('Recurso em análise na Meta');
  expect(screen.queryByRole('button', { name: /submeter|selecionar/i })).not.toBeInTheDocument();
});

it('fails visibly when the catalog read fails', async () => {
  io.invoke.mockResolvedValue({ data: null, error: new Error('unavailable') }); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar o serviço');
  expect(screen.queryByRole('list', { name: 'Textos oficiais dos avisos' })).not.toBeInTheDocument();
});

it('uses server-resolved v2 copy with paragraphs and emoji while hiding technical identities', async () => {
  const current = snapshot(); const definition = TEMPLATE_V2_CATALOG.res_lembrete_dia_v2;
  const template: OfficialTemplateView = { ...current.templates[0], logicalId: definition.id, version: 2, name: definition.name,
    body: definition.body, footer: definition.footer, requestedCategory: definition.requestedCategory,
    localStatus: 'usable', remoteStatus: 'APPROVED', hashMatches: true, syncRequired: false, effectiveCategory: definition.requestedCategory, quality: 'UNKNOWN' };
  const oldReminder = current.templates.find(item => item.logicalId === 'res_lembrete_dia_v1');
  reply({ ...current, templates: [oldReminder, template] }, syntheticDispatchStatus(2, 'awaiting_dispatch')); mount();
  const list = await screen.findByRole('list', { name: 'Textos oficiais dos avisos' });
  const item = within(list).getByText('Lembrete de reserva').closest('li');
  const body = within(item).getByText((_, element) => element?.tagName === 'P' && element.textContent === definition.body);
  expect(body).toHaveClass('whitespace-pre-wrap', 'break-words'); expect(body.textContent).toContain('🕒\n\n');
  expect(screen.queryByText(oldReminder.body)).not.toBeInTheDocument(); expect(screen.queryByText(/_v[12]|Versão [12]/)).not.toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Estado de envio por finalidade' })).toHaveTextContent('Aprovado, aguardando liberação de envio');
  expect(screen.getByRole('alert')).toHaveTextContent('Nem todos os textos da preferência estão disponíveis');
});

it('preserves the stale-policy warning and selected text without exposing historical names', async () => {
  const current = snapshot();
  reply({ ...current, templatePreparation: { enrollment: 'stale', state: 'needs_review', reason: 'policy_changed', updatedAt: current.generatedAt, version: 2, origin: 'auto' } }); mount();
  expect(await screen.findByText('A política de preparação dos modelos mudou. Esta conexão precisa de revisão antes de novas submissões.')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('O histórico dos modelos permanece disponível');
  expect(within(await screen.findByRole('list', { name: 'Textos oficiais dos avisos' })).getAllByRole('listitem')).toHaveLength(9);
  expect(screen.queryByText(/_v[12]/)).not.toBeInTheDocument();
});

it.each(['missing_binding', 'unknown_enum', 'extra_private_field'])('does not default to v1 when projection is %s', async state => {
  const value = syntheticDispatchStatus(state === 'missing_binding' ? null : 1);
  const dispatch = state === 'unknown_enum' ? { entries: value.entries.map((entry, i) => i ? entry : { ...entry, readiness: 'secret' }) }
    : state === 'extra_private_field' ? { ...value, private_cost: 'must not render' } : value;
  reply(snapshot(), dispatch); mount();
  if (state === 'missing_binding') {
    expect(await screen.findByRole('list', { name: 'Textos em preparação' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Estado de envio por finalidade' })).not.toBeInTheDocument();
  }
  else expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conferir o estado dos avisos');
  expect(screen.queryByRole('list', { name: 'Textos oficiais dos avisos' })).not.toBeInTheDocument();
  expect(screen.queryByText('must not render')).not.toBeInTheDocument();
});

it('keeps Datafy models visible before cutover without claiming the active UazAPI dispatch is ready', async () => {
  const current = { ...snapshot(), catalogSelection: { state: 'pending', version: null, digest: null } };
  const oldActive = { ...syntheticDispatchStatus(), channel_id: '50000000-0000-4000-8000-000000000001' };
  reply(current, oldActive); mount();
  const list = await screen.findByRole('list', { name: 'Textos em preparação' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(9);
  expect(within(list).getByText('Confirmação de reserva')).toBeInTheDocument();
  expect(screen.getByText(/estado de envio aparecerá após a ativação/i)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Estado de envio por finalidade' })).not.toBeInTheDocument();
  expect(screen.queryByText(/_v[12]|Versão [12]/)).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => ['onboarding_catalog_snapshot_v2', 'dispatch_status'].includes(options.body.action))).toBe(true);
});

it('keeps validated Datafy preparation copy visible when dispatch status fails before cutover', async () => {
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => {
    if (body.action === 'onboarding_catalog_snapshot_v2') return { data: snapshot(), error: null };
    if (body.action === 'dispatch_status') return { data: null, error: new Error('unavailable') };
    throw new Error('unexpected fixture request');
  });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conferir o estado dos avisos');
  const list = await screen.findByRole('list', { name: 'Textos em preparação' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(9);
  expect(screen.queryByRole('list', { name: 'Estado de envio por finalidade' })).not.toBeInTheDocument();
  expect(screen.queryByText('Configuração pronta para envio')).not.toBeInTheDocument();
});

it('treats a generation mismatch as preparation and never displays the older dispatch state', async () => {
  const oldGeneration = { ...syntheticDispatchStatus(2, 'ready'), generation: 2 };
  reply(snapshot(), oldGeneration); mount();
  expect(await screen.findByRole('list', { name: 'Textos em preparação' })).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Estado de envio por finalidade' })).not.toBeInTheDocument();
  expect(screen.queryByText('Configuração pronta para envio')).not.toBeInTheDocument();
});

it('keeps future v2 preference separate from readiness and rejects mismatched logical identity', () => {
  expect(storeDispatchStatusSchema.safeParse(syntheticDispatchStatus(2, 'pending_meta')).success).toBe(true);
  const value = syntheticDispatchStatus(2); value.entries[0].logical_id = 'fila_entrada_v2';
  expect(storeDispatchStatusSchema.safeParse(value).success).toBe(false);
});

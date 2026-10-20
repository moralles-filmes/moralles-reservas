// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { TEMPLATE_V2_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { TemplateCatalogAdminCard } from './TemplateCatalogAdminCard';

const io = vi.hoisted(() => ({ invoke: vi.fn(), authorized: false, bound: true, redMarketing: false, pendingUnknown: false,
  activeChannelId: '30000000-0000-4000-8000-000000000001' }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));

const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const policy = { version: 2, enabled: false, revision: 0, catalogDigest: 'b'.repeat(64), updatedAt: null };
function snapshot() {
  return projectTemplateSnapshot({
    channel: { id: io.activeChannelId, provider: 'datafy', template_credential_revision: 0 },
    binding: io.bound ? {
      generation: 2, submission_authorized_at: io.authorized ? '2026-10-17T18:00:00Z' : null,
      submission_authorized_by: io.authorized ? '20000000-0000-4000-8000-000000000001' : null,
      dispatch_enabled: false,
    } : null,
    unitAdopted: false, templates: io.redMarketing ? [{
      logical_id: 'mkt_voucher_programado_v1', version: 1, desired_hash: 'same', observed_hash: 'same',
      effective_category: 'MARKETING', remote_status: 'APPROVED', local_status: 'usable', quality: 'RED',
      sync_required: false, last_synced_at: '2026-10-17T18:00:00Z',
    }] : io.pendingUnknown ? [{
      logical_id: 'fila_entrada_v1', version: 1, desired_hash: 'fixed', observed_hash: null,
      effective_category: null, remote_status: 'UNKNOWN', local_status: 'pending', quality: 'UNKNOWN',
      sync_required: true, last_synced_at: null,
    }] : [], jobs: [], generatedAt: '2026-10-17T18:00:00Z',
  });
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TemplateCatalogAdminCard unitId={unitId} /></QueryClientProvider>), client };
}
beforeEach(() => {
  io.invoke.mockReset(); io.authorized = false; io.bound = true; io.redMarketing = false; io.pendingUnknown = false;
  io.activeChannelId = channelId;
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => ({
    data: body.action === 'snapshot_v2' ? snapshot() : body.action === 'v2_policy_snapshot' ? policy : { status: 'updated' }, error: null,
  }));
});

it('requires confirmation and submits a pinned catalog-only admin release', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v1' }));
  expect(screen.getByText(/Nenhuma mensagem será enviada a clientes/)).toBeInTheDocument();
  const descriptionId = screen.getByRole('dialog').getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  expect(document.getElementById(descriptionId!)?.textContent).toContain('submissão dos nove modelos');
  expect(screen.getByRole('dialog')).toHaveTextContent('Liberar catálogo v1 deste canal?');
  expect(screen.getByRole('dialog')).toHaveTextContent('não libera os modelos v2');
  expect(screen.getByText('Catálogo v1 ainda não liberado para este canal.')).toBeInTheDocument();
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'release_channel')).toHaveLength(0);
  const confirm = screen.getByRole('button', { name: 'Confirmar' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: {
    action: 'release_channel', channel_id: channelId, scope: 'catalog', enabled: true,
    expected_credential_revision: 0, expected_binding_generation: 2,
  } }));
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'release_channel')).toHaveLength(1);
  expect(io.invoke.mock.calls.some(([, options]) => options.body.scope === 'dispatch')).toBe(false);
});

it('does not offer a release before the WABA binding is verified', async () => {
  io.bound = false;
  mount();
  expect(await screen.findByText(/vínculo da conta de modelos ainda não foi informado/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Liberar os nove modelos v1' })).not.toBeInTheDocument();
});

it('treats projected catalog rows as expected models and blocks RED marketing approval', async () => {
  io.redMarketing = true;
  mount();
  expect(await screen.findByText(/Catálogo previsto: 9 modelos exibidos/)).toBeInTheDocument();
  expect(screen.getByText(/A lista não comprova submissão à Meta/)).toBeInTheDocument();
  const model = screen.getByText('mkt_voucher_programado_v1').closest('li');
  expect(model?.textContent).toContain('Qualidade do modelo impede o envio');
  expect(model?.textContent).not.toContain('Aprovado pela Meta');
});

it('does not call local pending with UNKNOWN remote status submitted to Meta', async () => {
  io.pendingUnknown = true;
  mount();
  const model = (await screen.findByText('fila_entrada_v1')).closest('li');
  expect(model?.textContent).toContain('Estado remoto ainda não confirmado');
  expect(model?.textContent).not.toContain('Enviado para análise da Meta');
});

it('shows v1 and v2 separately with fixed paragraphs and a version-specific remote state', async () => {
  const current = snapshot();
  const definition = TEMPLATE_V2_CATALOG.fila_entrada_v2;
  io.invoke.mockResolvedValue({ data: { ...current, templates: [current.templates[4], {
    ...current.templates[4], logicalId: definition.id, version: 2, name: definition.name,
    body: definition.body, footer: definition.footer, remoteStatus: 'PENDING', localStatus: 'pending',
  }] }, error: null });
  mount();
  const model = (await screen.findByText(definition.name)).closest('li');
  expect(model).toHaveTextContent('Versão 2');
  expect(model).toHaveTextContent('Em análise na Meta');
  expect(model).toHaveTextContent('A aprovação pela Meta não ativa automações');
  const body = within(model).getByText((_, element) => element?.tagName === 'P' && element.textContent === definition.body);
  expect(body).toHaveClass('whitespace-pre-wrap');
  expect(body.textContent).toContain('⏳\n\n');
  expect(screen.getByText('fila_entrada_v1').closest('li')).toHaveTextContent('Versão 1');
  expect(screen.getByRole('button', { name: 'Liberar os nove modelos v1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /liberar.*v2/i })).not.toBeInTheDocument();
});

it('labels revocation as new-submission stop and keeps dispatch out of the action', async () => {
  io.authorized = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar novas submissões v1' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Revogar novas submissões v1?');
  expect(screen.getByRole('dialog')).toHaveTextContent('Novas submissões v1 deste canal serão interrompidas');
  expect(screen.getByText('Catálogo v1 liberado para este canal.')).toBeInTheDocument();
  expect(screen.getByText(/submissão já confirmada e em andamento pode chegar à Meta/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: {
    action: 'release_channel', channel_id: channelId, scope: 'catalog', enabled: false,
    expected_credential_revision: 0, expected_binding_generation: 2,
  } }));
});

it('clears the confirmation when the administrator changes unit', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v1' }));
  expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();
  view.rerender(<QueryClientProvider client={view.client}>
    <TemplateCatalogAdminCard unitId="10000000-0000-4000-8000-000000000002" />
  </QueryClientProvider>);
  await screen.findByRole('button', { name: 'Liberar os nove modelos v1' });
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => ['snapshot_v2', 'v2_policy_snapshot'].includes(options.body.action))).toBe(true);
});

it('cancels an open confirmation when polling selects another channel in the same unit', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v1' }));
  expect(screen.getByRole('button', { name: 'Confirmar' })).toBeInTheDocument();
  io.activeChannelId = '30000000-0000-4000-8000-000000000002';
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('A configuração do canal mudou');
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => ['snapshot_v2', 'v2_policy_snapshot'].includes(options.body.action))).toBe(true);
});

// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { TemplateCatalogAdminCard } from './TemplateCatalogAdminCard';

const io = vi.hoisted(() => ({ invoke: vi.fn(), selected: false, stopped: false, generation: 3, credentialRevision: 0, policyError: false, ambiguous: false }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const v1Digest = 'a'.repeat(64);
const v2Digest = 'b'.repeat(64);
function snapshot() {
  return {
    ...projectTemplateSnapshot({
      channel: { id: channelId, provider: 'datafy', template_credential_revision: io.credentialRevision },
      binding: { generation: io.generation, submission_authorized_at: null, submission_authorized_by: null, dispatch_enabled: false }, unitAdopted: false,
      templates: [], jobs: [], generatedAt: '2026-10-19T13:00:00Z',
    }),
    catalogSelection: io.stopped ? { state: 'paused', version: null, digest: null }
      : io.selected ? { state: 'ready', version: 2, digest: v2Digest }
        : { state: 'v1', version: 1, digest: v1Digest },
  };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TemplateCatalogAdminCard unitId={unitId} /></QueryClientProvider>), client };
}
beforeEach(() => {
  io.selected = false; io.stopped = false; io.generation = 3; io.credentialRevision = 0; io.policyError = false; io.ambiguous = false;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string } }) => {
    if (body.action === 'snapshot_v2') return { data: snapshot(), error: null };
    if (body.action === 'v2_policy_snapshot') return io.policyError ? { data: null, error: new Error('offline') }
      : { data: { version: 2, enabled: false, revision: 0, catalogDigest: v2Digest, updatedAt: null }, error: null };
    if (body.action === 'select_v2_channel') {
      if (io.ambiguous) return { data: null, error: new Error('network') };
      io.selected = true;
    }
    if (body.action === 'stop_v2_channel') io.stopped = true;
    return { data: { status: 'updated' }, error: null };
  });
});

it('allows a manual existing-account v2 grant while future policy is OFF, once and pinned', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('nove textos v2');
  expect(dialog).toHaveTextContent('conta compartilhada');
  expect(dialog).toHaveTextContent('modelos v1 já existentes serão preservados');
  expect(dialog).toHaveTextContent('o despacho não é habilitado');
  expect(dialog).toHaveTextContent(v2Digest);
  expect(io.invoke.mock.calls.some(([, options]) => options.body.action === 'select_v2_channel')).toBe(false);
  const confirm = within(dialog).getByRole('button', { name: 'Confirmar liberação v2' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: {
    action: 'select_v2_channel', channel_id: channelId, expected_binding_generation: 3,
    expected_credential_revision: 0, expected_digest: v2Digest,
  } }));
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'select_v2_channel')).toHaveLength(1);
  expect(io.invoke.mock.calls.some(([, options]) => ['set_v2_policy', 'release_channel'].includes(options.body.action))).toBe(false);
  expect(await screen.findByText('Catálogo v2 liberado para esta conta.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Liberar os nove modelos v1' })).not.toBeInTheDocument();
});

it('offers a separately confirmed channel v2 stop even when the policy read fails', async () => {
  io.selected = true; io.policyError = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar novas submissões v2' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Uma submissão já confirmada pode chegar à Meta');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar revogação v2' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: {
    action: 'stop_v2_channel', channel_id: channelId, expected_binding_generation: 3, expected_credential_revision: 0,
  } }));
  expect(io.invoke.mock.calls.some(([, options]) => options.body.action === 'set_v2_policy')).toBe(false);
});

it.each(['generation', 'credentialRevision'] as const)('cancels a captured grant after %s changes', async field => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' }));
  io[field] += 1;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('A configuração v2 mudou');
  expect(screen.queryByRole('button', { name: 'Confirmar liberação v2' })).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => ['snapshot_v2', 'v2_policy_snapshot'].includes(options.body.action))).toBe(true);
});

it('blocks manual select when policy cannot be decoded', async () => {
  io.policyError = true;
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar o serviço');
  expect(screen.queryByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' })).not.toBeInTheDocument();
});

it('never repeats an ambiguous grant click after closing and refreshing', async () => {
  io.ambiguous = true;
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar liberação v2' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('precisa de conferência');
  expect(screen.getByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'snapshot_v2').length).toBeGreaterThan(2));
  expect(screen.getByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' })).toBeDisabled();
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'select_v2_channel')).toHaveLength(1);
  view.unmount();
  render(<QueryClientProvider client={view.client}><TemplateCatalogAdminCard unitId={unitId} /></QueryClientProvider>);
  expect(await screen.findByRole('button', { name: 'Liberar os nove modelos v2 nesta conta' })).toBeDisabled();
});

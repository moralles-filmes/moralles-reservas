// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { useWhatsappTemplates } from '@/hooks/useWhatsappTemplates';
import { TemplateDispatchAdminCard } from './TemplateDispatchAdminCard';

const io = vi.hoisted(() => ({
  invoke: vi.fn(), admin: true, signedIn: true, loading: false, role: 'owner', enabled: false, adopted: false,
  generation: 3, credentialRevision: 0, provider: 'datafy', bound: true, readError: false, ambiguous: false,
  invalidMutation: false, selection: 'pending',
}));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({
  user: io.signedIn ? { id: '20000000-0000-4000-8000-000000000001' } : null,
  loading: io.loading, isPlatformAdmin: io.admin, memberships: [{ role: io.role }],
}) }));
const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
function snapshot() {
  return {
    ...projectTemplateSnapshot({
      channel: { id: channelId, provider: io.provider, template_credential_revision: io.credentialRevision },
      binding: io.bound ? { generation: io.generation, dispatch_enabled: io.enabled,
        submission_authorized_at: null, submission_authorized_by: null } : null,
      unitAdopted: io.adopted, templates: [], jobs: [], generatedAt: '2026-10-19T19:00:00Z',
    }),
    catalogSelection: io.selection === 'ready' ? { state: 'ready', version: 2, digest: 'b'.repeat(64) }
      : { state: 'pending', version: null, digest: null },
    templatePreparation: { enrollment: 'eligible', state: 'needs_review', reason: 'health_stale', updatedAt: null },
  };
}
type Options = { body: { action: string; enabled?: boolean } };
const mutationCalls = () => io.invoke.mock.calls.filter(([, options]) => options.body.action === 'release_channel');
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return { ...render(<QueryClientProvider client={client}><TemplateDispatchAdminCard unitId={unitId} /></QueryClientProvider>), client };
}
async function openEnable() {
  const button = await screen.findByRole('button', { name: 'Liberar despacho v1' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole('dialog');
}
beforeEach(() => {
  Object.assign(io, { admin: true, signedIn: true, loading: false, role: 'owner', enabled: false, adopted: false,
    generation: 3, credentialRevision: 0, provider: 'datafy', bound: true, readError: false, ambiguous: false,
    invalidMutation: false, selection: 'pending' });
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (_name: string, { body }: Options) => {
    if (body.action === 'snapshot_v2') return io.readError ? { data: null, error: new Error('private database details') }
      : { data: snapshot(), error: null };
    if (body.action === 'release_channel') {
      if (io.ambiguous) return { data: null, error: new Error('private provider details') };
      if (io.invalidMutation) return { data: { status: 'updated', private: 'must not be shown' }, error: null };
      io.enabled = body.enabled!;
      io.adopted ||= io.enabled;
    }
    return { data: { status: 'updated' }, error: null };
  });
});

it.each(['owner', 'gerente', 'operador'])('does not mount administrative data or actions for a real non-admin %s', role => {
  io.admin = false; io.role = role;
  mount();
  expect(screen.queryByText('Envio automático com modelos v1')).not.toBeInTheDocument();
  expect(io.invoke).not.toHaveBeenCalled();
});
it.each(['loading', 'signedOut'])('waits for a real authenticated administrator when %s', state => {
  if (state === 'loading') io.loading = true;
  else io.signedIn = false;
  mount();
  expect(io.invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('also rejects a direct hook mutation without platform-admin authority', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useWhatsappTemplates(unitId, 'owner', false), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(view.result.current.query.isSuccess).toBe(true));
  await act(async () => { await expect(view.result.current.releaseDispatch.mutateAsync({
    channelId, bindingGeneration: 3, credentialRevision: 0, dispatchEnabled: false, adopted: false, enabled: true,
  })).rejects.toThrow('configuration_changed'); });
  expect(mutationCalls()).toHaveLength(0);
});
it.each(['pending', 'ready'])('confirms one pinned v1 dispatch release independently of v2 %s submissions', async selection => {
  io.selection = selection;
  mount();
  const dialog = await openEnable();
  expect(dialog).toHaveTextContent('fatos elegíveis de toda a unidade');
  expect(dialog).toHaveTextContent('não fica restrita a um contato de teste');
  expect(dialog).toHaveTextContent('podem gerar cobrança');
  expect(dialog).toHaveTextContent('adoção é durável');
  expect(dialog).toHaveTextContent('não retorna ao fluxo legado');
  expect(dialog).toHaveTextContent('não altera a flag global');
  expect(dialog).toHaveTextContent('autorização de custo MARKETING');
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(mutationCalls()).toHaveLength(0);
  const confirm = within(dialog).getByRole('button', { name: 'Confirmar liberação v1' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(await screen.findByText('Liberação v1 registrada. Confira o estado atualizado do canal.')).toBeInTheDocument();
  expect(mutationCalls()).toHaveLength(1);
  expect(mutationCalls()[0]).toEqual(['manage-whatsapp-templates', { body: {
    action: 'release_channel', channel_id: channelId, scope: 'dispatch', enabled: true,
    expected_binding_generation: 3, expected_credential_revision: 0,
  } }]);
  expect(io.invoke.mock.calls.every(([, options]) => ['snapshot_v2', 'release_channel'].includes(options.body.action))).toBe(true);
});
it('consumes the confirmation before its own deferred refetch and preserves successful feedback', async () => {
  let resolveRefetch!: () => void;
  const barrier = new Promise<void>(resolve => { resolveRefetch = resolve; });
  const original = io.invoke.getMockImplementation()!;
  let refetchStarted = false;
  io.invoke.mockImplementation(async (name: string, options: Options) => {
    if (options.body.action === 'snapshot_v2' && io.enabled) { refetchStarted = true; await barrier; }
    return original(name, options);
  });
  const view = mount();
  await openEnable();
  const confirm = screen.getByRole('button', { name: 'Confirmar liberação v1' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(refetchStarted).toBe(true));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Atualizar despacho' })).toBeDisabled();
  expect(mutationCalls()).toHaveLength(1);
  await act(async () => { resolveRefetch(); await barrier; });
  await waitFor(() => expect(view.client.isMutating()).toBe(0));
  expect(await screen.findByText('Liberação v1 registrada. Confira o estado atualizado do canal.')).toBeInTheDocument();
  expect(screen.getByText('Despacho v1 liberado neste canal.')).toBeInTheDocument();
  expect(screen.queryByText('A configuração do despacho mudou. Atualize os dados antes de confirmar.')).not.toBeInTheDocument();
});
it.each(['generation', 'credentialRevision', 'enabled', 'adopted'] as const)('closes a captured confirmation after real %s drift', async field => {
  const view = mount();
  await openEnable();
  if (field === 'generation' || field === 'credentialRevision') io[field] += 1;
  else io[field] = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('A configuração do despacho mudou');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mutationCalls()).toHaveLength(0);
});
it.each(['ambiguous', 'invalidMutation'] as const)('fences an %s outcome across refresh/remount until a fresh read proves the desired state', async outcome => {
  io[outcome] = true;
  const view = mount();
  await openEnable();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar liberação v1' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('O resultado precisa de conferência');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  expect(screen.getByRole('alert')).not.toHaveTextContent('must not be shown');
  expect(screen.getByRole('button', { name: 'Liberar despacho v1' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar despacho' }));
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'snapshot_v2').length).toBeGreaterThan(2));
  expect(screen.getByRole('button', { name: 'Liberar despacho v1' })).toBeDisabled();
  view.unmount(); mount(view.client);
  expect(await screen.findByRole('button', { name: 'Liberar despacho v1' })).toBeDisabled();
  io.enabled = true; io.adopted = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pausar despacho v1' })).toBeEnabled());
  expect(mutationCalls()).toHaveLength(1);
});
it('pauses an existing grant despite provider/capability/health drift and preserves adoption', async () => {
  io.enabled = true; io.adopted = true; io.provider = 'official';
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Pausar despacho v1' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Um envio já confirmado pode concluir');
  expect(screen.getByRole('dialog')).toHaveTextContent('não retorna ao fluxo legado');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar pausa v1' }));
  expect(await screen.findByText('Pausa v1 registrada. A adoção e o histórico da unidade foram preservados.')).toBeInTheDocument();
  expect(screen.getByText('Despacho v1 pausado neste canal.')).toBeInTheDocument();
  expect(screen.getByText(/Adoção durável registrada/)).toBeInTheDocument();
  expect(mutationCalls()).toHaveLength(1);
  expect(mutationCalls()[0][1].body).toMatchObject({ scope: 'dispatch', enabled: false,
    expected_binding_generation: 3, expected_credential_revision: 0 });
  expect(io.adopted).toBe(true);
});
it('allows a new deliberate enable after a reconciled pause without discarding sticky adoption', async () => {
  mount();
  await openEnable();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar liberação v1' }));
  const pause = await screen.findByRole('button', { name: 'Pausar despacho v1' });
  await waitFor(() => expect(pause).toBeEnabled());
  fireEvent.click(pause);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar pausa v1' }));
  await openEnable();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar liberação v1' }));
  await waitFor(() => expect(mutationCalls()).toHaveLength(3));
  expect(mutationCalls().map(([, options]) => options.body.enabled)).toEqual([true, false, true]);
  expect(io.adopted).toBe(true);
});
it.each(['provider', 'binding'] as const)('does not enable without a known current Datafy %s', async missing => {
  if (missing === 'provider') io.provider = 'official';
  else io.bound = false;
  mount();
  expect(await screen.findByText(/A liberação exige um canal Datafy atual/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Liberar despacho v1' })).not.toBeInTheDocument();
  expect(mutationCalls()).toHaveLength(0);
});
it('fails closed and sanitizes read failure even when the cache contains an earlier eligible snapshot', async () => {
  const view = mount();
  await openEnable();
  io.readError = true;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Liberar despacho v1' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('alert').map(alert => alert.textContent).join(' ')).not.toContain('private database details');
  expect(mutationCalls()).toHaveLength(0);
});

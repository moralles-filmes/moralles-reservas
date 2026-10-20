// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { SCHEDULED_KINDS } from '../../../supabase/functions/_shared/whatsapp-automation-core';
import { dispatchV2Variants, dispatchVersionSnapshotSchema, type DispatchVersionSnapshot } from '@/features/whatsapp/template-dispatch-versions';
import { TemplateDispatchVersionAdminCard } from './TemplateDispatchVersionAdminCard';

const io = vi.hoisted(() => ({ invoke: vi.fn(), admin: true, signedIn: true, loading: false,
  generation: 1, revision: 0, version: 1 as 1 | 2 | null, source: 'legacy' as 'legacy' | 'admin' | 'auto' | null,
  pending: false, ambiguous: false, invalid: false, state: 'selected', failRead: false,
  beforeReturn: null as null | (() => Promise<void>), getterAfterSelect: null as null | (() => Promise<void>), selected: false }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: io.signedIn ? { id: actorId } : null,
  loading: io.loading, isPlatformAdmin: io.admin }) }));
const unitId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000001';
const channelId = '30000000-0000-4000-8000-000000000001';
const bindingId = '40000000-0000-4000-8000-000000000001';
function getter(): DispatchVersionSnapshot {
  return { binding_id: bindingId, channel_id: channelId, generation: io.generation, credential_revision: 0,
    entries: SCHEDULED_KINDS.map(kind => ({ kind, selected_version: io.version, selection_source: io.source, revision: io.revision,
      v2_ready: !io.pending, v2_reason_code: io.pending ? 'meta_pending' : 'ready',
      variants: dispatchV2Variants[kind].map((logical_id, index) => ({ logical_id, status: io.pending && index === 1 ? 'PENDING' : 'APPROVED', ready: !(io.pending && index === 1) })),
    })) };
}
type Request = { action: string; version?: 1 | 2 };
const setters = () => io.invoke.mock.calls.filter(([, options]) => options.body.action === 'select_dispatch_version');
function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return { ...render(<QueryClientProvider client={client}><TemplateDispatchVersionAdminCard unitId={unitId} /></QueryClientProvider>), client };
}
async function choose(version: 1 | 2 = 2) {
  const button = await screen.findByRole('button', { name: `Selecionar v${version} para Confirmação de reserva` });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole('dialog');
}
beforeEach(() => {
  Object.assign(io, { admin: true, signedIn: true, loading: false, generation: 1, revision: 0, version: 1, source: 'legacy',
    pending: false, ambiguous: false, invalid: false, state: 'selected', failRead: false, beforeReturn: null, getterAfterSelect: null, selected: false });
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (_name: string, { body }: { body: Request }) => {
    if (body.action === 'snapshot_v2') return { data: projectTemplateSnapshot({
      channel: { id: channelId, provider: 'datafy', template_credential_revision: 0 },
      binding: { generation: io.generation, dispatch_enabled: true, submission_authorized_at: null, submission_authorized_by: null },
      unitAdopted: true, templates: [], jobs: [], generatedAt: '2026-10-19T19:00:00Z',
    }), error: null };
    if (body.action === 'dispatch_version_snapshot') {
      if (io.selected && io.getterAfterSelect) await io.getterAfterSelect();
      return io.failRead ? { data: null, error: new Error('private error') }
        : { data: io.invalid ? { ...getter(), private: 'must not render' } : getter(), error: null };
    }
    if (body.action === 'select_dispatch_version') {
      io.selected = true;
      if (io.beforeReturn) await io.beforeReturn();
      if (io.ambiguous) return { data: null, error: new Error('private provider details') };
      if (io.state === 'selected') { io.version = body.version; io.source = 'admin'; io.revision++; }
      return { data: { state: io.state, version: io.source === 'admin' ? io.version : null,
        revision: io.source === 'admin' ? io.revision : 0 }, error: null };
    }
    throw new Error('unexpected fixture request');
  });
});

it.each(['notAdmin', 'signedOut', 'loading'])('does not mount admin requests when %s', state => {
  if (state === 'notAdmin') io.admin = false;
  if (state === 'signedOut') io.signedIn = false;
  if (state === 'loading') io.loading = true;
  mount(); expect(io.invoke).not.toHaveBeenCalled(); expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('shows eight independent purposes and both confirmation variants, then sends one exact CAS without release/cost actions', async () => {
  mount();
  expect((await screen.findByRole('list', { name: 'Preferências por finalidade' })).children).toHaveLength(8);
  expect(screen.getByRole('list', { name: 'Modelos v2 de Confirmação de reserva' })).toHaveTextContent('res_confirmacao_desconto_v2: APPROVED');
  const dialog = await choose();
  expect(dialog).toHaveTextContent('não envia mensagens nem altera jobs existentes');
  expect(dialog).toHaveTextContent('autorização de custo específica');
  const confirm = within(dialog).getByRole('button', { name: 'Confirmar preferência' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await screen.findByText(/Preferência v2 registrada para confirmação de reserva/);
  expect(setters()).toEqual([['manage-whatsapp-templates', { body: {
    action: 'select_dispatch_version', binding_id: bindingId, kind: 'confirmation', version: 2,
    expected_revision: 0, expected_generation: 1, expected_credential_revision: 0,
  } }]]);
  expect(io.invoke.mock.calls.every(([, options]) => ['snapshot_v2', 'dispatch_version_snapshot', 'select_dispatch_version'].includes(options.body.action))).toBe(true);
  expect(screen.queryByText(/preferência ou o canal mudou/i)).not.toBeInTheDocument();
});

it('consumes confirmation before a delayed mutation and its own refetch, without a stale notice', async () => {
  let complete: () => void;
  io.getterAfterSelect = () => new Promise<void>(resolve => { complete = resolve; });
  mount(); const dialog = await choose();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar preferência' }));
  await waitFor(() => expect(setters()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText(/preferência ou o canal mudou/i)).not.toBeInTheDocument();
  await act(async () => { complete(); });
  await screen.findByText(/Preferência v2 registrada/);
});

it('blocks v2 when one confirmation variant is pending while allowing explicit v1', async () => {
  io.pending = true; mount();
  expect(await screen.findByRole('button', { name: 'Selecionar v2 para Confirmação de reserva' })).toBeDisabled();
  expect(screen.getByRole('list', { name: 'Modelos v2 de Confirmação de reserva' })).toHaveTextContent('res_confirmacao_desconto_v2: PENDING');
  const dialog = await choose(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar preferência' }));
  await screen.findByText(/Preferência v1 registrada/); expect(setters()).toHaveLength(1);
});

it('closes a captured confirmation on actual generation drift without posting', async () => {
  const view = mount(); await choose(); io.generation = 2;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-templates', unitId], exact: true }); });
  await screen.findByText(/preferência ou o canal mudou/i);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(setters()).toHaveLength(0);
});

it('keeps an ambiguous attempt fenced across remount until an authoritative read proves its revision', async () => {
  io.ambiguous = true; const view = mount(); const dialog = await choose();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar preferência' }));
  await screen.findByText(/O resultado precisa de conferência/);
  expect(screen.queryByText(/private provider/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Selecionar v2 para Confirmação de reserva' })).toBeDisabled();
  view.unmount(); mount(view.client);
  expect(await screen.findByRole('button', { name: 'Selecionar v2 para Confirmação de reserva' })).toBeDisabled();
  expect(setters()).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Atualizar preferências' })).toBeEnabled());
  io.version = 2; io.source = 'admin'; io.revision = 1;
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar preferências' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Selecionar v1 para Confirmação de reserva' })).toBeEnabled());
});

it('does not infer v1 from an unresolved selection and fails closed for an extra private DTO field', async () => {
  io.version = null; io.source = null; const view = mount();
  expect((await screen.findAllByText(/Preferência não resolvida/))).toHaveLength(8);
  expect(screen.queryByText('Preferência atual: v1.')).not.toBeInTheDocument();
  io.invalid = true;
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar preferências' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível consultar o serviço'));
  expect(screen.queryByText('must not render')).not.toBeInTheDocument(); expect(setters()).toHaveLength(0); view.unmount();
});

it.each(['stale', 'not_ready', 'refused'])('reports %s without claiming a successful selection', async state => {
  io.state = state; mount(); const dialog = await choose();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar preferência' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(state === 'stale' ? 'A preferência mudou' : 'A seleção não foi registrada'));
  expect(screen.queryByText(/Preferência v2 registrada/)).not.toBeInTheDocument(); expect(setters()).toHaveLength(1);
});

it('rejects duplicate/missing purposes, unknown enums, mismatched variants and false readiness', () => {
  const original = getter(); expect(dispatchVersionSnapshotSchema.safeParse(original).success).toBe(true);
  const changes = [
    { ...original, entries: original.entries.slice(1) },
    { ...original, entries: [original.entries[0], ...original.entries.slice(0, 7)] },
    { ...original, entries: original.entries.map((entry, i) => i ? entry : { ...entry, v2_reason_code: 'secret error' }) },
    { ...original, entries: original.entries.map((entry, i) => i ? entry : { ...entry, variants: entry.variants.slice(1) }) },
    { ...original, entries: original.entries.map((entry, i) => i ? entry : { ...entry, variants: [{ logical_id: 'fila_entrada_v2', status: 'APPROVED', ready: true }] }) },
    { ...original, entries: original.entries.map((entry, i) => i ? entry : { ...entry, v2_reason_code: 'meta_pending' }) },
  ];
  for (const value of changes) expect(dispatchVersionSnapshotSchema.safeParse(value).success).toBe(false);
});

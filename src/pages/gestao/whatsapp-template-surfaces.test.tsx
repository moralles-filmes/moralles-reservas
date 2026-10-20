import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { APPROVED_CATALOG_DIGESTS } from '../../../supabase/functions/_shared/whatsapp-template-cohort';
import { createTemplateManagementHandler } from '../../../supabase/functions/_shared/whatsapp-template-management';
import { syntheticDispatchStatus } from '@/test/fixtures/whatsapp-dispatch-status';
import Reservas from './reservas/Comunicacao';
import Fila from './fila/Comunicacao';
import Giftback from './giftback/Ajustes';

const io = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), mode: 'official', role: 'owner', admin: false, slug: 'unidade-a', unitId: '10000000-0000-4000-8000-000000000001', saves: [] as unknown[], filters: [] as unknown[], rpc: vi.fn(), bound: false, choice: 'unknown', jobs: [] as Record<string, unknown>[], concurrentOptOut: false, holdWrite: null as Promise<void> | null }));
const unitId = '10000000-0000-4000-8000-000000000001';
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke }, from: io.from } }));
vi.mock('@/hooks/useCurrentUnit', () => ({ useCurrentUnit: () => ({ unit_id: io.unitId, unit_slug: io.slug, unit_name: io.slug === 'unidade-a' ? 'Unidade A' : 'Unidade B', organization_id: '20000000-0000-4000-8000-000000000001', role: io.role, isGerente: io.role !== 'operador' }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ isPlatformAdmin: io.admin }) }));
vi.mock('./reservas/Saloes', () => ({ BreadcrumbReservas: () => <span>Reservas</span> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
function snapshot(mode = io.mode) {
  return projectTemplateSnapshot(snapshotInput(mode));
}
function snapshotInput(mode = io.mode) {
  return { channel: mode === 'unavailable' ? null : { id: '30000000-0000-4000-8000-000000000001', provider: mode === 'official' ? 'datafy' : 'zapi', template_credential_revision: 0 }, binding: mode !== 'unavailable' && io.bound ? { generation: 1, submission_authorized_at: null, submission_authorized_by: null, dispatch_enabled: false } : null,
    catalogSelection: mode === 'official' && io.bound ? { state: 'v1', version: 1, digest: APPROVED_CATALOG_DIGESTS[1], grant_binding_id: null, generation: 1, credential_revision: 0 } : null,
    unitAdopted: false, templates: [], jobs: io.jobs, generatedAt: '2026-10-09T12:00:00Z' };
}
beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false; Element.prototype.scrollIntoView = () => { };
  io.mode = 'official'; io.role = 'owner'; io.admin = false; io.slug = 'unidade-a'; io.unitId = unitId; io.saves = []; io.filters = []; io.bound = true; io.jobs = []; io.choice = 'unknown'; io.concurrentOptOut = false; io.holdWrite = null;
  io.rpc.mockReset().mockImplementation(async (_jwt: string, name: string, args: Record<string, unknown>) => {
    if (name === 'get_whatsapp_automation_dispatch_status') return { data: syntheticDispatchStatus(), error: null };
    if (name === 'get_whatsapp_message_consent_state') return { data: { purpose: args.p_purpose, status: io.choice, revision: io.choice === 'unknown' ? null : 2 }, error: null };
    if (name === 'record_whatsapp_message_consent') { io.choice = io.concurrentOptOut ? 'opt_out' : String(args.p_decision); return { data: 2, error: null }; }
    if (name === 'request_whatsapp_template_sync_for_channel') return { data: '50000000-0000-4000-8000-000000000001', error: null };
    return { data: true, error: null };
  });
  const handler = createTemplateManagementHandler({ authenticate: async () => ({ id: '40000000-0000-4000-8000-000000000001' }), access: async () => ({ role: io.role as 'owner' | 'gerente' | 'operador', isPlatformAdmin: io.admin, exists: true }), snapshot: async () => snapshotInput(), onboardingSnapshot: async () => snapshotInput(), resolveActiveBinding: async () => io.mode === 'official' && io.bound ? '50000000-0000-4000-8000-000000000001' : null, callerRpc: io.rpc });
  io.invoke.mockReset().mockImplementation(async (_name: string, { body }: { body: unknown }) => {
    const response = await handler(new Request('http://localhost:3000/functions/v1/manage-whatsapp-templates', { method: 'POST', headers: { authorization: 'Bearer synthetic-test-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return response.ok ? { data: await response.json(), error: null } : { data: null, error: new FunctionsHttpError(response) };
  });
  io.from.mockReset().mockImplementation((table: string) => {
    const rows = table === 'settings' ? [
      { key: 'giftback_whatsapp_enabled', value: true }, { key: 'giftback_email_enabled', value: false }, { key: 'giftback_message_template', value: 'Texto legado salvo' },
    ] : table === 'customers' ? [{ id: '60000000-0000-4000-8000-000000000001', name: 'Contato sintético', phone: '55999998888' }] : [{ event: 'reminder_d1', customized: true, body: 'Texto salvo reservas' }, { event: 'entered', customized: true, body: 'Texto salvo fila' }, { event: 'table_ready', customized: true, body: 'Mesa pronta salva' }];
    const chain = {
      select: vi.fn((...args: unknown[]) => { io.filters.push(['select', ...args]); return chain; }), eq: vi.fn((...args: unknown[]) => { io.filters.push(['eq', ...args]); return chain; }), in: vi.fn(() => chain), is: vi.fn((...args: unknown[]) => { io.filters.push(['is', ...args]); return chain; }), limit: vi.fn((...args: unknown[]) => { io.filters.push(['limit', ...args]); return chain; }), abortSignal: vi.fn(() => chain),
      upsert: vi.fn(async (payload: unknown) => { io.saves.push(payload); if (io.holdWrite) await io.holdWrite; return { error: null }; }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
    };
    return chain;
  });
});
function UnitNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => { io.unitId = '10000000-0000-4000-8000-000000000002'; io.slug = 'unidade-b'; navigate('/g/unidade-b'); }}>Trocar para unidade B</button>;
}
function mount(Page: typeof Reservas) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/g/unidade-a']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><UnitNavigation /><Routes><Route path="/g/:unitSlug" element={<Page />} /></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s displays official read-only models', async (_, Page) => {
  mount(Page); await screen.findAllByText('Qualidade desconhecida');
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
  expect(screen.queryByText('Personalizar mensagem')).not.toBeInTheDocument();
});
it('does not fabricate a catalog selection when the official binding is absent', async () => {
  io.bound = false;
  mount(Reservas);
  expect(await screen.findByText(/vínculo da conta de modelos deste canal ainda não foi informado/)).toBeInTheDocument();
  expect(screen.queryByText('Qualidade desconhecida')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
});
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s preserves a dirty TEXT draft across remote refresh', async (_, Page) => {
  io.mode = 'unofficial'; const client = mount(Page);
  const input = await screen.findByRole('textbox', { name: 'Mensagem' });
  fireEvent.change(input, { target: { value: 'Rascunho ainda não salvo' } });
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Mensagem' })).toHaveValue('Rascunho ainda não salvo'));
});
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s shows retry on a real closed management failure and never a TEXT editor', async (_, Page) => {
  io.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ error: 'dependency_unavailable', private: 'never display' }), { status: 503 })) });
  mount(Page); await screen.findByText(/Não foi possível consultar o serviço/);
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument(); expect(screen.queryByText('never display')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
});
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s does not expose a TEXT editor while snapshot is loading', async (_, Page) => {
  io.invoke.mockImplementation(() => new Promise(() => { })); mount(Page);
  await screen.findByText('Consultando o canal de WhatsApp…'); expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
});
it('rejects a malformed complete snapshot instead of accepting its unofficial mode', async () => {
  io.invoke.mockResolvedValue({ data: { ...snapshot('unofficial'), configuration: { ...snapshot().configuration, bindingGeneration: 0 } }, error: null });
  mount(Reservas); await screen.findByText(/Não foi possível consultar o serviço/); expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
});
it('table_ready shows its official model and blocked job without exposing a TEXT editor', async () => {
  io.jobs = [blockedJob({ initial_catalog_key: 'fila_mesa_pronta_v1', kind: 'waitlist_table_ready' })];
  mount(Fila); await screen.findByText(/Canal:/);
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'Sua mesa está pronta' }));
  expect(screen.getByText(/Sua mesa em/)).toBeInTheDocument();
  expect(screen.getByText('Uma mensagem está impedida de continuar.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Salvar mensagem' })).not.toBeInTheDocument();
  expect(io.saves).toHaveLength(0);
});
it('table_ready retains the manual TEXT draft on an unofficial channel', async () => {
  io.mode = 'unofficial'; mount(Fila); await screen.findByText(/Canal:/);
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'Sua mesa está pronta' }));
  const editor = await screen.findByRole('textbox', { name: 'Mensagem' }); expect(editor).toHaveValue('Mesa pronta salva');
  fireEvent.change(editor, { target: { value: 'Mesa pronta editada' } }); fireEvent.click(screen.getByRole('button', { name: 'Salvar mensagem' }));
  await waitFor(() => expect(io.saves).toHaveLength(1)); expect(io.saves[0]).toMatchObject({ unit_id: unitId, event: 'table_ready', body: 'Mesa pronta editada' });
});
it.each(['official', 'unofficial'])('cancellation in %s mode is automatic and has no legacy editor', async mode => {
  io.mode = mode; mount(Reservas); await screen.findByText(/Canal:/);
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'Reserva cancelada' }));
  expect(screen.getByText('Mensagem automática enviada quando uma reserva é cancelada.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Salvar mensagem' })).not.toBeInTheDocument();
  if (mode === 'official') expect(screen.getByText(/Sua reserva em/)).toBeInTheDocument();
  expect(io.saves).toHaveLength(0);
});
it('a unit switch resets a cancellation selection before the next snapshot', async () => {
  mount(Reservas); await screen.findByText(/Canal:/);
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'Reserva cancelada' }));
  expect(screen.getByText(/Sua reserva em/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Trocar para unidade B' }));
  await screen.findByText(/Canal:/);
  expect(screen.queryByText(/Sua reserva em/)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
});
it.each(['loading', 'error'])('table_ready exposes no TEXT editor on a %s channel snapshot', async state => {
  io.mode = 'unofficial';
  io.invoke.mockImplementation(() => state === 'loading'
    ? new Promise(() => { })
    : Promise.resolve({ data: null, error: new FunctionsHttpError(new Response('{}', { status: 503 })) }));
  mount(Fila);
  const user = userEvent.setup(); await user.click(screen.getByRole('combobox')); await user.click(screen.getByRole('option', { name: 'Sua mesa está pronta' }));
  if (state === 'loading') await screen.findByText('Consultando o canal de WhatsApp…');
  else await screen.findByText(/Não foi possível consultar o serviço/);
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Salvar mensagem' })).not.toBeInTheDocument();
});
it('TEXT restores defaults, inserts chips, previews and saves the actual draft', async () => {
  io.mode = 'unofficial'; mount(Reservas); await screen.findByRole('textbox', { name: 'Mensagem' });
  fireEvent.click(screen.getByRole('button', { name: 'Nome do cliente' })); expect(screen.getByRole('textbox', { name: 'Mensagem' })).toHaveValue('Texto salvo reservas {{cliente_nome}}');
  expect(screen.getByText('Texto salvo reservas Maria')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrão' })); expect(screen.getByRole('switch')).not.toBeChecked();
  fireEvent.click(screen.getByRole('switch')); fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem' }), { target: { value: 'Novo texto' } }); fireEvent.click(screen.getByRole('button', { name: 'Salvar mensagem' }));
  await waitFor(() => expect(io.saves).toHaveLength(1)); expect(io.saves[0]).toMatchObject({ body: 'Novo texto', customized: true });
});
it('store refreshes official model status without a sync request and preserves a hidden dirty Giftback TEXT draft', async () => {
  io.mode = 'unofficial'; io.bound = true; const client = mount(Giftback); const editor = await screen.findByRole('textbox', { name: 'Mensagem' }); fireEvent.change(editor, { target: { value: 'Meu rascunho' } });
  io.mode = 'official'; await act(async () => { await client.invalidateQueries({ queryKey: ['whatsapp-templates'] }); });
  await screen.findAllByText('Qualidade desconhecida');
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Solicitar sincronização' })).not.toBeInTheDocument();
  const snapshotReads = io.invoke.mock.calls.filter(([, args]) => args.body.action === 'snapshot_v2').length;
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }));
  await waitFor(() => expect(io.invoke.mock.calls.filter(([, args]) => args.body.action === 'snapshot_v2').length).toBeGreaterThan(snapshotReads));
  expect(io.rpc.mock.calls.some(([, name]) => name === 'request_whatsapp_template_sync_for_channel')).toBe(false);
  io.mode = 'unofficial'; await act(async () => { await client.invalidateQueries({ queryKey: ['whatsapp-templates'] }); });
  expect(await screen.findByRole('textbox', { name: 'Mensagem' })).toHaveValue('Meu rascunho');
});
it('a mismatched resolved slug starts no query or mutation', () => {
  io.slug = 'unidade-b'; mount(Giftback); expect(screen.getByText('Carregando unidade…')).toBeInTheDocument(); expect(io.from).not.toHaveBeenCalled(); expect(io.invoke).not.toHaveBeenCalled();
});
it.each(['operador', 'gerente', 'admin'])('individual controls honor the actual %s role', async role => {
  io.role = role === 'admin' ? 'owner' : role; io.admin = role === 'admin'; mount(Giftback); await screen.findAllByText('Qualidade desconhecida');
  expect(!!screen.queryByText('Consentimento individual')).toBe(role !== 'operador');
  expect(screen.getByRole('switch', { name: 'WhatsApp' }).hasAttribute('disabled')).toBe(role === 'operador');
});
async function selectContact() {
  fireEvent.change(screen.getByLabelText('Telefone do contato com DDD'), { target: { value: '55 99999-8888' } }); fireEvent.click(screen.getByRole('button', { name: 'Buscar contato' }));
  fireEvent.click(await screen.findByRole('button', { name: /Selecionar Contato sintético/ })); await screen.findByText(/Escolha atual:/);
}
it('looks up exactly the canonical DDD55 phone in the actual organization and reads selected consent only', async () => {
  mount(Giftback); await screen.findByText('Consentimento individual');
  expect(io.rpc.mock.calls.some(([, name]) => name === 'get_whatsapp_message_consent_state')).toBe(false); await selectContact();
  expect(io.filters).toContainEqual(['select', 'id,name,phone']); expect(io.filters).toContainEqual(['eq', 'organization_id', '20000000-0000-4000-8000-000000000001']); expect(io.filters).toContainEqual(['eq', 'phone', '55999998888']); expect(io.filters).toContainEqual(['is', 'deleted_at', null]); expect(io.filters).toContainEqual(['limit', 2]);
  expect(screen.getByText(/nenhuma escolha registrada/)).toBeInTheDocument();
  expect(io.rpc).toHaveBeenCalledWith('synthetic-test-jwt', 'get_whatsapp_message_consent_state', { p_unit_id: unitId, p_customer_id: '60000000-0000-4000-8000-000000000001', p_purpose: 'promotional' });
});
it('records explicit evidence then displays the reread state even if a concurrent opt-out wins', async () => {
  io.concurrentOptOut = true; mount(Giftback); await screen.findByText('Consentimento individual'); await selectContact();
  fireEvent.change(screen.getByLabelText('Decisão do contato'), { target: { value: 'opt_in' } }); fireEvent.change(screen.getByLabelText('Origem da evidência'), { target: { value: 'in_person' } }); fireEvent.change(screen.getByLabelText('Data e hora da escolha'), { target: { value: '2026-10-01T10:00' } }); fireEvent.change(screen.getByLabelText('Referência da evidência'), { target: { value: 'Ficha individual 42' } }); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Registrar escolha' }));
  await screen.findByText(/Registro recebido/); expect(screen.getByText(/recusou esta finalidade/)).toBeInTheDocument();
  expect(io.rpc).toHaveBeenCalledWith('synthetic-test-jwt', 'record_whatsapp_message_consent', expect.objectContaining({ p_decision: 'opt_in', p_source_code: 'in_person', p_evidence_reference: 'Ficha individual 42', p_purpose: 'promotional' }));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
it('purpose change clears evidence/confirmation and a consent read error never becomes unknown', async () => {
  mount(Giftback); await screen.findByText('Consentimento individual'); await selectContact();
  fireEvent.change(screen.getByLabelText('Referência da evidência'), { target: { value: 'Rascunho A' } }); fireEvent.click(screen.getByRole('checkbox'));
  io.rpc.mockResolvedValue({ data: null, error: { code: 'unexpected' } });
  fireEvent.change(screen.getByLabelText('Finalidade'), { target: { value: 'operational' } });
  await screen.findByText('Estado atual indisponível.'); expect(screen.queryByText(/nenhuma escolha registrada/)).not.toBeInTheDocument(); expect(screen.getByLabelText('Referência da evidência')).toHaveValue(''); expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Registrar escolha' })).toBeDisabled();
});
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s never falls back to TEXT on unavailable or failed snapshot', async (_, Page) => {
  io.mode = 'unavailable'; mount(Page);
  await screen.findByText(/Nenhum canal disponível/);
  expect(screen.queryByRole('textbox', { name: 'Mensagem' })).not.toBeInTheDocument();
});
it('official Giftback configuration save omits the legacy after_rating body', async () => {
  mount(Giftback); await screen.findAllByText('Qualidade desconhecida');
  fireEvent.click(screen.getByRole('switch', { name: 'WhatsApp' }));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }));
  await waitFor(() => expect(io.saves).toHaveLength(1));
  expect((io.saves[0] as { key: string }[]).some(row => row.key === 'giftback_message_template')).toBe(false);
});
it.each(['owner', 'operador'])('WhatsApp label click honors %s permission and keeps dirty/save semantics', async role => {
  io.role = role;
  mount(Giftback);
  await screen.findAllByText('Qualidade desconhecida');
  const control = screen.getByRole('switch', { name: 'WhatsApp' });
  const label = screen.getByText('WhatsApp', { selector: 'label' });
  const save = screen.getByRole('button', { name: 'Salvar configuração' });
  const user = userEvent.setup();
  expect(control).toBeChecked();
  expect(save).toBeDisabled();
  await user.click(label);
  if (role === 'operador') {
    expect(control).toBeChecked();
    expect(control).toBeDisabled();
    expect(save).toBeDisabled();
    expect(io.saves).toHaveLength(0);
    return;
  }
  expect(control).not.toBeChecked();
  expect(save).toBeEnabled();
  await user.click(label);
  expect(control).toBeChecked();
  expect(save).toBeDisabled();
  await user.click(label);
  await user.click(save);
  await waitFor(() => expect(io.saves).toHaveLength(1));
  expect(io.saves[0]).toContainEqual({ unit_id: unitId, key: 'giftback_whatsapp_enabled', value: false });
  expect((io.saves[0] as { key: string }[]).some(row => row.key === 'giftback_message_template')).toBe(false);
});

function blockedJob(overrides: Record<string, unknown> = {}) {
  return { id: '70000000-0000-4000-8000-000000000001', target: 'automation', initial_catalog_key: 'res_lembrete_dia_v1', state: 'blocked', error_code: 'consent_changed', attempts: 0, pin_phase: 'bound', kind: 'reminder_d1', channel_id: '30000000-0000-4000-8000-000000000001', fact_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(), ...overrides };
}
it('eligible explicit correction uses current assertions; a SQL false is refusal followed by refresh', async () => {
  io.bound = true; io.jobs = [blockedJob()]; io.rpc.mockResolvedValue({ data: false, error: null }); mount(Reservas);
  fireEvent.click(await screen.findByRole('button', { name: 'Verificar correção' }));
  await screen.findByText(/Esta ação não está disponível para a configuração atual/);
  expect(screen.queryByText(/Correção registrada/)).not.toBeInTheDocument();
  expect(io.rpc).toHaveBeenCalledWith('synthetic-test-jwt', 'revalidate_whatsapp_automation_job', { p_job_id: '70000000-0000-4000-8000-000000000001', p_expected_channel_id: '30000000-0000-4000-8000-000000000001', p_expected_binding_generation: 1 });
  expect(io.invoke.mock.calls.filter(([, args]) => args.body.action === 'snapshot_v2').length).toBeGreaterThan(1);
});
it.each([
  ['accepted', { state: 'accepted' }], ['uncertain', { state: 'uncertain' }], ['rejected', { state: 'rejected' }],
  ['preconfiguration', { pin_phase: 'preconfiguration' }], ['unknown reason', { error_code: 'unknown_private_reason' }],
  ['expired', { expires_at: '2020-01-01T00:00:00Z' }],
  ['catalog', { target: 'catalog', target_key: 'res_lembrete_dia_v1', state: 'needs_review', created_at: '2026-10-01T00:00:00Z', due_at: '2026-10-01T00:00:00Z' }],
] as const)('never offers correction for %s', async (_, overrides) => {
  io.bound = true; io.jobs = [blockedJob(overrides)]; mount(Reservas); await screen.findAllByText('Qualidade desconhecida');
  expect(screen.queryByRole('button', { name: 'Verificar correção' })).not.toBeInTheDocument();
  expect(io.rpc.mock.calls.some(([, name]) => name === 'revalidate_whatsapp_automation_job')).toBe(false);
});
it.each([['reservas', Reservas], ['fila', Fila], ['giftback', Giftback]] as const)('%s discards an A draft on unit switch and only submits B data', async (_, Page) => {
  io.mode = 'unofficial'; mount(Page); fireEvent.change(await screen.findByRole('textbox', { name: 'Mensagem' }), { target: { value: 'Rascunho da unidade A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Trocar para unidade B' }));
  const editor = await screen.findByRole('textbox', { name: 'Mensagem' }); expect(editor).not.toHaveValue('Rascunho da unidade A');
  fireEvent.change(editor, { target: { value: 'Rascunho da unidade B' } }); fireEvent.click(screen.getByRole('button', { name: Page === Giftback ? 'Salvar alterações' : 'Salvar mensagem' }));
  await waitFor(() => expect(io.saves).toHaveLength(1));
  const rows = Array.isArray(io.saves[0]) ? io.saves[0] : [io.saves[0]];
  expect(rows.every((row: { unit_id: string }) => row.unit_id === io.unitId)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('Rascunho da unidade A');
});
it('a late A settings save cannot reset the B draft', async () => {
  io.mode = 'unofficial'; let release!: () => void; io.holdWrite = new Promise<void>(resolve => { release = resolve; }); mount(Giftback);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Mensagem' }), { target: { value: 'Salvar A' } }); fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
  await waitFor(() => expect(io.saves).toHaveLength(1)); fireEvent.click(screen.getByRole('button', { name: 'Trocar para unidade B' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Mensagem' }), { target: { value: 'Continuar editando B' } });
  await act(async () => { release(); await io.holdWrite; });
  expect(screen.getByRole('textbox', { name: 'Mensagem' })).toHaveValue('Continuar editando B');
  expect((io.saves[0] as { unit_id: string }[]).every(row => row.unit_id === unitId)).toBe(true);
});
it('changing unit clears contact selection, evidence and confirmation before a new read', async () => {
  mount(Giftback); await screen.findByText('Consentimento individual'); await selectContact();
  fireEvent.change(screen.getByLabelText('Referência da evidência'), { target: { value: 'Referência de A' } }); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Trocar para unidade B' })); await screen.findByText('Consentimento individual');
  expect(screen.queryByText(/Contato selecionado:/)).not.toBeInTheDocument(); expect(screen.queryByLabelText('Referência da evidência')).not.toBeInTheDocument();
  expect(io.rpc.mock.calls.filter(([, name]) => name === 'get_whatsapp_message_consent_state')).toHaveLength(1);
  await selectContact(); expect(screen.getByLabelText('Referência da evidência')).toHaveValue(''); expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(io.rpc).toHaveBeenLastCalledWith('synthetic-test-jwt', 'get_whatsapp_message_consent_state', expect.objectContaining({ p_unit_id: io.unitId }));
});
it('evidence requires an explicit decision, origin, past date, reference and confirmation before writing', async () => {
  mount(Giftback); await screen.findByText('Consentimento individual'); await selectContact();
  fireEvent.click(screen.getByRole('button', { name: 'Registrar escolha' }));
  await screen.findByText('Confirme que esta é a escolha expressa do contato.');
  await waitFor(() => expect(screen.getByLabelText('Decisão do contato')).toHaveFocus());
  expect(io.rpc.mock.calls.some(([, name]) => name === 'record_whatsapp_message_consent')).toBe(false);
  fireEvent.change(screen.getByLabelText('Decisão do contato'), { target: { value: 'opt_in' } });
  fireEvent.change(screen.getByLabelText('Origem da evidência'), { target: { value: 'customer_message' } });
  fireEvent.change(screen.getByLabelText('Data e hora da escolha'), { target: { value: '2099-01-01T10:00' } });
  fireEvent.change(screen.getByLabelText('Referência da evidência'), { target: { value: '/preferencias/mensagens/invalid' } });
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Registrar escolha' }));
  await screen.findByText('Informe uma data válida, que não esteja no futuro.');
  expect(screen.getByText('Use uma referência curta, sem conversa ou link de preferência.')).toBeInTheDocument();
  expect(io.rpc.mock.calls.some(([, name]) => name === 'record_whatsapp_message_consent')).toBe(false);
});
it('a delayed consent read for A cannot populate the selected contact in B', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  io.rpc.mockImplementation(async (_jwt: string, name: string, args: Record<string, unknown>) => {
    if (name !== 'get_whatsapp_message_consent_state') return { data: null, error: { code: 'unexpected' } };
    if (args.p_unit_id === unitId) { await held; return { data: { purpose: args.p_purpose, status: 'opt_in', revision: 1 }, error: null }; }
    return { data: { purpose: args.p_purpose, status: 'unknown', revision: null }, error: null };
  });
  mount(Giftback); await screen.findByText('Consentimento individual');
  fireEvent.change(screen.getByLabelText('Telefone do contato com DDD'), { target: { value: '55 99999-8888' } }); fireEvent.click(screen.getByRole('button', { name: 'Buscar contato' }));
  fireEvent.click(await screen.findByRole('button', { name: /Selecionar Contato sintético/ })); await screen.findByText('Consultando escolha atual…');
  fireEvent.click(screen.getByRole('button', { name: 'Trocar para unidade B' })); await screen.findByText('Consentimento individual'); await selectContact();
  await act(async () => { release(); await held; });
  expect(screen.getByText(/nenhuma escolha registrada/)).toBeInTheDocument(); expect(screen.queryByText(/Escolha atual: autorizou/)).not.toBeInTheDocument();
});

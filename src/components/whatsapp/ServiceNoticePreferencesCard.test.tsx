// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_KINDS } from '@/features/whatsapp/service-preferences';
import { dispatchV2Variants } from '@/features/whatsapp/template-dispatch-versions';
import { ServiceNoticePreferencesCard } from './ServiceNoticePreferencesCard';

const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000001';
const bindingId = '30000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  service: { query: {}, setPreference: { isPending: false, mutateAsync: vi.fn(), reset: vi.fn() },
    syncModels: { isPending: false, mutateAsync: vi.fn() }, wasAttempted: vi.fn(() => false) },
  catalog: {},
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'actor-1' }, loading: false }) }));
vi.mock('@/hooks/useWhatsappServicePreferences', () => ({
  useWhatsappServicePreferences: () => mocks.service,
  servicePreferenceErrorMessage: () => 'Não foi possível conferir os avisos.',
}));
vi.mock('@/hooks/useWhatsappOnboardingCatalog', () => ({ useWhatsappOnboardingCatalog: () => mocks.catalog }));

function snapshot() {
  return {
    auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: true,
    admin_paused: false, can_manage: true, unit_id: unitId,
    channel_id: channelId, binding_id: bindingId, binding_generation: 3, credential_revision: 7,
    provider_subscription_confirmed: true,
    kinds: SERVICE_KINDS.map(kind => ({
      kind, enabled: false, revision: 0, enabled_at: null, ready: true, reason_code: 'ready',
      variants: dispatchV2Variants[kind].map(logical_id => ({ logical_id, status: 'APPROVED', ready: true })),
    })),
  };
}
function catalog() {
  return {
    channelId, bindingGeneration: 3, credentialRevision: 7,
    templates: SERVICE_KINDS.flatMap(kind => dispatchV2Variants[kind].map(logicalId => ({
      logicalId, version: 2, body: `Texto oficial ${logicalId}`, footer: null,
    }))),
  };
}
function show(canManage = true) {
  return render(<ServiceNoticePreferencesCard unitId={unitId} unitName="Restaurante Exemplo" canManage={canManage} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.service.query = { data: snapshot(), isPending: false, isError: false, isFetching: false, refetch: vi.fn() };
  mocks.service.setPreference = { isPending: false, mutateAsync: vi.fn().mockResolvedValue({}), reset: vi.fn() };
  mocks.service.syncModels = { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ status: 'requested' }) };
  mocks.service.wasAttempted = vi.fn(() => false);
  mocks.catalog = { data: catalog(), isError: false, isFetching: false, refetch: vi.fn() };
});
afterEach(cleanup);

describe('avisos de serviço v2 da loja', () => {
  it('does not offer self-service controls to an existing manual cohort', () => {
    mocks.service.query = { ...mocks.service.query, data: { ...snapshot(), auto_cohort: false, eligible: false } };
    show();
    expect(screen.queryByText('Modelos e avisos')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('starts all six services off, shows exact v2 text and keeps marketing separate', () => {
    show();
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    for (const control of screen.getAllByRole('switch')) expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getAllByText('Ver textos oficiais')[0]);
    expect(screen.getByText('Texto oficial res_confirmacao_v2')).toBeInTheDocument();
    expect(screen.getByText('Texto oficial res_confirmacao_desconto_v2')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Marketing' })).queryByRole('switch')).toBeNull();
  });

  it('shows pending auto cohort read-only before the enrollment becomes eligible', () => {
    mocks.service.query = { ...mocks.service.query, data: { ...snapshot(), eligible: false } };
    show();
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText(/preparando os modelos v2/)).toBeInTheDocument();
  });

  it('pins unit, channel, generation and revision before one opt-in, without optimistic enable', async () => {
    show();
    const control = screen.getByRole('switch', { name: 'Habilitar Confirmação de reserva' });
    fireEvent.click(control);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Restaurante Exemplo');
    expect(dialog).toHaveTextContent(channelId.slice(0, 8));
    expect(dialog).toHaveTextContent('geração 3');
    expect(dialog).toHaveTextContent('Valor da assinatura não disponível nesta tela');
    expect(dialog).toHaveTextContent('A Meta pode cobrar por mensagem de serviço entregue');
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar habilitação' }));
    await waitFor(() => expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledWith({
      unitId, channelId, bindingId, generation: 3, credentialRevision: 7,
      kind: 'confirmation', enabled: false, revision: 0, nextEnabled: true,
    });
  });

  it('accepts a rapid double confirmation only once while the mutation is in flight', async () => {
    let release!: () => void;
    mocks.service.setPreference.mutateAsync = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    show();
    fireEvent.click(screen.getByRole('switch', { name: 'Habilitar Confirmação de reserva' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar habilitação' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByText(/habilitado para novos fatos elegíveis/)).toBeInTheDocument());
  });

  it('does not arm a pending Meta model and lets a manager turn an enabled service off', () => {
    const current = snapshot();
    current.kinds[0].ready = false;
    current.kinds[0].reason_code = 'meta_pending';
    current.kinds[0].variants[0].status = 'PENDING';
    current.kinds[1].enabled = true;
    current.kinds[1].revision = 2;
    mocks.service.query = { ...mocks.service.query, data: current };
    show();
    expect(screen.getByRole('switch', { name: 'Habilitar Confirmação de reserva' })).toBeDisabled();
    expect(screen.getByText('Aguardando aprovação da Meta')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Desligar Lembrete de reserva' })).toBeEnabled();
  });

  it('allows stopping an enabled service while catalog, grant and rollout are unavailable', async () => {
    const current = snapshot();
    current.eligible = false;
    current.rollout_ready = false;
    current.kinds[0].enabled = true;
    current.kinds[0].revision = 4;
    Object.assign(current.kinds[0], { enabled_at: '2026-10-21T18:00:00Z' });
    current.kinds[0].ready = false;
    current.kinds[0].reason_code = 'grant_unavailable';
    mocks.service.query = { ...mocks.service.query, data: current };
    mocks.catalog = { data: undefined, isError: true, isFetching: false, refetch: vi.fn() };
    show();
    const stop = screen.getByRole('switch', { name: 'Desligar Confirmação de reserva' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar desativação' }));
    await waitFor(() => expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledWith({
      unitId, channelId, bindingId, generation: 3, credentialRevision: 7,
      kind: 'confirmation', enabled: true, revision: 4, nextEnabled: false,
    }));
  });

  it('keeps stop available while the catalog is refreshing', () => {
    const current = snapshot();
    current.kinds[0].enabled = true;
    current.kinds[0].revision = 2;
    mocks.service.query = { ...mocks.service.query, data: current };
    mocks.catalog = { ...mocks.catalog, isFetching: true };
    show();
    expect(screen.getByRole('switch', { name: 'Desligar Confirmação de reserva' })).toBeEnabled();
  });

  it('shows an administrative pause and allows stop without allowing another enable', async () => {
    const current = snapshot();
    current.admin_paused = true;
    current.kinds[0].enabled = true;
    current.kinds[0].revision = 5;
    Object.assign(current.kinds[0], { enabled_at: '2026-10-21T18:00:00Z' });
    mocks.service.query = { ...mocks.service.query, data: current };
    show();
    expect(screen.queryByText('Ativo para novos avisos')).toBeNull();
    expect(screen.getByText('Pausado pela plataforma')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Desligar Confirmação de reserva' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Habilitar Lembrete de reserva' })).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Desligar Confirmação de reserva' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar desativação' }));
    await waitFor(() => expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'confirmation', enabled: true, revision: 5, nextEnabled: false,
    })));
  });

  it('shows global dispatch pause, blocks enable and still permits CAS stop', async () => {
    const current = snapshot();
    current.global_dispatch_enabled = false;
    current.kinds[0].enabled = true;
    current.kinds[0].revision = 6;
    Object.assign(current.kinds[0], { enabled_at: '2026-10-21T18:00:00Z' });
    mocks.service.query = { ...mocks.service.query, data: current };
    show();
    expect(screen.queryByText('Ativo para novos avisos')).toBeNull();
    expect(screen.getByText('Envio pausado pela plataforma')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Habilitar Lembrete de reserva' })).toBeDisabled();
    const stop = screen.getByRole('switch', { name: 'Desligar Confirmação de reserva' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar desativação' }));
    await waitFor(() => expect(mocks.service.setPreference.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'confirmation', enabled: true, revision: 6, nextEnabled: false,
    })));
  });

  it('keeps the service read only for insufficient role or server permission', () => {
    show(false);
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true);
    cleanup();
    mocks.service.query = { ...mocks.service.query, data: { ...snapshot(), can_manage: false } };
    show(true);
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true);
  });

  it('refreshes only the allowed snapshot in the operator read-only view', () => {
    const queryRefresh = vi.fn();
    const catalogRefresh = vi.fn();
    mocks.service.query = { ...mocks.service.query, refetch: queryRefresh };
    mocks.catalog = { ...mocks.catalog, refetch: catalogRefresh };
    show(false);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar avisos' }));
    expect(queryRefresh).toHaveBeenCalledTimes(1);
    expect(catalogRefresh).not.toHaveBeenCalled();
  });

  it('closes the confirmation if the channel or preference changes before submit', () => {
    const view = show();
    fireEvent.click(screen.getByRole('switch', { name: 'Habilitar Confirmação de reserva' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    mocks.service.query = { ...mocks.service.query, data: { ...snapshot(), binding_generation: 4 } };
    view.rerender(<ServiceNoticePreferencesCard unitId={unitId} unitName="Restaurante Exemplo" canManage />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.service.setPreference.mutateAsync).not.toHaveBeenCalled();
  });

  it('requests one model refresh without arming a service or sending a message', async () => {
    const current = snapshot();
    current.kinds[0].ready = false;
    current.kinds[0].reason_code = 'sync_stale';
    mocks.service.query = { ...mocks.service.query, data: current };
    show();
    expect(screen.getByRole('switch', { name: 'Habilitar Confirmação de reserva' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar modelos na Meta' }));
    await waitFor(() => expect(mocks.service.syncModels.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.service.setPreference.mutateAsync).not.toHaveBeenCalled();
    expect(await screen.findByText(/conferência dos modelos pode levar alguns minutos/)).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Ajustes from './Ajustes';

const mocks = vi.hoisted(() => ({
  service: { query: {} }, upsert: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('@/hooks/useCurrentUnit', () => ({ useCurrentUnit: () => ({
  unit_id: '10000000-0000-4000-8000-000000000001', unit_slug: 'restaurante', role: 'owner', isGerente: true,
}) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'actor-1' } }) }));
vi.mock('@/hooks/useWhatsappServicePreferences', () => ({ useWhatsappServicePreferences: () => mocks.service }));
vi.mock('@/lib/supabase', () => {
  const chain = { select: () => chain, eq: () => chain, in: () => Promise.resolve({ data: [], error: null }),
    upsert: (...args: unknown[]) => mocks.upsert(...args) };
  return { supabase: { from: () => chain } };
});

let client: QueryClient;
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={client}><Ajustes /></QueryClientProvider></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.service.query = { isPending: false, isError: false, data: {
  auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: true, admin_paused: false,
  provider_subscription_confirmed: true, kinds: [
    { kind: 'reminder_d1', enabled: false, ready: true, reason_code: 'ready' },
    { kind: 'survey_d1', enabled: false, ready: true, reason_code: 'ready' },
  ],
} }; });
afterEach(() => { cleanup(); client?.clear(); });

it('shows authoritative auto-v2 states and omits legacy setting writes', async () => {
  show();
  expect(await screen.findByText(/Lembrete de reserva: Pronto para ativar/)).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: /Lembrete na véspera/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'WhatsApp → Modelos e avisos' })).toHaveAttribute('href', '/g/restaurante/whatsapp');
  await waitFor(() => expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(60));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
  const rows = mocks.upsert.mock.calls[0][0] as { key: string }[];
  expect(rows.some(row => row.key === 'reminder_d1_enabled' || row.key === 'survey_d1_enabled')).toBe(false);
});

it('shows platform pause instead of active delivery for enabled notices and keeps legacy controls hidden', async () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: true, admin_paused: true,
    provider_subscription_confirmed: true, kinds: [
      { kind: 'reminder_d1', enabled: true, ready: true, reason_code: 'ready' },
      { kind: 'survey_d1', enabled: true, ready: true, reason_code: 'ready' },
    ],
  } };
  show();
  expect(await screen.findByText(/Lembrete de reserva: Pausado pela plataforma/)).toBeInTheDocument();
  expect(screen.getByText(/Pesquisa da reserva: Pausado pela plataforma/)).toBeInTheDocument();
  expect(screen.queryByText(/Ativo para novos avisos/)).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('shows the global dispatch pause instead of an active state', async () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: false,
    admin_paused: false, provider_subscription_confirmed: true,
    kinds: [
      { kind: 'reminder_d1', enabled: true, ready: true, reason_code: 'ready' },
      { kind: 'survey_d1', enabled: false, ready: true, reason_code: 'ready' },
    ],
  } };
  show();
  expect(await screen.findByText(/Lembrete de reserva: Envio pausado pela plataforma/)).toBeInTheDocument();
  expect(screen.queryByText(/Ativo para novos avisos/)).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('preserves legacy switches and writes for a manual cohort', async () => {
  mocks.service.query = { isPending: false, isError: false, data: { auto_cohort: false, eligible: false } };
  show();
  expect(await screen.findByRole('switch', { name: /Lembrete na véspera/ })).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: /Pesquisa de satisfação/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(60));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
  const rows = mocks.upsert.mock.calls[0][0] as { key: string }[];
  expect(rows.map(row => row.key)).toContain('reminder_d1_enabled');
  expect(rows.map(row => row.key)).toContain('survey_d1_enabled');
});

it('hides legacy switches before auto-v2 enrollment becomes eligible', async () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: false, rollout_ready: true, global_dispatch_enabled: true,
    kinds: [
      { kind: 'reminder_d1', enabled: false, ready: false, reason_code: 'sync_stale' },
      { kind: 'survey_d1', enabled: false, ready: false, reason_code: 'sync_stale' },
    ],
  } };
  show();
  expect(await screen.findByText(/Lembrete de reserva: Aguardando preparação dos modelos/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
  await waitFor(() => expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(60));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(1));
  const rows = mocks.upsert.mock.calls[0][0] as { key: string }[];
  expect(rows.some(row => row.key === 'reminder_d1_enabled' || row.key === 'survey_d1_enabled')).toBe(false);
});

it('hides legacy automation switches when the new authority cannot be read', async () => {
  mocks.service.query = { isPending: false, isError: true, data: undefined };
  show();
  expect(await screen.findByText(/controles antigos estão indisponíveis/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
});

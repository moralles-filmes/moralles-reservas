// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FilaComunicacao from './Comunicacao';

const mocks = vi.hoisted(() => ({ service: { query: {} }, update: vi.fn() }));
vi.mock('@/hooks/useCurrentUnit', () => ({ useCurrentUnit: () => ({
  unit_id: '10000000-0000-4000-8000-000000000001', unit_slug: 'restaurante', role: 'owner', isGerente: true,
}) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'actor-1' }, isPlatformAdmin: false }) }));
vi.mock('@/hooks/useWhatsappServicePreferences', () => ({ useWhatsappServicePreferences: () => mocks.service }));
vi.mock('@/hooks/useWhatsappTemplates', () => ({ useWhatsappTemplates: () => ({
  query: { data: { mode: 'official' }, isError: false, isFetching: false }, canManage: true,
}) }));
vi.mock('@/components/whatsapp/OfficialAutomationTemplate', () => ({ TemplateStatus: () => null }));
vi.mock('@/hooks/useWaitlistTemplates', () => ({
  useWaitlistTemplates: () => ({ data: [], isLoading: false, isError: false }),
  useUpsertWaitlistTemplate: () => ({ isPending: false, mutate: vi.fn() }),
  WAITLIST_TEMPLATES: [{ event: 'entered', label: 'Entrada' }], WAITLIST_VARIABLES: [],
  getWaitlistTemplateMeta: () => ({ defaultBody: '', maxLength: 500, variables: [], description: '' }),
  renderWaitlistTemplate: () => '',
}));
vi.mock('@/hooks/useWaitlistSettings', () => ({
  useWaitlistSettings: () => ({ data: { waitlist_entered_enabled: true, waitlist_feedback_enabled: true }, isLoading: false, isError: false }),
  useUpdateWaitlistSettings: () => ({ isPending: false, mutate: mocks.update }),
}));

function show() {
  return render(<MemoryRouter initialEntries={['/g/restaurante/fila/comunicacao']}><Routes>
    <Route path="/g/:unitSlug/fila/comunicacao" element={<FilaComunicacao />} />
  </Routes></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.service.query = { isPending: false, isError: false, data: {
  auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: true, admin_paused: false,
  provider_subscription_confirmed: true,
  kinds: [{ kind: 'waitlist_entered', enabled: false, ready: true, reason_code: 'ready' }],
} }; });
afterEach(cleanup);

it('shows effective auto-v2 waitlist status without the old ON switches', () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getByText(/Entrada na fila: Pronto para ativar/)).toBeInTheDocument();
  expect(screen.getByText(/Pesquisa da fila: MARKETING separado/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByRole('link', { name: 'WhatsApp → Modelos e avisos' })).toHaveAttribute('href', '/g/restaurante/whatsapp');
});

it('shows platform pause for an enabled waitlist notice and keeps legacy controls hidden', () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: true, admin_paused: true,
    provider_subscription_confirmed: true,
    kinds: [{ kind: 'waitlist_entered', enabled: true, ready: true, reason_code: 'ready' }],
  } };
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getByText(/Entrada na fila: Pausado pela plataforma/)).toBeInTheDocument();
  expect(screen.queryByText(/Ativo para novos avisos/)).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('shows the global dispatch pause instead of an active waitlist state', () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: true, rollout_ready: true, global_dispatch_enabled: false,
    admin_paused: false, provider_subscription_confirmed: true,
    kinds: [{ kind: 'waitlist_entered', enabled: true, ready: true, reason_code: 'ready' }],
  } };
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getByText(/Entrada na fila: Envio pausado pela plataforma/)).toBeInTheDocument();
  expect(screen.queryByText(/Ativo para novos avisos/)).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('keeps the old waitlist switches for manual cohorts', () => {
  mocks.service.query = { isPending: false, isError: false, data: { auto_cohort: false, eligible: false } };
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getAllByRole('switch')).toHaveLength(2);
});

it('keeps legacy waitlist controls hidden while auto-v2 enrollment is pending', () => {
  mocks.service.query = { isPending: false, isError: false, data: {
    auto_cohort: true, eligible: false, rollout_ready: true, global_dispatch_enabled: true,
    kinds: [{ kind: 'waitlist_entered', enabled: false, ready: false, reason_code: 'sync_stale' }],
  } };
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getByText(/Entrada na fila: Aguardando preparação dos modelos/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('fails closed when the service authority is unavailable', () => {
  mocks.service.query = { isPending: false, isError: true, data: undefined };
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  expect(screen.getByText(/controles antigos estão indisponíveis/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).toBeNull();
});

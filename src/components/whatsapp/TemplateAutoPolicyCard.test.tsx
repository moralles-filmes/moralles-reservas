// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { TemplateAutoPolicyCard } from './TemplateAutoPolicyCard';

const io = vi.hoisted(() => ({ invoke: vi.fn(), revision: 3, enabled: false }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const digest = 'a'.repeat(64);
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TemplateAutoPolicyCard /></QueryClientProvider>), client };
}
beforeEach(() => {
  io.revision = 3;
  io.enabled = false;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string; enabled?: boolean } }) => {
    if (body.action === 'set_auto_policy') { io.enabled = body.enabled === true; io.revision += 1; }
    return { data: { enabled: io.enabled, revision: io.revision, catalogDigest: digest, updatedAt: '2026-10-17T19:00:00Z' }, error: null };
  });
});

it('requires a global-scope confirmation and pins the revision without touching dispatch', async () => {
  mount();
  expect(await screen.findByText(/Política desativada · revisão 3/)).toBeInTheDocument();
  expect(screen.getByText(/Catálogo versão 1/)).toBeInTheDocument();
  expect(screen.getByText(digest)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Ativar para futuras conexões' }));
  expect(screen.getByRole('dialog').textContent).toContain('todas as organizações');
  expect(screen.getByRole('dialog').textContent).toContain('Canais e onboardings antigos não serão inscritos');
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'set_auto_policy')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'set_auto_policy', enabled: true, expected_revision: 3 } }));
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'set_auto_policy')).toHaveLength(1);
  expect(io.invoke.mock.calls.some(([, options]) => 'scope' in options.body || 'dispatch' in options.body)).toBe(false);
  expect(await screen.findByText(/Política ativada · revisão 4/)).toBeInTheDocument();
});

it('revokes only after confirmation and discloses a confirmed in-flight submission', async () => {
  io.enabled = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar política global' }));
  expect(screen.getByRole('dialog').textContent).toContain('submissão já confirmada pode chegar à Meta');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'set_auto_policy', enabled: false, expected_revision: 3 } }));
});

it('cancels an open dialog when a fresh server revision changes', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Ativar para futuras conexões' }));
  io.revision = 4;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-template-auto-policy'], exact: true }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('A política mudou');
  expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => options.body.action === 'auto_policy_snapshot')).toBe(true);
});

it('fails closed on malformed policy data', async () => {
  io.invoke.mockResolvedValue({ data: { enabled: true, revision: 3, catalogDigest: 'bad', updatedAt: null }, error: null });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar a política');
  expect(screen.queryByRole('button', { name: /futuras conexões|Revogar política global/ })).not.toBeInTheDocument();
});

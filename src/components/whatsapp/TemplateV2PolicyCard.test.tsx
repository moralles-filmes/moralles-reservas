// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { TemplateV2PolicyCard } from './TemplateV2PolicyCard';

const io = vi.hoisted(() => ({ invoke: vi.fn(), revision: 0, enabled: false }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: io.invoke } } }));
const digest = 'b'.repeat(64);
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TemplateV2PolicyCard /></QueryClientProvider>), client };
}
beforeEach(() => {
  io.revision = 0; io.enabled = false; io.invoke.mockReset();
  io.invoke.mockImplementation(async (_name: string, { body }: { body: { action: string; enabled?: boolean } }) => {
    if (body.action === 'set_v2_policy') { io.enabled = body.enabled === true; io.revision += 1; }
    return { data: { version: 2, enabled: io.enabled, revision: io.revision, catalogDigest: digest, updatedAt: null }, error: null };
  });
});

it('pins the v2 policy revision and requires a future-only global confirmation once', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Ativar v2 para futuras conexões' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('todas as organizações');
  expect(screen.getByRole('dialog')).toHaveTextContent('Canais e contas existentes não serão promovidos automaticamente');
  expect(screen.getByRole('dialog')).toHaveTextContent(digest);
  expect(io.invoke.mock.calls.every(([, options]) => options.body.action === 'v2_policy_snapshot')).toBe(true);
  const confirm = screen.getByRole('button', { name: 'Confirmar política v2' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'set_v2_policy', enabled: true, expected_revision: 0 } }));
  expect(io.invoke.mock.calls.filter(([, options]) => options.body.action === 'set_v2_policy')).toHaveLength(1);
  expect(io.invoke.mock.calls.some(([, options]) => ['release_channel', 'select_v2_channel'].includes(options.body.action))).toBe(false);
});

it('revokes future policy without claiming that manual grants stop', async () => {
  io.enabled = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar política futura v2' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Liberações manuais por conta são independentes');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar política v2' }));
  await waitFor(() => expect(io.invoke).toHaveBeenCalledWith('manage-whatsapp-templates', { body: { action: 'set_v2_policy', enabled: false, expected_revision: 0 } }));
});

it('cancels confirmation when revision changes while keeping the captured digest visible', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Ativar v2 para futuras conexões' }));
  io.revision += 1;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['whatsapp-template-v2-policy'], exact: true }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('A política v2 mudou');
  expect(screen.queryByRole('button', { name: 'Confirmar política v2' })).not.toBeInTheDocument();
  expect(io.invoke.mock.calls.every(([, options]) => options.body.action === 'v2_policy_snapshot')).toBe(true);
});

it.each([{ version: 1 }, { catalogDigest: 'invalid' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { token: 'not-allowed' }])('fails closed for malformed v2 policy %j', async fault => {
  io.invoke.mockResolvedValue({ data: { version: 2, enabled: false, revision: 0, catalogDigest: digest, updatedAt: null, ...fault }, error: null });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar o serviço');
  expect(screen.queryByRole('button', { name: /Ativar v2|Revogar política futura/ })).not.toBeInTheDocument();
});

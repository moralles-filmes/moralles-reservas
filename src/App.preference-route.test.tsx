import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import App from './App';

const io = vi.hoisted(() => ({ auth: vi.fn(), signOut: vi.fn(), members: false, admin: false, user: false, role: 'owner' as 'owner' | 'operador' }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { onAuthStateChange: io.auth, signOut: io.signOut },
    from: (table: string) => { const data = table === 'platform_admins' ? (io.admin ? { user_id: 'user' } : null) : io.members ? [{ unit_id: 'unit', role: io.role, unit: { slug: 'unidade-a', name: 'Unidade A', organization_id: 'org', organization: { slug: 'org' } } }] : []; const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }), then: (fn: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(fn) }; return chain; },
    channel: () => { const chain = { on: () => chain, subscribe: () => chain }; return chain; }, removeChannel: vi.fn(),
  }
}));
vi.mock('@/components/layouts/GestaoLayout', () => ({ GestaoLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/layouts/OperacionalLayout', () => ({ OperacionalLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/layouts/PlatformLayout', () => ({ PlatformLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/BillingGuard', () => ({ BillingGuard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));
vi.mock('./pages/Index', () => ({ default: () => <h1>Início</h1> }));
vi.mock('./pages/Auth', () => ({ default: () => <h1>Login privado</h1> }));
vi.mock('./pages/gestao/Dashboard', () => ({ default: () => <h1>Painel privado</h1> }));
vi.mock('./pages/gestao/Whatsapp', () => ({ default: () => <h1>Consulta de avisos WhatsApp</h1> }));
vi.mock('./pages/platform/Empresas', () => ({ default: () => <h1>Plataforma privada</h1> }));
beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() });
  io.user = false; io.members = false; io.admin = false; io.role = 'owner';
  io.signOut.mockReset().mockResolvedValue({});
  io.auth.mockReset().mockImplementation((callback: (event: string, session: unknown) => void) => { callback('INITIAL_SESSION', io.user ? { user: { id: 'user' } } : null); return { data: { subscription: { unsubscribe: vi.fn() } } }; });
});
function go(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }
it.each(['anonymous', 'member', 'admin', 'orphan'])('exact public route does not mount AuthProvider for %s', async role => {
  io.user = role !== 'anonymous'; io.members = role === 'member'; io.admin = role === 'admin';
  go('/preferencias/mensagens/invalid'); render(<App />);
  await screen.findByText('Preferências de mensagens', {}, { timeout: 5000 }); expect(screen.getByText('Link inválido ou expirado')).toBeInTheDocument(); expect(io.auth).not.toHaveBeenCalled(); expect(io.signOut).not.toHaveBeenCalled();
});
it('private orphan still signs out and navigates to login', async () => {
  io.user = true; go('/admin'); render(<App />);
  await screen.findByText('Login privado'); expect(io.signOut).toHaveBeenCalledOnce();
});
it('lets an operator reach the WhatsApp notices route through OperacionalGuard', async () => {
  io.user = true; io.members = true; io.role = 'operador';
  go('/o/unidade-a/whatsapp'); render(<App />);
  await screen.findByText('Consulta de avisos WhatsApp');
  expect(io.signOut).not.toHaveBeenCalled();
});
it('changing another private pathname does not suppress a mounted Provider logout', async () => {
  io.user = true; let finish!: () => void; io.signOut.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  go('/admin'); render(<App />); await waitFor(() => expect(io.signOut).toHaveBeenCalledOnce());
  await act(async () => go('/')); await screen.findByText('Início');
  await act(async () => finish()); await screen.findByText('Login privado');
});
it('pending orphan logout cannot navigate after its provider unmounts; returning private mounts again', async () => {
  io.user = true; let finish!: () => void; io.signOut.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  go('/admin'); render(<StrictMode><App /></StrictMode>);
  await waitFor(() => expect(io.signOut).toHaveBeenCalledOnce());
  await act(async () => go('/preferencias/mensagens/invalid'));
  await screen.findByText('Preferências de mensagens');
  await act(async () => finish()); expect(screen.getByText('Preferências de mensagens')).toBeInTheDocument();
  io.user = false; await act(async () => go('/g/unidade-a'));
  await screen.findByText('Login privado'); expect(io.auth.mock.calls.length).toBeGreaterThan(1);
});
it.each(['member', 'admin', 'anonymous'])('private guards still handle %s after leaving the public page', async role => {
  io.user = role !== 'anonymous'; io.members = role === 'member'; io.admin = role === 'admin';
  go('/preferencias/mensagens/invalid'); render(<App />); await screen.findByText('Link inválido ou expirado');
  await act(async () => go(role === 'admin' ? '/platform' : '/g/unidade-a'));
  await screen.findByText(role === 'anonymous' ? 'Login privado' : role === 'admin' ? 'Plataforma privada' : 'Painel privado');
  expect(io.auth).toHaveBeenCalled(); expect(io.signOut).not.toHaveBeenCalled();
});
it('a fresh Provider instance still redirects its own orphan logout after unmount/remount', async () => {
  io.user = true; let finishFirst!: () => void; let finishSecond!: () => void;
  io.signOut.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; })).mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve; }));
  go('/admin'); render(<App />); await waitFor(() => expect(io.signOut).toHaveBeenCalledTimes(1));
  await act(async () => go('/preferencias/mensagens/invalid')); await screen.findByText('Link inválido ou expirado');
  await act(async () => go('/admin')); await waitFor(() => expect(io.signOut).toHaveBeenCalledTimes(2));
  await act(async () => finishFirst()); expect(screen.queryByText('Login privado')).not.toBeInTheDocument();
  await act(async () => finishSecond()); await screen.findByText('Login privado');
});
it('initial no-referrer precedes all subresources and hosting headers preserve assets/rewrite', () => {
  const html = readFileSync('index.html', 'utf8');
  const meta = html.indexOf('<meta name="referrer" content="no-referrer"');
  expect(meta).toBeGreaterThan(0); expect(meta).toBeLessThan(html.indexOf('<script')); expect(meta).toBeLessThan(html.indexOf('<link'));
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  expect(config.headers.find((h: { source: string }) => h.source === '/preferencias/mensagens/(.*)').headers).toEqual([{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'no-store' }]);
  expect(config.headers.find((h: { source: string }) => h.source === '/assets/(.*)')).toBeTruthy();
});
it.each(['/preferencias/mensagens/invalid/extra', '/preferencias/mensagens-extra/invalid'])('does not exempt similar path %s', async path => {
  go(path); render(<App />); await screen.findByText('Início'); expect(io.auth).toHaveBeenCalled();
});

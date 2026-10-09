import { webcrypto } from 'node:crypto';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createPreferencesHandler } from '../../../supabase/functions/_shared/whatsapp-message-preferences-handler';
import { createPreferenceToken } from '../../../supabase/functions/_shared/whatsapp-message-preferences-core';
import PreferenciasMensagens from './PreferenciasMensagens';

let tokens: string[];
let hashes: string[];
let lookups: number;
let writes: number;
let requests: Request[];
let client: QueryClient;
let handler: ReturnType<typeof createPreferencesHandler>;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://preferences.test');
  const capabilities = await Promise.all([createPreferenceToken(), createPreferenceToken()]);
  tokens = capabilities.map(c => c.token);
  hashes = capabilities.map(c => c.hash);
  lookups = 0; writes = 0; requests = [];
  handler = createPreferencesHandler({
    allowedOrigins: ['http://localhost:3000'],
    lookup: async hash => { lookups++; const index = capabilities.findIndex(c => c.hash === hash); return index < 0 ? null : { valid: true, unitLabel: `Unidade ${index + 1}`, choice: 'opt_in' }; },
    optOut: async () => { writes++; return true; }, rateGate: async () => true
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // jsdom AbortSignal is a different realm from Node's Request. The mocked
    // transport deliberately permits late completions to exercise isolation.
    const { signal: _signal, ...requestInit } = init ?? {};
    const req = new Request(input, requestInit); requests.push(req.clone());
    const headers = new Headers(req.headers); headers.set('origin', 'http://localhost:3000');
    return handler(new Request(req, { headers }));
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function Navigation() {
  const navigate = useNavigate();
  return <>{tokens.map((token, index) => <button key={index} onClick={() => navigate(`/preferencias/mensagens/${token}`)}>Abrir unidade {index + 1}</button>)}</>;
}
function mount(strict = false) {
  const app = <QueryClientProvider client={client}><MemoryRouter initialEntries={[`/preferencias/mensagens/${tokens[0]}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Navigation /><Routes><Route path="/preferencias/mensagens/:token" element={<PreferenciasMensagens />} /></Routes></MemoryRouter></QueryClientProvider>;
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}
it('loads a valid lifecycle under StrictMode without losing its active observer', async () => {
  mount(true);
  await screen.findByText('Unidade 1');
  expect(writes).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir unidade 2' }));
  await screen.findByText('Unidade 2');
  expect(screen.queryByText('Unidade 1')).not.toBeInTheDocument();
});
it('GET uses a fixed endpoint and header; only explicit confirmation performs the exact POST', async () => {
  const control = await handler(new Request('https://preferences.test/functions/v1/whatsapp-message-preferences', { headers: { 'x-preference-token': tokens[0] } }));
  expect(control.status).toBe(200); lookups = 0;
  mount(); await waitFor(() => expect(requests).toHaveLength(1)); await screen.findByText('Unidade 1');
  expect(lookups).toBe(1); expect(writes).toBe(0);
  expect(requests[0].url).toBe('https://preferences.test/functions/v1/whatsapp-message-preferences');
  expect(requests[0].cache).toBe('no-store'); expect(requests[0].referrerPolicy).toBe('no-referrer');
  expect(requests[0].headers.get('x-preference-token') === tokens[0]).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Não receber ofertas desta unidade' }));
  expect(writes).toBe(0);
  expect(screen.getByRole('button', { name: 'Confirmar recusa de ofertas' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar recusa de ofertas' }));
  await screen.findByText(/Sua preferência foi registrada/);
  expect(writes).toBe(1);
  const post = requests.find(r => r.method === 'POST')!;
  const body = await post.json();
  expect(Object.keys(body).sort()).toEqual(['action', 'token']);
  expect(body.action).toBe('opt_out'); expect(body.token === tokens[0]).toBe(true);
  const cache = JSON.stringify([client.getQueryCache().getAll().map(q => [q.queryKey, q.state]), client.getMutationCache().getAll().map(m => m.state)]);
  expect([...tokens, ...hashes].some(t => cache.includes(t))).toBe(false);
  expect([...tokens, ...hashes].some(t => JSON.stringify(localStorage).includes(t) || JSON.stringify(sessionStorage).includes(t))).toBe(false);
});
it('a late POST for A neither mutates B nor changes its displayed preference', async () => {
  const original = handler; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  handler = async request => { if (request.method === 'POST') await held; return original(request); };
  mount(); await screen.findByText('Unidade 1');
  fireEvent.click(screen.getByRole('button', { name: 'Não receber ofertas desta unidade' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar recusa de ofertas' }));
  await waitFor(() => expect(requests.filter(r => r.method === 'POST')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Abrir unidade 2' })); await screen.findByText('Unidade 2');
  await act(async () => { release(); await held; });
  await waitFor(() => expect(writes).toBe(1));
  expect(screen.queryByText(/Sua preferência foi registrada/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Não receber ofertas desta unidade' })).toBeInTheDocument();
  const body = await requests.find(r => r.method === 'POST')!.json(); expect(body.token === tokens[0]).toBe(true);
});
it('uniform invalid response and malformed DTO do not reveal remote details or trigger a write', async () => {
  handler = async () => new Response(JSON.stringify({ valid: true, unitLabel: 'Unidade', choice: 'opt_in', private: 'unexpected' }), { status: 200 });
  mount(); await screen.findByText(/Não foi possível consultar/); expect(screen.queryByText('unexpected')).not.toBeInTheDocument(); expect(writes).toBe(0);
});
it('rate limiting provides an explicit retry without automatic requests', async () => {
  handler = createPreferencesHandler({ allowedOrigins: ['http://localhost:3000'], lookup: async () => null, optOut: async () => false, rateGate: async () => false });
  mount(); await screen.findByText(/Muitas consultas/); expect(requests).toHaveLength(1); expect(writes).toBe(0);
});
it('isolates A-B-A lifecycles, clears confirmation, and removes the old cache', async () => {
  mount(); await screen.findByText('Unidade 1');
  const keyA = client.getQueryCache().getAll()[0].queryKey;
  fireEvent.click(screen.getByRole('button', { name: 'Não receber ofertas desta unidade' }));
  fireEvent.click(screen.getByRole('button', { name: 'Abrir unidade 2' }));
  expect(screen.queryByText('Unidade 1')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirmar recusa de ofertas' })).not.toBeInTheDocument();
  await screen.findByText('Unidade 2');
  fireEvent.click(screen.getByRole('button', { name: 'Abrir unidade 1' }));
  await screen.findByText('Unidade 1');
  await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(1));
  expect(JSON.stringify(client.getQueryCache().getAll()[0].queryKey) === JSON.stringify(keyA)).toBe(false);
  expect(writes).toBe(0);
});
it('distinguishes dependency failure from invalid link and retries only explicitly', async () => {
  handler = createPreferencesHandler({ allowedOrigins: ['http://localhost:3000'], lookup: async () => { throw new Error('private dependency'); }, optOut: async () => false, rateGate: async () => true });
  mount(); await screen.findByText(/Não foi possível consultar/);
  expect(screen.queryByText('Link inválido ou expirado')).not.toBeInTheDocument();
  handler = createPreferencesHandler({ allowedOrigins: ['http://localhost:3000'], lookup: async () => null, optOut: async () => false, rateGate: async () => true });
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
  await screen.findByText('Link inválido ou expirado'); expect(writes).toBe(0);
});
it('ignores a late GET from the previous lifecycle', async () => {
  const original = handler;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  handler = async request => { if (request.headers.get('x-preference-token') === tokens[0]) await held; return original(request); };
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Abrir unidade 2' }));
  await screen.findByText('Unidade 2');
  await act(async () => { release(); await held; });
  expect(screen.queryByText('Unidade 1')).not.toBeInTheDocument(); expect(writes).toBe(0);
});

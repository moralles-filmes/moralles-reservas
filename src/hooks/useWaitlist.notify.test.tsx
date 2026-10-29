// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useNotifyWaitlist } from './useWaitlist';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, warning: mocks.warning, info: mocks.info, error: mocks.error } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useNotifyWaitlist('unit-a'), { wrapper });
}

describe('useNotifyWaitlist', () => {
  it('sends only the resource id and legacy editable text to the server', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: true, sent: true, statusUpdated: true }, error: null });
    const hook = setup();
    await act(() => hook.result.current.mutateAsync({ id: 'entry-a', message: 'Texto da loja' }));
    expect(mocks.invoke).toHaveBeenCalledWith('notify-waitlist-ready',
      { body: { waitlist_id: 'entry-a', message: 'Texto da loja' } });
    expect(mocks.success).toHaveBeenCalled();
  });
  it('shows a persisted status failure separately from WhatsApp success', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: true, sent: true, statusUpdated: false }, error: null });
    const hook = setup();
    await act(() => hook.result.current.mutateAsync({ id: 'entry-a', message: 'Texto' }));
    expect(mocks.warning).toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
  it('does not claim immediate delivery for a queued managed job', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: false, sent: false, statusUpdated: true,
      automation: { state: 'queued' } }, error: null });
    const hook = setup();
    await act(() => hook.result.current.mutateAsync({ id: 'entry-a', message: 'Texto' }));
    expect(mocks.info).toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it('explains a disabled mesa pronta notice without treating it as an updated queue fact', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: false, sent: false, statusUpdated: false,
      error: 'service_not_enabled', skipped: 'service_not_enabled' }, error: null });
    const hook = setup();
    await expect(act(() => hook.result.current.mutateAsync({ id: 'entry-a', message: 'Texto' })))
      .rejects.toThrow('Aviso de mesa pronta desativado. Ative em WhatsApp → Modelos e avisos ou avise o cliente por outro meio.');
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Aviso de mesa pronta desativado. Ative em WhatsApp → Modelos e avisos ou avise o cliente por outro meio.'));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
  it('keeps the persisted status visible when dispatch returns a non-enqueued 409', async () => {
    mocks.invoke.mockResolvedValue({ data: null,
      error: new FunctionsHttpError({ json: async () => ({ statusUpdated: true,
        automation: { state: 'not_enqueued', reason: 'resource_refused' } }) }) });
    const hook = setup();
    await act(() => hook.result.current.mutateAsync({ id: 'entry-a', message: 'Texto' }));
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('estado da fila foi atualizado'));
    expect(mocks.success).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useResendWaitlistEntered } from './useWaitlist';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useResendWaitlistEntered('unit-a'), { wrapper });
}

describe('useResendWaitlistEntered', () => {
  it('calls the sole authenticated resend endpoint with resource id, never caller text or phone', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
    const hook = setup();
    await act(() => hook.result.current.mutateAsync({ id: 'entry-a', phone: '11999999999', message: 'caller text' }));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('resend-notification',
      { body: { kind: 'waitlist_entered', waitlist_id: 'entry-a', unit_id: 'unit-a' } });
    expect(mocks.success).toHaveBeenCalledWith('Aviso de entrada reenviado.');
  });
  it('requires explicit success before claiming a resend', async () => {
    mocks.invoke.mockResolvedValue({ data: { success: false, error: 'automation_resend_refused' }, error: null });
    const hook = setup();
    await expect(act(() => hook.result.current.mutateAsync({ id: 'entry-a', phone: '11', message: 'x' }))).rejects.toThrow();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});

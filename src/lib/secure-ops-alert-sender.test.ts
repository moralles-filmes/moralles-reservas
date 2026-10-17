import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecureOpsAlertSender, readSecureOpsAlertReadiness, secureOpsAlertEndpoint } from '../../supabase/functions/_shared/secure-ops-alert-sender';

const endpoint = 'https://project.supabase.co/functions/v1/whatsapp-ops-alert-email';
const config = { endpoint, projectUrl: 'https://project.supabase.co', token: 'A'.repeat(43) };
const payload = { event: 'datafy_subscription_failed' as const, unit_id: 'unit-id', channel_id: 'channel-id', generated_at: '2026-10-17T12:00:00Z' };

afterEach(() => vi.restoreAllMocks());

describe('secure operational alert sender', () => {
  it('accepts only the exact internal URL and a 32-byte encoded token', () => {
    expect(secureOpsAlertEndpoint(config)).toBe(endpoint);
    expect(secureOpsAlertEndpoint({ ...config, projectUrl: `${config.projectUrl}/` })).toBe(endpoint);
    for (const bad of [
      undefined, 'http://project.supabase.co/functions/v1/whatsapp-ops-alert-email',
      'https://project.supabase.co.evil.test/functions/v1/whatsapp-ops-alert-email',
      'https://other.supabase.co/functions/v1/whatsapp-ops-alert-email',
      'https://project.supabase.co/functions/v1/whatsapp-ops-alert-email/extra',
      `${endpoint}?x=1`, `${endpoint}#fragment`,
      'https://name:password@project.supabase.co/functions/v1/whatsapp-ops-alert-email',
    ]) expect(secureOpsAlertEndpoint({ ...config, endpoint: bad })).toBeNull();
    expect(secureOpsAlertEndpoint({ ...config, token: 'short' })).toBeNull();
    expect(secureOpsAlertEndpoint({ ...config, token: `${'A'.repeat(43)}\n` })).toBeNull();
    expect(secureOpsAlertEndpoint({ ...config, projectUrl: 'https://project.supabase.co/elsewhere' })).toBeNull();
  });

  it('never fetches an unconfigured destination and never leaks upstream errors', async () => {
    const fetcher = vi.fn();
    expect(await createSecureOpsAlertSender({ ...config, endpoint: `${endpoint}?x=1` }, fetcher)(payload))
      .toEqual({ delivered: false, reason: 'unconfigured' });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValue(new Error('secret-in-remote-error'));
    expect(await createSecureOpsAlertSender(config, fetcher)(payload))
      .toEqual({ delivered: false, reason: 'delivery_failed' });
  });

  it('posts the closed payload with token only in the header and rejects redirects', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"accepted":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    const sender = createSecureOpsAlertSender(config, fetcher);
    expect(await sender(payload)).toEqual({ delivered: true });
    expect(fetcher.mock.calls[0][0]).toBe(endpoint);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-ops-alert-key': config.token }, body: JSON.stringify(payload) });
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(await sender(payload)).toEqual({ delivered: false, reason: 'delivery_failed' });
  });

  it('requires a bounded explicit 200 JSON acknowledgement, including for replay', async () => {
    const responses = [
      new Response('{"accepted":true,"replay":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      new Response(null, { status: 204 }),
      new Response('{"accepted":true}', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      new Response('{"accepted":true}', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      new Response('{"accepted":false}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      new Response('{"ready":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      new Response('{"accepted":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '9999' } }),
      new Response('{"accepted":true,"padding":"' + 'x'.repeat(513) + '"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ];
    const fetcher = vi.fn().mockImplementation(async () => responses.shift());
    const sender = createSecureOpsAlertSender(config, fetcher);
    expect(await sender(payload)).toEqual({ delivered: true });
    for (let i = 0; i < 8; i++) expect(await sender(payload)).toEqual({ delivered: false, reason: 'delivery_failed' });
  });

  it('sets the 20-second transport budget and closes on timeout', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const result = createSecureOpsAlertSender(config, fetcher)(payload);
    expect(timeout).toHaveBeenCalledWith(20_000);
    controller.abort();
    expect(await result).toEqual({ delivered: false, reason: 'delivery_failed' });
  });

  it('requires an authenticated 200 ready=true for health', async () => {
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ready: true }), { status: 200, headers: jsonHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ready: true }), { status: 503, headers: jsonHeaders }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ready: false }), { status: 200, headers: jsonHeaders }))
      .mockResolvedValueOnce(new Response('not-json', { status: 200, headers: jsonHeaders }));
    expect(await readSecureOpsAlertReadiness(config, fetcher)).toEqual({ senderConfigured: true, receiverReady: true });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', headers: { 'x-ops-alert-key': config.token } });
    for (let i = 0; i < 3; i++) expect(await readSecureOpsAlertReadiness(config, fetcher))
      .toEqual({ senderConfigured: true, receiverReady: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

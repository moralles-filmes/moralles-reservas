import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { opsAlertEmailConfigHmac } from '../../supabase/functions/_shared/ops-alert-email-core';
import {
  createOpsAlertEmailHandler,
  type OpsEmailConfig,
  type OpsEmailDatabase,
} from '../../supabase/functions/whatsapp-ops-alert-email/handler';

vi.stubGlobal('crypto', webcrypto);

const TOKEN = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-17T18:00:00.000Z');
const ROOT = 'https://project.supabase.co/functions/v1/whatsapp-ops-alert-email';
const PAYLOAD = {
  event: 'datafy_subscription_failed',
  unit_id: '11111111-1111-4111-8111-111111111111',
  channel_id: '22222222-2222-4222-8222-222222222222',
  generated_at: '2026-10-17T17:55:00.000Z',
};

function db(): OpsEmailDatabase {
  return {
    reserve: vi.fn(async () => ({ data: { decision: 'reserved' as const, attempt_id: ATTEMPT }, error: null })),
    complete: vi.fn(async () => ({ data: true, error: null })),
    checkReservationReady: vi.fn(async () => ({ data: { ready: true, remaining: 50 }, error: null })),
  };
}

function config(approvedHmac: string | null = null): OpsEmailConfig {
  return {
    token: TOKEN, to: 'operator@example.test', from: 'Alerts <alerts@example.test>',
    resendKey: 'synthetic-resend-key', approvedHmac,
  };
}

async function approvedConfig() {
  const value = config();
  value.approvedHmac = await opsAlertEmailConfigHmac(TOKEN, value.from!, value.to!);
  return value;
}

function request(path = ROOT, method = 'POST', body: string | null = JSON.stringify(PAYLOAD), key: string | null = TOKEN) {
  return new Request(path, {
    method,
    headers: {
      ...(key === null ? {} : { 'x-ops-alert-key': key }),
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body }),
  });
}

const resendAccepted = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'provider_123' }), { status: 200 }));

describe('WhatsApp ops email receiver', () => {
  it('authenticates before parsing and never calls DB or Resend on a missing/wrong token', async () => {
    const database = db();
    const fetchImpl = vi.fn(resendAccepted) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    expect((await handle(request(ROOT, 'POST', '{broken', null))).status).toBe(401);
    expect((await handle(request(ROOT, 'POST', '{broken', 'wrong'))).status).toBe(401);
    expect(database.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps readiness read only, closed before HMAC approval and when capacity is full', async () => {
    const database = db();
    const fetchImpl = vi.fn(resendAccepted) as typeof fetch;
    const pending = createOpsAlertEmailHandler({ db: database, config: config(), fetchImpl, now: () => NOW });
    expect(await (await pending(request(ROOT, 'GET', null))).json()).toEqual({ ready: false, code: 'approval' });
    const ready = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    const response = await ready(request(ROOT, 'GET', null));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(database.reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    database.checkReservationReady = vi.fn(async () => ({ data: { ready: false, remaining: 0 }, error: null }));
    const full = await ready(request(ROOT, 'GET', null));
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ ready: false, code: 'capacity' });
    database.checkReservationReady = vi.fn(async () => ({ data: null, error: { code: '42883' } }));
    const missingRpc = await ready(request(ROOT, 'GET', null));
    expect(missingRpc.status).toBe(503);
    expect(await missingRpc.json()).toEqual({ ready: false, code: 'database' });
    database.checkReservationReady = vi.fn(async () => ({ data: { ready: false, remaining: 15 }, error: null }));
    expect((await ready(request(ROOT, 'GET', null))).status).toBe(503);
  });

  it('sends only after durable reservation with Resend idempotency key, then completes before 200', async () => {
    const database = db();
    const sequence: string[] = [];
    database.reserve = vi.fn(async () => { sequence.push('reserve'); return { data: { decision: 'reserved' as const, attempt_id: ATTEMPT }, error: null }; });
    database.complete = vi.fn(async () => { sequence.push('complete'); return { data: true, error: null }; });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      sequence.push('resend');
      expect(url).toBe('https://api.resend.com/emails');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(ATTEMPT);
      const body = JSON.parse(String(init?.body));
      expect(body.to).toEqual(['operator@example.test']);
      expect(body.text).toContain(PAYLOAD.unit_id);
      expect(body.text).not.toContain('5511999999999');
      return new Response(JSON.stringify({ id: 'provider_123' }), { status: 200 });
    }) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(sequence).toEqual(['reserve', 'resend', 'complete']);
    expect(database.complete).toHaveBeenCalledWith(ATTEMPT, 'accepted', 'provider_123');
  });

  it('uses /test without approval but keeps token, configuration and the SQL budget', async () => {
    const database = db();
    const fetchImpl = vi.fn(resendAccepted) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: config(), fetchImpl, now: () => NOW });
    expect((await handle(request(`${ROOT}/test`, 'POST', null, null))).status).toBe(401);
    expect((await handle(request(`${ROOT}/test`, 'POST', '{"subject":"caller"}'))).status).toBe(400);
    const response = await handle(request(`${ROOT}/test`, 'POST', null));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(database.reserve).toHaveBeenCalledWith(expect.objectContaining({
      p_unit_id: null, p_channel_id: null, p_alert_type: 'synthetic_test',
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const noRecipient = createOpsAlertEmailHandler({ db: database, config: { ...config(), to: null }, fetchImpl, now: () => NOW });
    expect((await noRecipient(request(`${ROOT}/test`, 'POST', null))).status).toBe(503);
  });

  it('rejects malformed payload, changed recipient and quota before Resend', async () => {
    const database = db();
    const fetchImpl = vi.fn(resendAccepted) as typeof fetch;
    const base = await approvedConfig();
    const handle = createOpsAlertEmailHandler({ db: database, config: base, fetchImpl, now: () => NOW });
    expect((await handle(request(ROOT, 'POST', JSON.stringify({ ...PAYLOAD, phone: '5511999999999' })))).status).toBe(400);
    expect(database.reserve).not.toHaveBeenCalled();
    const changed = createOpsAlertEmailHandler({ db: database, config: { ...base, to: 'changed@example.test' }, fetchImpl, now: () => NOW });
    expect((await changed(request())).status).toBe(503);
    database.reserve = vi.fn(async () => ({ data: { decision: 'blocked' as const, reason: 'window' as const }, error: null }));
    expect((await handle(request())).status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
    database.reserve = vi.fn(async () => ({ data: { decision: 'blocked' as const, reason: 'capacity' as const }, error: null }));
    expect((await handle(request())).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns accepted replay without another Resend call and protects concurrent requests via SQL decision', async () => {
    const database = db();
    let claimed = false;
    database.reserve = vi.fn(async () => {
      if (claimed) return { data: { decision: 'blocked' as const, reason: 'window' as const }, error: null };
      claimed = true;
      return { data: { decision: 'reserved' as const, attempt_id: ATTEMPT }, error: null };
    });
    const fetchImpl = vi.fn(resendAccepted) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    const statuses = await Promise.all([handle(request()), handle(request())]);
    expect(statuses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    database.reserve = vi.fn(async () => ({ data: { decision: 'replay' as const, attempt_id: ATTEMPT }, error: null }));
    expect((await handle(request())).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed after provider acceptance if SQL completion fails; never logs provider body or address', async () => {
    const database = db();
    database.complete = vi.fn(async () => ({ data: false, error: null }));
    const events: unknown[] = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'provider_123', private: 'leak-me' }), { status: 200 })) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW, log: (event) => events.push(event) });
    expect((await handle(request())).status).toBe(503);
    expect(JSON.stringify(events)).not.toMatch(/leak-me|operator@example.test|synthetic-resend-key/);
    expect(events).toMatchObject([{ stage: 'complete', code: 'unavailable' }]);
  });

  it('marks an uncertain result on 409 or transport error without an automatic retry', async () => {
    const database = db();
    const fetchImpl = vi.fn(async () => new Response('{"private":"leak-me"}', { status: 409 })) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    expect((await handle(request())).status).toBe(503);
    expect(database.complete).toHaveBeenCalledWith(ATTEMPT, 'uncertain', null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('also keeps a provider 400 uncertain until manual reconciliation', async () => {
    const database = db();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 })) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    expect((await handle(request())).status).toBe(503);
    expect(database.complete).toHaveBeenCalledWith(ATTEMPT, 'uncertain', null);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs a sanitized completion failure when provider result is uncertain', async () => {
    const database = db();
    database.complete = vi.fn(async () => ({ data: false, error: null }));
    const events: unknown[] = [];
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(),
      fetchImpl: vi.fn(async () => new Response('private response', { status: 400 })) as typeof fetch,
      now: () => NOW, log: (event) => events.push(event) });
    expect((await handle(request())).status).toBe(503);
    expect(events).toContainEqual(expect.objectContaining({ stage: 'complete', code: 'unavailable' }));
    expect(JSON.stringify(events)).not.toMatch(/private response|operator@example.test|synthetic-resend-key/);
  });

  it('treats provider timeout and a 200 without acceptance id as uncertain', async () => {
    const database = db();
    const fetchImpl = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    expect((await handle(request())).status).toBe(503);
    expect(database.complete).toHaveBeenCalledWith(ATTEMPT, 'uncertain', null);
    database.complete = vi.fn(async () => ({ data: true, error: null }));
    const noId = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(),
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch, now: () => NOW });
    expect((await noId(request())).status).toBe(503);
    expect(database.complete).toHaveBeenCalledWith(ATTEMPT, 'uncertain', null);
  });

  it('fits slow reservation, provider and SQL completion inside the 20-second producer budget', async () => {
    const database = db();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    database.reserve = vi.fn(async () => { await delay(1_850); return { data: { decision: 'reserved' as const, attempt_id: ATTEMPT }, error: null }; });
    database.complete = vi.fn(async () => { await delay(1_850); return { data: true, error: null }; });
    const fetchImpl = vi.fn(async () => { await delay(6_850); return new Response(JSON.stringify({ id: 'provider_123' }), { status: 200 }); }) as typeof fetch;
    const handle = createOpsAlertEmailHandler({ db: database, config: await approvedConfig(), fetchImpl, now: () => NOW });
    const started = performance.now();
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 20_000);
});

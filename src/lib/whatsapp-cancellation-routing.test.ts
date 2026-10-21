// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createEdgeRequestHarness } from '../test/fixtures/edge-request-harness';
import { createAutomationEndpointIO, createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { selectReservationAutomationRoute } from '../../supabase/functions/_shared/whatsapp-automation-producer-routing';

const opened: ReturnType<typeof createEdgeRequestHarness>[] = [];
const producerFixtures: ReturnType<typeof createAutomationFixture>[] = [];
afterEach(() => {
  for (const harness of opened.splice(0)) { harness.assertNoUnexpectedIo(); harness.dispose(); }
  for (const f of producerFixtures.splice(0)) { const p = f.producer(); p.harness.dispose(); expect(p.unexpected).toEqual([]); }
});

function setup(role: Parameters<typeof createAutomationEndpointIO>[0] = 'owner') {
  const fixture = createAutomationEndpointIO(role);
  fixture.rows.reservations[0].status = 'cancelled';
  fixture.rows.reservations[0].cancelled_at = '2026-10-05T14:00:00Z';
  Object.assign(fixture.row, { kind: 'cancellation', reservation_id: fixture.ids.reservation, waitlist_id: null, voucher_id: null });
  const db = {
    ...fixture.db,
    from(table: string) {
      if (table !== 'reservations') return fixture.db.from(table);
      const original = fixture.db.from(table);
      let columns = '', reservationId: unknown;
      const wrapper = {
        select(value: string) { columns = value; original.select(value); return wrapper; },
        eq(key: string, value: unknown) { if (key === 'id') reservationId = value; original.eq(key, value); return wrapper; },
        async maybeSingle() {
          if (columns === 'id, status, unit_id, cancelled_at') {
            const row = fixture.rows.reservations.find(item => item.id === reservationId);
            return { data: row ? { id: row.id, status: row.status, unit_id: row.unit_id, cancelled_at: row.cancelled_at } : null, error: null };
          }
          return original.maybeSingle();
        },
      };
      return wrapper;
    },
  };
  const harness = createEdgeRequestHarness({
    now: Date.parse('2026-10-05T15:00:00Z'),
    env: { SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
    createClient: () => db,
    internalHops: [{ from: 'send-cancellation', to: 'send-scheduled-whatsapp' }],
  });
  opened.push(harness);
  const request = (headers: Record<string,string> = { Authorization: 'Bearer synthetic-jwt' },
    body: Record<string, unknown> = { reservation_id: fixture.ids.reservation }) =>
    harness.request('send-cancellation', new Request('https://fixture.supabase.invalid/functions/v1/send-cancellation', {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
  return { fixture, harness, request };
}

describe('send-cancellation actual Request boundary', () => {
  it('verified service OFF returns a skipped cancellation without creating a job or provider POST', async () => {
    const f = setup();
    f.fixture.operatorControls.ledgerVisible = false;
    f.fixture.operatorControls.serviceRoute = { auto_cohort: true, allowed: false, reason_code: 'service_not_enabled' };
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, sent: false, skipped: 'service_not_enabled' });
    expect(f.harness.internalRequests).toHaveLength(0);
    expect(f.fixture.calls.post).toBe(0);
  });
  it('requires a valid JWT before resource lookup', async () => {
    const f = setup();
    expect((await f.request({})).status).toBe(401);
    expect(f.harness.internalRequests).toHaveLength(0);
  });
  it('authorizes the resource unit before dispatch or customer read', async () => {
    const f = setup('outsider');
    expect((await f.request()).status).toBe(403);
    expect(f.harness.internalRequests).toHaveLength(0);
  });
  it('does not reveal whether an inaccessible reservation exists', async () => {
    const f = setup('outsider');
    const foreign = await f.request();
    f.fixture.rows.reservations.splice(0);
    const missing = await f.request();
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual(await foreign.json());
    expect(f.harness.internalRequests).toHaveLength(0);
  });
  it('rejects caller-supplied unit or cancellation fact', async () => {
    const f = setup();
    const headers = { Authorization: 'Bearer synthetic-jwt' };
    expect((await f.request(headers, { reservation_id: f.fixture.ids.reservation,
      fact_at: '2026-10-05T14:00:00Z' })).status).toBe(400);
    expect((await f.request(headers, { reservation_id: f.fixture.ids.reservation,
      unit_id: f.fixture.ids.foreignUnit })).status).toBe(400);
    expect(f.harness.internalRequests).toHaveLength(0);
  });
  it('blocks a reverted reservation and missing server cancellation fact', async () => {
    const f = setup();
    f.fixture.operatorControls.ledgerVisible = false;
    f.fixture.rows.reservations[0].status = 'confirmed';
    expect((await f.request()).status).toBe(409);
    f.fixture.rows.reservations[0].status = 'cancelled';
    f.fixture.rows.reservations[0].cancelled_at = null;
    expect((await f.request()).status).toBe(409);
    expect(f.harness.internalRequests).toHaveLength(0);
  });
  it('returns the prior durable job after status reversion without a new POST', async () => {
    const f = setup();
    f.fixture.rows.reservations[0].status = 'confirmed';
    f.fixture.rows.reservations[0].cancelled_at = null;
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, automation: { jobId: f.fixture.jobId } });
    expect(f.fixture.calls.post).toBe(0);
  });
  it('uses the internal and user credentials for an existing cancellation job', async () => {
    const f = setup();
    const response = await f.request();
    expect(response.status).toBe(200);
    const hop = f.harness.internalRequests[0];
    expect(hop.to).toBe('send-scheduled-whatsapp');
    expect(hop.request.headers.get('x-internal-key')).toBe('synthetic-internal');
    expect(hop.request.headers.get('authorization')).toBe('Bearer synthetic-jwt');
    expect(await hop.request.json()).toEqual({ action: 'dispatch_operator', kind: 'cancellation',
      resource_id: f.fixture.ids.reservation, unit_id: f.fixture.ids.unit });
    expect(f.fixture.calls.post).toBe(0);
  });
});

describe('cancellation route before effects', () => {
  const unitId = 'bbbbbbbb-0000-0000-0000-000000000001';
  const reservationId = 'eeeeeeee-0000-0000-0000-000000000001';
  const pick = (state: 'enabled' | 'paused' | 'legacy' | 'read_error', ledger: Record<string, unknown> | null = null) =>
    selectReservationAutomationRoute(async (table) => {
      if (state === 'read_error' && table === 'platform_flags') throw new Error('synthetic_read_error');
      if (table === 'whatsapp_automation_jobs') return ledger;
      if (table === 'whatsapp_automation_adoptions') return state === 'legacy' ? null : { adopted_at: '2026-10-01T00:00:00Z' };
      if (table === 'platform_flags') return { value: true };
      if (table === 'whatsapp_template_bindings') return [{ dispatch_enabled: state === 'enabled', adopted_at: '2026-10-01T00:00:00Z' }];
      if (table === 'whatsapp_channels') return [{ id:'aaaaaaaa-0000-0000-0000-000000000001', unit_id:unitId, provider:'zapi',
        status:'connected', is_active:true, created_at:'2026-09-01T00:00:00Z' }];
      throw new Error(`unexpected:${table}`);
    }, { kind: 'cancellation', unitId, reservationId }, async () => ({auto_cohort:false,allowed:true}));
  it('selects enabled, paused, legacy and dependency without falling back on read error', async () => {
    expect(await pick('enabled')).toEqual({ path: 'managed', existingJobId: null, selection: 'scheduled' });
    expect(await pick('paused')).toEqual({ path: 'managed', existingJobId: null, selection: 'paused' });
    expect(await pick('legacy')).toEqual({ path: 'legacy' });
    expect(await pick('read_error')).toEqual({ path: 'dependency' });
  });
  it('prioritizes a durable ledger over a paused or failed activation read', async () => {
    const f = createAutomationEndpointIO();
    const row = { ...f.row, unit_id: unitId, reservation_id: reservationId,
      waitlist_id: null, voucher_id: null, kind: 'cancellation' };
    expect(await pick('read_error', row)).toMatchObject({ path: 'managed', existingJobId: f.jobId });
  });
});

function liveCancellation(mode: 'legacy' | 'paused' | 'read_error') {
  const f = createAutomationFixture(); producerFixtures.push(f);
  const p = f.producer();
  Object.assign(f.rows.reservations[0], { status: 'cancelled', cancelled_at: f.nowISO });
  p.controls.ledger = false;
  if (mode === 'legacy') { p.controls.adopted = false; p.controls.bindingEnabled = false; }
  if (mode === 'paused') { p.controls.bindingEnabled = false; p.controls.flag = false; }
  if (mode === 'read_error') p.controls.queryError = 'whatsapp_automation_adoptions';
  const providerPosts: string[] = [];
  const db = {
    auth: { getUser: async (jwt: string) => ({ data: { user: jwt === 'synthetic-jwt' ? { id: '77777777-0000-4000-8000-000000000001' } : null }, error: null }) },
    rpc: p.db.rpc,
    from(table: string) {
      if (table === 'unit_members' || table === 'platform_admins') {
        const filters: Record<string, unknown> = {};
        const q = { select: () => q, eq: (key: string, value: unknown) => { filters[key] = value; return q; },
          maybeSingle: async () => ({ data: table === 'unit_members' && filters.unit_id === f.ids.unit
            ? { user_id: filters.user_id } : null, error: null }) };
        return q;
      }
      if (table === 'reservations') return { select: (columns: string) => {
        if (columns !== 'id, status, date, time, party_size, reservation_code, unit_id, customer:customers(id, name, phone)')
          return p.db.from(table).select(columns);
        const filters: Record<string, unknown> = {};
        const q = { eq: (key: string, value: unknown) => { filters[key] = value; return q; },
          maybeSingle: async () => ({ data: filters.id === f.ids.reservation && filters.unit_id === f.ids.unit
            ? { ...f.rows.reservations[0], customer: { ...f.rows.customers[0] } } : null, error: null }) };
        return q;
      } };
      if (table === 'notifications_sent') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }),
          upsert: async (value: Record<string, unknown>) => { p.requests.push(value); return { data: null, error: null }; } };
        return q;
      }
      return p.db.from(table);
    },
  };
  const harness = createEdgeRequestHarness({ now: Date.parse(f.nowISO),
    env: { SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
    createClient: () => db,
    internalHops: [{ from: 'send-cancellation', to: 'send-scheduled-whatsapp' }],
    transport: [{ from: 'send-cancellation', method: 'POST',
      url: 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text',
      respond: async req => { providerPosts.push(JSON.stringify(await req.json())); return Response.json({ messageId: 'synthetic-legacy-message' }); } }],
  });
  opened.push(harness);
  const request = () => harness.request('send-cancellation', new Request('https://fixture.supabase.invalid/functions/v1/send-cancellation', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-jwt' }, body: JSON.stringify({ reservation_id: f.ids.reservation }),
  }));
  return { f, p, harness, providerPosts, request };
}

describe('send-cancellation legacy and paused Request paths', () => {
  it('unadopted unit sends the existing text and appends conversation history', async () => {
    const x = liveCancellation('legacy');
    const response = await x.request();
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(x.providerPosts).toHaveLength(1);
    expect(x.providerPosts[0]).toContain('Reserva Cancelada');
    expect(x.p.requests).toContainEqual(expect.objectContaining({ kind: 'cancellation', status: 'sent' }));
    expect(x.p.trace.some(call => call.name === 'append_conversation_message')).toBe(true);
    expect(x.p.trace.find(call => call.name === 'claim_whatsapp_legacy_automation_post')).toMatchObject({ args: {
      p_kind: 'cancellation', p_resource_id: x.f.ids.reservation, p_origin: 'send-cancellation' } });
    expect(x.p.trace.findIndex(call => call.name === 'finish_whatsapp_legacy_automation_post'))
      .toBeLessThan(x.p.trace.findIndex(call => call.name === 'append_conversation_message'));
    expect(x.harness.internalRequests).toHaveLength(0);
  });
  it('adopted paused unit invokes the managed endpoint without any provider POST', async () => {
    const x = liveCancellation('paused');
    const response = await x.request();
    expect([202, 409, 503]).toContain(response.status);
    expect(x.harness.internalRequests.map(hop => hop.to)).toEqual(['send-scheduled-whatsapp']);
    expect(x.providerPosts).toHaveLength(0);
    expect(x.p.requests.filter(row => row.kind === 'cancellation')).toHaveLength(0);
  });
  it('route read error refuses without managed or legacy POST', async () => {
    const x = liveCancellation('read_error');
    const response = await x.request();
    expect(response.status).toBe(503);
    expect(x.harness.internalRequests).toHaveLength(0);
    expect(x.providerPosts).toHaveLength(0);
  });
});

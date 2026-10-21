// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createEdgeRequestHarness } from '../test/fixtures/edge-request-harness';
import { createAutomationEndpointIO, createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';

const opened: ReturnType<typeof createEdgeRequestHarness>[] = [];
const producers: ReturnType<typeof createAutomationFixture>[] = [];
afterEach(() => {
  for (const harness of opened.splice(0)) { harness.assertNoUnexpectedIo(); harness.dispose(); }
  for (const f of producers.splice(0)) { const p = f.producer(); p.harness.dispose(); expect(p.unexpected).toEqual([]); }
});

function setup(options: { role?: 'owner' | 'outsider' | 'platform_admin'; status?: string; route?: 'existing' | 'managed' | 'legacy' | 'error';
  update?: 'ok' | 'zero' | 'error'; serviceRoute?: 'disabled' | 'dependency' } = {}) {
  const f = createAutomationEndpointIO(options.role ?? 'owner');
  const id = '99999999-0000-4000-8000-000000000001';
  const row: Record<string, unknown> = { id, unit_id: f.ids.unit, status: options.status ?? 'waiting',
    notified_at: options.status === 'notified' ? f.nowISO : null,
    notified_server_at: options.status === 'notified' ? f.nowISO : null, customer_phone: '11999999999' };
  Object.assign(f.row, { kind: 'waitlist_table_ready', reservation_id: null, waitlist_id: id, voucher_id: null });
  f.rows.waitlist.push(row);
  const effects = { updates: 0 };
  let ledgerRead = 0;
  const db = {
    ...f.db,
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'get_whatsapp_v2_service_route' && options.serviceRoute)
        return { data: { auto_cohort: true, allowed: false,
          reason_code: options.serviceRoute === 'disabled' ? 'service_not_enabled' : 'dependency_unavailable' }, error: null };
      return f.db.rpc(name, args);
    },
    from(table: string) {
      if (table === 'waitlist') {
        const predicates: Record<string, unknown> = {};
        let columns = '', patch: Record<string, unknown> | null = null;
        const q = {
          select(value: string) { columns = value; return q; },
          update(value: Record<string, unknown>) { patch = value; return q; },
          eq(key: string, value: unknown) { predicates[key] = value; return q; },
          async maybeSingle() {
            if (predicates.id !== id) return { data: null, error: null };
            return { data: Object.fromEntries(columns.split(',').map(key => [key, row[key.trim()]])), error: null };
          },
          async then(resolve: (value: { data: unknown[]; error: unknown }) => unknown) {
            if (!patch) throw new Error('unexpected waitlist read');
            effects.updates++;
            if (options.update === 'error') return resolve({ data: [], error: { code: 'synthetic_update' } });
            if (options.update === 'zero' || row.status !== predicates.status) return resolve({ data: [], error: null });
            Object.assign(row, patch);
            if (patch.status === 'notified') row.notified_server_at = row.notified_at;
            return resolve({ data: [Object.fromEntries(columns.split(',').map(key => [key.trim(), row[key.trim()]]))], error: null });
          },
        };
        return q;
      }
      if (table === 'whatsapp_automation_jobs' && (options.route === 'legacy' || options.route === 'error'
        || (options.route === 'managed' && ledgerRead++ === 0))) {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
        return q;
      }
      if (table === 'whatsapp_automation_adoptions' && options.route !== 'existing') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: options.route === 'legacy'
          ? null : { adopted_at: '2026-10-01T00:00:00Z' }, error: options.route === 'error' ? { code: 'synthetic' } : null }) };
        return q;
      }
      if (table === 'platform_flags' && options.route !== 'existing') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { value: options.route === 'managed' }, error: null }) };
        return q;
      }
      if (table === 'whatsapp_template_bindings' && options.route !== 'existing') {
        const q = { select: () => q, eq: () => q, then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [{ dispatch_enabled: options.route === 'managed', adopted_at: options.route === 'managed' ? '2026-10-01T00:00:00Z' : null }], error: null }) };
        return q;
      }
      return f.db.from(table);
    },
  };
  const harness = createEdgeRequestHarness({
    now: Date.parse(f.nowISO),
    env: { SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
    createClient: () => db,
    internalHops: options.route === 'existing' || options.route === 'managed' ? [{ from: 'notify-waitlist-ready', to: 'send-scheduled-whatsapp' }] : [],
  });
  opened.push(harness);
  const request = (body: Record<string, unknown> = { waitlist_id: id, message: 'Texto editável' }, jwt = 'synthetic-jwt') =>
    harness.request('notify-waitlist-ready', new Request('https://fixture.supabase.invalid/functions/v1/notify-waitlist-ready', {
      method: 'POST', headers: jwt ? { Authorization: `Bearer ${jwt}` } : {}, body: JSON.stringify(body),
    }));
  return { f, row, id, harness, effects, request };
}

function setupLegacy(options: { providerStatus?: number; malformed?: boolean; updateError?: boolean; foreign?: boolean;
  partial?: boolean } = {}) {
  const f = createAutomationFixture(); producers.push(f);
  const p = f.producer();
  p.controls.ledger = false; p.controls.adopted = false; p.controls.bindingEnabled = false;
  const id = '99999999-0000-4000-8000-000000000011';
  const entry = { id, unit_id: options.foreign ? f.ids.foreignUnit : f.ids.unit,
    status: 'waiting', notified_at: null as string | null, notified_server_at: null as string | null,
    customer_phone: '11999999999', customer_id: f.ids.customer };
  f.rows.waitlist.push(entry);
  const effects = { updates: 0, providerBodies: [] as Record<string, unknown>[] };
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: '77777777-0000-4000-8000-000000000001' } }, error: null }) },
    rpc: p.db.rpc,
    from(table: string) {
      if (table === 'unit_members' || table === 'platform_admins') {
        const predicates: Record<string, unknown> = {};
        const q = { select: () => q, eq: (key: string, value: unknown) => { predicates[key] = value; return q; },
          maybeSingle: async () => ({ data: table === 'unit_members' && predicates.unit_id === f.ids.unit
            ? { user_id: predicates.user_id } : null, error: null }) };
        return q;
      }
      if (table === 'waitlist') {
        const predicates: Record<string, unknown> = {};
        let columns = '', patch: Record<string, unknown> | null = null;
        const q = {
          select(value: string) { columns = value; return q; },
          update(value: Record<string, unknown>) { patch = value; return q; },
          eq(key: string, value: unknown) { predicates[key] = value; return q; },
          async maybeSingle() {
            const match = Object.entries(predicates).every(([key,value]) => entry[key as keyof typeof entry] === value);
            return { data: match ? Object.fromEntries(columns.split(',').map(key => [key.trim(), entry[key.trim() as keyof typeof entry]])) : null, error: null };
          },
          async then(resolve: (value: { data: unknown[]; error: unknown }) => unknown) {
            if (!patch) throw new Error('unexpected waitlist read');
            effects.updates++;
            if (options.updateError) return resolve({ data: [], error: { code: 'synthetic_update' } });
            const match = Object.entries(predicates).every(([key,value]) => entry[key as keyof typeof entry] === value);
            if (!match) return resolve({ data: [], error: null });
            Object.assign(entry, patch);
            if (patch.status === 'notified') entry.notified_server_at = entry.notified_at;
            return resolve({ data: [Object.fromEntries(columns.split(',').map(key => [key.trim(), entry[key.trim() as keyof typeof entry]]))], error: null });
          },
        };
        return q;
      }
      return p.db.from(table);
    },
  };
  const harness = createEdgeRequestHarness({
    now: Date.parse(f.nowISO),
    env: { SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' },
    createClient: () => db,
    internalHops: [{ from: 'notify-waitlist-ready', to: 'send-whatsapp' }],
    afterInternalResponse: (from, to, response) => from === 'notify-waitlist-ready' && to === 'send-whatsapp'
      ? options.malformed ? Response.json({}) : options.partial
        ? Response.json({ success: true, warning: 'CONVERSATION_RECONCILIATION_REQUIRED' }, { status: 202 }) : response : response,
    transport: [{ from: 'send-whatsapp', method: 'POST',
      url: 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text',
      respond: async request => { effects.providerBodies.push(await request.json());
        return Response.json(options.providerStatus && options.providerStatus !== 200 ? { error: 'synthetic_provider' } : { messageId: 'synthetic-legacy' },
          { status: options.providerStatus ?? 200 }); } }],
  });
  opened.push(harness);
  const request = (message = 'Texto editável da loja') =>
    harness.request('notify-waitlist-ready', new Request('https://fixture.supabase.invalid/functions/v1/notify-waitlist-ready', {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-jwt' },
      body: JSON.stringify({ waitlist_id: id, message }),
    }));
  return { f, p, entry, effects, harness, request };
}

describe('notify-waitlist-ready Request boundary', () => {
  it('rejects missing JWT and caller-supplied tenant, phone or fact', async () => {
    const x = setup({ route: 'existing' });
    expect((await x.request(undefined, '')).status).toBe(401);
    for (const extra of [{ unit_id: x.f.ids.foreignUnit }, { phone: '11911111111' }, { fact_at: x.f.nowISO }])
      expect((await x.request({ waitlist_id: x.id, ...extra })).status).toBe(400);
    expect(x.effects.updates).toBe(0);
  });
  it('authorizes the resource unit before gate or dispatch', async () => {
    const x = setup({ role: 'outsider', route: 'existing' });
    expect((await x.request()).status).toBe(403);
    expect(x.effects.updates).toBe(0);
    expect(x.harness.internalRequests).toHaveLength(0);
    const missing = await x.request({ waitlist_id: '99999999-0000-4000-8000-000000000002' });
    expect(missing.status).toBe(403);
  });
  it('records server fact before managed dispatch and reuses it on the second click', async () => {
    const x = setup({ route: 'managed' });
    const first = await x.request();
    expect([200, 202, 503]).toContain(first.status);
    expect(x.row.status).toBe('notified');
    expect(x.row.notified_at).toBe(new Date(x.f.nowISO).toISOString());
    const second = await x.request();
    expect([200, 202, 503]).toContain(second.status);
    expect(x.effects.updates).toBe(1);
    expect(x.harness.internalRequests).toHaveLength(2);
    expect(await x.harness.internalRequests[0].request.json()).toEqual({ action: 'dispatch_operator',
      kind: 'waitlist_table_ready', resource_id: x.id, unit_id: x.f.ids.unit });
  });
  it('blocks seated status and update races without fallback', async () => {
    const seated = setup({ route: 'managed', status: 'seated' });
    expect((await seated.request()).status).toBe(409);
    const raced = setup({ route: 'managed', update: 'zero' });
    expect((await raced.request()).status).toBe(409);
    expect(raced.harness.internalRequests).toHaveLength(0);
    const failed = setup({ route: 'managed', update: 'error' });
    expect((await failed.request()).status).toBe(503);
    expect(failed.harness.internalRequests).toHaveLength(0);
  });
  it('reports a durable job even after the entry was seated and the phone removed', async () => {
    const x = setup({ route: 'existing', status: 'seated' });
    x.row.customer_phone = null;
    const response = await x.request();
    expect(response.status).toBe(200);
    expect((await response.json()).existing).toBe(true);
    expect(x.effects.updates).toBe(0);
  });
  it('fails closed when the adoption read fails', async () => {
    const x = setup({ route: 'error' });
    expect((await x.request()).status).toBe(503);
    expect(x.effects.updates).toBe(0);
  });
  it('distinguishes verified OFF from a dependency before changing the waitlist fact', async () => {
    const off = setup({ route: 'managed', serviceRoute: 'disabled' });
    const skipped = await off.request();
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ success: false, sent: false,
      error: 'service_not_enabled', skipped: 'service_not_enabled', statusUpdated: false });
    expect(off.effects.updates).toBe(0);
    expect(off.harness.internalRequests).toHaveLength(0);
    const uncertain = setup({ route: 'managed', serviceRoute: 'dependency' });
    expect((await uncertain.request()).status).toBe(503);
    expect(uncertain.effects.updates).toBe(0);
  });
  it('keeps the first fact when a new managed job cannot finish immediately', async () => {
    const x = setup({ route: 'managed' });
    await x.request();
    expect(x.row.status).toBe('notified');
    expect(x.effects.updates).toBe(1);
    expect(x.harness.internalRequests).toHaveLength(1);
    const fact = x.row.notified_at;
    await x.request();
    expect(x.effects.updates).toBe(1);
    expect(x.row.notified_at).toBe(fact);
  });
});

describe('notify-waitlist-ready legacy Request path', () => {
  it('uses editable text and the server phone, then updates status after provider acceptance', async () => {
    const x = setupLegacy();
    const response = await x.request('Mesa pronta, texto da loja');
    expect(response.status).toBe(200);
    expect((await response.json()).statusUpdated).toBe(true);
    expect(x.effects.providerBodies).toHaveLength(1);
    expect(JSON.stringify(x.effects.providerBodies[0])).toContain('Mesa pronta, texto da loja');
    expect(JSON.stringify(x.effects.providerBodies[0])).toContain('5511999999999');
    expect(x.entry.status).toBe('notified');
    expect(x.effects.updates).toBe(1);
    const hop = x.harness.internalRequests[0];
    expect(await hop.request.json()).toMatchObject({ phone: x.entry.customer_phone,
      message: 'Mesa pronta, texto da loja', unit_id: x.f.ids.unit, waitlist_id: x.entry.id });
  });
  it('does not update after provider rejection or malformed HTTP 200', async () => {
    for (const options of [{ providerStatus: 400 }, { malformed: true }]) {
      const x = setupLegacy(options);
      expect((await x.request()).status).toBe(502);
      expect(x.effects.updates).toBe(0);
      expect(x.entry.status).toBe('waiting');
    }
  });
  it('returns partial status after an accepted send and failed UPDATE', async () => {
    const x = setupLegacy({ updateError: true, partial: true });
    const response = await x.request();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, sent: true, statusUpdated: false,
      warning: 'CONVERSATION_RECONCILIATION_REQUIRED' });
    expect(x.effects.providerBodies).toHaveLength(1);
    expect(x.entry.status).toBe('waiting');
  });
  it('rejects a member of another unit before any provider request', async () => {
    const x = setupLegacy({ foreign: true });
    expect((await x.request()).status).toBe(403);
    expect(x.harness.internalRequests).toHaveLength(0);
    expect(x.effects.providerBodies).toHaveLength(0);
  });
});

// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createEdgeRequestHarness } from '../test/fixtures/edge-request-harness';
import { createAutomationEndpointIO } from '../test/fixtures/whatsapp-automation-fixtures';
const fixtures: ReturnType<typeof createEdgeRequestHarness>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => { f.assertNoUnexpectedIo(); f.dispose(); }));
const id = (n: number) => `12000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const env = { SUPABASE_URL: 'https://synthetic-project.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal', ZAPI_WEBHOOK_SECRET: 'synthetic-fallback' };
const now = Date.parse('2026-10-09T12:00:00Z'), secret = 'synthetic-per-channel';
type Row = Record<string, unknown>;
function receiptFixture(provider = 'datafy') {
  const channel: Row = { id: id(1), unit_id: id(2), provider, credentials: { phone_number_id: '123' }, webhook_secret: secret,
    template_credential_revision: 2, external_instance_id: null, instance_token_secret_id: id(20), status: 'disconnected', is_active: false,
    activation_requested_at: null, manual_echo_verified_at: null, async_ingestion_enabled: false };
  const controls = { adopted: true, cohortError: false, recorderError: false, stale: false, managementError: false };
  const calls: { name: string; args: Row }[] = [], reads: string[] = [], effects: string[] = [];
  const db = {
    from(table: string) {
      const filters: Row = {}; let columns = '', mutation = '';
      const execute = async (single: boolean) => {
        if (mutation) {
          if (table !== 'webhook_executions' && table !== 'notifications_sent') throw new Error(`Unexpected mutation ${table}`);
          effects.push(table); return { data: null, error: null };
        }
        reads.push(table);
        if (table === 'whatsapp_channels') { expect(filters.id).toBe(channel.id); return { data: { ...channel }, error: null }; }
        if (table === 'whatsapp_automation_adoptions') { expect(filters.unit_id).toBe(channel.unit_id); expect(columns).toBe('unit_id'); return { data: controls.adopted ? { unit_id: channel.unit_id } : null, error: controls.cohortError ? {} : null }; }
        if (table === 'platform_flags') return { data: { value: false }, error: null };
        if (table === 'whatsapp_template_bindings') return { data: { id: id(3), generation: 1, account_id: id(4), channel_id: channel.id,
          unit_id: channel.unit_id, provider, verified_at: '2026-10-09T12:00:00.123456+00:00', channel_credential_revision: 2 }, error: null };
        if (table === 'whatsapp_template_accounts') return { data: { id: id(4), waba_id: 'waba', organization_id: id(5), binding_generation: 1 }, error: null };
        if (table === 'units') return { data: { organization_id: id(5) }, error: null };
        if (table === 'whatsapp_remote_templates' && !single) return { data: [], error: null };
        throw new Error(`Unexpected read ${table}:${columns}`);
      };
      const q = {
        select(value: string) { columns = value; return q; }, eq(k: string, v: unknown) { filters[k] = v; return q; },
        is(k: string, v: unknown) { filters[k] = v; return q; }, order() { return q; }, range() { return q; },
        insert(_value: unknown) { mutation = 'insert'; return q; }, update(_value: unknown) { mutation = 'update'; return q; },
        maybeSingle: () => execute(true),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) { return execute(false).then(resolve, reject); },
      }; return q;
    },
    async rpc(name: string, args: Row) {
      calls.push({ name, args });
      if (name === 'get_whatsapp_channel_instance_token') return { data: 'synthetic-instance-token', error: null };
      if (name === 'record_whatsapp_automation_receipts') { effects.push('receipt'); return { data: { state: controls.stale ? 'authority_changed' : 'recorded', inserted: 1 }, error: controls.recorderError ? {} : null }; }
      if (name === 'record_whatsapp_template_events_fenced') { effects.push('management'); return { data: 1, error: controls.managementError ? {} : null }; }
      throw new Error(`Unexpected rpc ${name}`);
    },
  };
  const harness = createEdgeRequestHarness({ env, now, createClient: () => db }); fixtures.push(harness);
  const request = async (payload: unknown, signedText?: string) => {
    const body = JSON.stringify(payload), headers: Record<string, string> = { 'content-type': 'application/json' };
    if (provider === 'datafy') {
      const timestamp = String(now / 1000);
      const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${signedText ?? body}`));
      headers['x-datafy-timestamp'] = timestamp; headers['x-datafy-signature-256'] = `sha256=${Buffer.from(sig).toString('hex')}`;
    } else headers['x-webhook-secret'] = typeof channel.webhook_secret === 'string' ? channel.webhook_secret : env.ZAPI_WEBHOOK_SECRET;
    return harness.request('webhook-whatsapp', new Request(`${env.SUPABASE_URL}/functions/v1/webhook-whatsapp?channel=${channel.id}`, { method: 'POST', body, headers }));
  };
  return { channel, controls, calls, reads, effects, request, harness };
}
const meta = (statuses: unknown[], management = false) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [
  ...(management ? [{ field: 'message_template_status_update', value: { message_template_id: 123, event: 'APPROVED' } }] : []),
  { field: 'messages', value: { metadata: { phone_number_id: '123' }, statuses } },
] }] });

describe('actual webhook receipt Request', () => {
  it('preserves raw signature validation before new dependencies', async () => {
    const f = receiptFixture(); expect((await f.request(meta([{ id: 'm1', status: 'read' }]), '{}')).status).toBe(401);
    expect(f.reads).toEqual(['whatsapp_channels']); expect(f.calls).toEqual([]);
  });
  it('admits once before provider-source split, using original backend revision and null native time', async () => {
    const f = receiptFixture(); expect((await f.request(meta([{ id: 'm1', status: 'read' }, { id: 'm2', status: 'delivered' }]))).status).toBe(200);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toEqual({ name: 'record_whatsapp_automation_receipts', args: {
      p_channel_id: id(1), p_unit_id: id(2), p_provider: 'datafy', p_credential_revision: 2, p_external_instance_id: null,
      p_events: [{ provider_message_id: 'm1', status: 'read', provider_timestamp: null }, { provider_message_id: 'm2', status: 'delivered', provider_timestamp: null }],
    } });
    expect(f.reads.filter(x => x === 'whatsapp_automation_adoptions')).toHaveLength(1);
  });
  it('never-adopted callback retains legacy delivery and no new receipt write', async () => {
    const f = receiptFixture(); f.controls.adopted = false;
    expect((await f.request(meta([{ id: 'm1', status: 'read' }]))).status).toBe(200);
    expect(f.calls).toEqual([]); expect(f.effects).toContain('notifications_sent');
  });
  it.each(['cohortError', 'recorderError', 'stale'] as const)('refuses %s before legacy/management effects', async fault => {
    const f = receiptFixture(); f.controls[fault] = true;
    expect((await f.request(meta([{ id: 'm1', status: 'read' }], true))).status).toBe(fault === 'stale' ? 401 : 503);
    expect(f.effects).not.toContain('management'); expect(f.effects).not.toContain('notifications_sent');
  });
  it.each(['m\u0000', 'x'.repeat(513)])('rejects malformed recognized id before either ledger', async nativeId => {
    const f = receiptFixture(); expect((await f.request(meta([{ id: nativeId, status: 'read' }], true))).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  it('valid receipt commits first; later WABA failure is503 with durable receipt kept', async () => {
    const f = receiptFixture(); f.controls.managementError = true;
    expect((await f.request(meta([{ id: 'm1', status: 'read' }], true))).status).toBe(503);
    expect(f.effects.slice(0, 2)).toEqual(['receipt', 'management']);
    f.controls.managementError = false;
    expect((await f.request(meta([{ id: 'm1', status: 'read' }], true))).status).toBe(200);
    expect(f.calls.filter(c => c.name === 'record_whatsapp_automation_receipts')[0].args).toEqual(f.calls.filter(c => c.name === 'record_whatsapp_automation_receipts')[1].args);
  });
  it('pure management and unknown status add no adoption dependency', async () => {
    const f = receiptFixture(); const payload = meta([], true); payload.entry[0].changes.pop();
    expect((await f.request(payload)).status).toBe(200); expect(f.reads).not.toContain('whatsapp_automation_adoptions');
  });
  it('adopted ZAPI global-secret fallback refuses observably; never-adopted keeps legacy', async () => {
    const f = receiptFixture('zapi'); f.channel.webhook_secret = null;
    const body = { type: 'MessageStatusCallback', ids: ['m1'], status: 'READ' };
    expect((await f.request(body)).status).toBe(503); expect(f.calls).toEqual([]);
    f.controls.adopted = false; expect((await f.request(body)).status).toBe(200);
  });
  it('checks original UazAPI501 before legacy parser truncation', async () => {
    const f = receiptFixture('uazapi');
    expect((await f.request({ EventType: 'messages_update', event: { Type: 'Read', MessageIDs: Array(501).fill('m1') } })).status).toBe(413);
    expect(f.calls.map(c => c.name)).toEqual(['get_whatsapp_channel_instance_token']);
  });
});

describe('actual worker Request and existing dispatcher hop', () => {
  it('authenticates first and rejects every body other than empty object without SQL', async () => {
    const calls: string[] = [];
    const f = createEdgeRequestHarness({ env, createClient: () => ({ rpc: async (name: string) => { calls.push(name); throw new Error('unexpected'); } }) }); fixtures.push(f);
    expect((await f.request('process-whatsapp-automations', new Request(env.SUPABASE_URL, { method: 'POST', body: 'not json' }))).status).toBe(401);
    for (const body of ['not json', 'null', '[]', '{"limit":20}']) expect((await f.request('process-whatsapp-automations', new Request(env.SUPABASE_URL, {
      method: 'POST', headers: { 'x-internal-key': env.INTERNAL_API_KEY }, body,
    }))).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it('one internal actual dispatch of accepted job performs zero new claims or provider POST', async () => {
    const io = createAutomationEndpointIO(); const rpcs: string[] = [];
    const f = createEdgeRequestHarness({ env, internalHops: [{ from: 'process-whatsapp-automations', to: 'send-scheduled-whatsapp' }],
      createClient: () => ({ ...io.db, rpc: async (name: string, args: Row) => {
        rpcs.push(name);
        if (name === 'maintain_and_select_whatsapp_automation_work') return { data: { version: 1, selected_at: '2026-10-09T12:00:00Z', sql_minute: 29860560, priority: 'rechecks', mode: 'work', expired_count: 0,
          allocation: { total_limit: 20, auxiliary_limit: 5, rechecks: 0, repairs: 0, normal_limit: 20, normal_count: 1 }, normal: [{ job_id: io.jobId, channel_id: io.row.channel_id, action: 'dispatch' }], rechecks: [], repairs: [] }, error: null };
        if (name === 'purge_whatsapp_automation_workers') return { data: { receipts_deleted: 0, jobs_deleted: 0 }, error: null };
        return io.db.rpc(name, args);
      } }),
    }); fixtures.push(f);
    const response = await f.request('process-whatsapp-automations', new Request(env.SUPABASE_URL, { method: 'POST', body: '{}', headers: { 'x-internal-key': env.INTERNAL_API_KEY } }));
    expect(response.status).toBe(200); expect(f.internalRequests).toHaveLength(1);
    expect(rpcs).toEqual(['maintain_and_select_whatsapp_automation_work', 'reconcile_whatsapp_automation_acceptance', 'purge_whatsapp_automation_workers']);
    expect(io.calls.post).toBe(0);
  });
  it.each([true, false])('observes real dispatcher lookup failure=%s without retry or extra claim', async lookupFailure => {
    const io = createAutomationEndpointIO('owner', true); const rpcs: string[] = [];
    Object.assign(io.row, { state: 'blocked', error_code: 'dispatch_paused' }); io.controls.gate = false;
    const ledgerReads: Row[] = [], internalResults: { status: number; body: unknown }[] = [];
    const f = createEdgeRequestHarness({ env, now: Date.parse(io.nowISO),
      internalHops: [{ from: 'process-whatsapp-automations', to: 'send-scheduled-whatsapp' }],
      afterInternalResponse: async (_from, _to, response) => {
        internalResults.push({ status: response.status, body: await response.clone().json() }); return response;
      },
      createClient: () => ({ ...io.db,
        from(table: string) {
          if (!lookupFailure || table !== 'whatsapp_automation_jobs') return io.db.from(table);
          return { select(columns: string) {
            expect(columns).toBe('*');
            return { eq(key: string, value: unknown) {
              expect({ [key]: value }).toEqual({ id: io.jobId }); ledgerReads.push({ [key]: value });
              return { maybeSingle: async () => ({ data: null, error: { message: 'synthetic_ledger_lookup_failure' } }) };
            } };
          } };
        },
        rpc: async (name: string, args: Row) => {
          rpcs.push(name);
          if (name === 'maintain_and_select_whatsapp_automation_work') return { data: { version: 1, selected_at: io.nowISO, sql_minute: 29860560, priority: 'rechecks', mode: 'work', expired_count: 0,
            allocation: { total_limit: 20, auxiliary_limit: 5, rechecks: 1, repairs: 0, normal_limit: 19, normal_count: 0 },
            normal: [], rechecks: [{ job_id: io.jobId, channel_id: io.row.channel_id }], repairs: [] }, error: null };
          if (name === 'purge_whatsapp_automation_workers') return { data: { receipts_deleted: 0, jobs_deleted: 0 }, error: null };
          return io.db.rpc(name, args);
        },
      }),
    }); fixtures.push(f);
    const response = await f.request('process-whatsapp-automations', new Request(env.SUPABASE_URL, { method: 'POST', body: '{}', headers: { 'x-internal-key': env.INTERNAL_API_KEY } }));
    expect(response.status).toBe(200);
    expect(internalResults).toEqual([{ status: 200, body: lookupFailure
      ? { state: 'not_enqueued', jobId: null, reason: 'dependency_unavailable' }
      : { state: 'blocked', pinPhase: 'bound', jobId: io.jobId, reason: 'dispatch_paused' } }]);
    expect(f.internalRequests).toHaveLength(1);
    expect(await f.internalRequests[0].request.json()).toEqual({ action: 'dispatch_existing', job_id: io.jobId });
    expect(rpcs).toEqual(['maintain_and_select_whatsapp_automation_work', 'purge_whatsapp_automation_workers']);
    expect(io.calls.operations).toEqual(lookupFailure ? [] : ['read:reservations', 'read:units', 'read:organizations', 'read:customers']);
    expect(io.queries.filter(q => q.table === 'platform_flags' && q.predicates.key === 'whatsapp_automation_dispatch'))
      .toHaveLength(lookupFailure ? 0 : 1);
    expect(io.calls.post).toBe(0); expect(io.unexpected).toEqual([]);
    if (lookupFailure) expect(ledgerReads).toEqual([{ id: io.jobId }]);
    expect((await response.json()).work).toEqual({ expired_count: 0, actions: 1, claim_budget_used: 1, errors: lookupFailure ? 1 : 0, deadline_reached: false });
  });
});

describe('actual existing resend Request preserves acceptance authority', () => {
  function setup(state: string | null, role: Parameters<typeof createAutomationEndpointIO>[0] = 'owner',
    kind: 'confirmation' | 'waitlist_entered' | 'waitlist_table_ready' = 'confirmation', legacyResponse?: unknown) {
    const io = createAutomationEndpointIO(role, true);
    const waitlistId = id(77);
    Object.assign(io.row, { state: state ?? 'queued', provider_message_id: null, posting_started_at: null });
    if (kind === 'waitlist_table_ready') Object.assign(io.row, { kind, reservation_id: null, waitlist_id: waitlistId });
    io.controls.gate = false;
    const reads: string[] = [], controls = { adopted: legacyResponse === undefined, foreignResource: false };
    const client = { ...io.db, from(table: string) {
      if (!['whatsapp_automation_jobs', 'whatsapp_automation_adoptions', 'reservations', 'waitlist'].includes(table)) return io.db.from(table);
      return { select(columns: string) {
        const isLedger = table === 'whatsapp_automation_jobs' && columns === 'id,state,provider_message_id,posting_started_at,expires_at';
        const isAdoption = table === 'whatsapp_automation_adoptions' && columns === 'unit_id';
        const isResource = (table === 'reservations' || table === 'waitlist') && columns === 'id,unit_id';
        if (legacyResponse !== undefined && table === 'waitlist' && columns === 'unit_id, customer_id') {
          return { eq() { return this; }, async maybeSingle() { return { data: null, error: { code: 'synthetic_no_provider' } }; } };
        }
        if (legacyResponse !== undefined && table === 'waitlist' && columns === 'id, unit_id, customer_name, customer_phone, party_size, code, created_at') {
          return { eq() { return this; }, async maybeSingle() { return { data: { id: waitlistId, unit_id: io.ids.unit,
            customer_name: 'Synthetic', customer_phone: '11999996601', party_size: 2, code: 77, created_at: io.nowISO }, error: null }; } };
        }
        if (!isLedger && !isAdoption && !isResource) return io.db.from(table).select(columns);
        const predicates: Row = {};
        const q = { eq(key: string, value: unknown) { predicates[key] = value; return q; }, async maybeSingle() {
          reads.push(table);
          if (isResource) {
            const resourceId = kind === 'confirmation' ? io.ids.reservation : waitlistId;
            expect(predicates).toEqual({ id: resourceId });
            return { data: { id: resourceId, unit_id: controls.foreignResource ? id(99) : io.ids.unit }, error: null };
          }
          expect(predicates).toEqual(isLedger ? { unit_id: io.ids.unit, kind,
            [kind === 'confirmation' ? 'reservation_id' : 'waitlist_id']: kind === 'confirmation' ? io.ids.reservation : waitlistId } : { unit_id: io.ids.unit });
          return { data: isLedger ? state === null ? null : { id: io.jobId, state, provider_message_id: io.row.provider_message_id,
            posting_started_at: io.row.posting_started_at, expires_at: io.row.expires_at }
            : controls.adopted ? { unit_id: io.ids.unit } : null, error: null };
        } }; return q;
      } };
    } };
    const legacyClient = legacyResponse === undefined ? client : { ...client, from(table: string) {
      if (table === 'units') return { select(columns: string) { expect(columns).toBe('name'); return {
        eq() { return this; }, async maybeSingle() { return { data: { name: 'Synthetic Unit' }, error: null }; } }; } };
      if (table === 'waitlist') return { select(columns: string) {
        if (columns !== 'id,unit_id,customer_id') return client.from(table).select(columns);
        const filters: Row = {};
        return { eq(key: string, value: unknown) { filters[key] = value; return this; }, async maybeSingle() {
          expect(filters).toEqual({ id: waitlistId });
          return { data: { id: waitlistId, unit_id: io.ids.unit, customer_id: io.ids.customer }, error: null };
        } };
      } };
      if (table === 'waitlist_message_templates') return { select(columns: string) { expect(columns).toBe('customized, body'); return {
        eq() { return this; }, async maybeSingle() { return { data: null, error: null }; } }; } };
      return client.from(table);
    } };
    const harness = createEdgeRequestHarness({ env, now: Date.parse(io.nowISO), createClient: () => legacyClient,
      internalHops: [{ from: 'resend-notification', to: 'send-scheduled-whatsapp' },
        ...(legacyResponse === undefined ? [] : [{ from: 'resend-notification' as const, to: 'send-whatsapp' as const }])],
      afterInternalResponse: (_from, to, response) => to === 'send-whatsapp'
        ? new Response(JSON.stringify(legacyResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }) : response }); fixtures.push(harness);
    const request = (requestedKind: string = kind) => harness.request('resend-notification', new Request(env.SUPABASE_URL, { method: 'POST',
      headers: { Authorization: 'Bearer synthetic-jwt' }, body: JSON.stringify({ kind: requestedKind, unit_id: io.ids.unit,
        [kind === 'confirmation' ? 'reservation_id' : 'waitlist_id']: kind === 'confirmation' ? io.ids.reservation : waitlistId }) }));
    return { io, controls, reads, harness, request };
  }
  it.each(['accepted', 'reconciled', 'uncertain', 'posting', 'needs_review', 'expired', 'failed', 'rejected'])('refuses %s without new dispatcher hop or provider POST', async state => {
    const f = setup(state); if (state === 'accepted' || state === 'reconciled') f.io.row.provider_message_id = 'already-accepted';
    expect((await f.request()).status).toBe(409);
    expect(f.harness.internalRequests).toEqual([]); expect(f.io.calls.post).toBe(0); expect(f.io.unexpected).toEqual([]);
  });
  it('a stale queued label cannot reopen native acceptance evidence', async () => {
    const f = setup('queued'); f.io.row.provider_message_id = 'durable-native';
    expect((await f.request()).status).toBe(409); expect(f.harness.internalRequests).toEqual([]);
  });
  it('authorized blocked retry uses only the same pinned job and existing real dispatcher', async () => {
    const f = setup('blocked'); expect((await f.request()).status).toBe(409);
    expect(f.harness.internalRequests).toHaveLength(1);
    expect(await f.harness.internalRequests[0].request.json()).toEqual({ action: 'dispatch_existing', job_id: f.io.jobId });
    expect(f.io.calls.post).toBe(0); expect(f.io.unexpected).toEqual([]);
  });
  it('table-ready resend uses its pinned job and no legacy text', async () => {
    const f = setup('blocked', 'owner', 'waitlist_table_ready');
    expect((await f.request()).status).toBe(409);
    expect(f.reads.slice(0, 2)).toEqual(['waitlist', 'whatsapp_automation_jobs']);
    expect(f.harness.internalRequests).toHaveLength(1);
    expect(await f.harness.internalRequests[0].request.json()).toEqual({ action: 'dispatch_existing', job_id: f.io.jobId });
    expect(f.io.calls.post).toBe(0); expect(f.io.unexpected).toEqual([]);
  });
  it('table-ready resend expires at its pinned ledger deadline without a hop', async () => {
    const f = setup('queued', 'owner', 'waitlist_table_ready');
    f.io.row.expires_at = '2026-10-05T14:59:59Z';
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, discarded: true, error: 'message_expired' });
    expect(f.harness.internalRequests).toEqual([]); expect(f.io.calls.post).toBe(0);
  });
  it('adopted table-ready without a job refuses to reconstruct a message', async () => {
    const f = setup(null, 'owner', 'waitlist_table_ready');
    expect((await f.request()).status).toBe(409);
    expect(f.reads).toEqual(['waitlist', 'whatsapp_automation_jobs', 'whatsapp_automation_adoptions']);
    expect(f.harness.internalRequests).toEqual([]);
  });
  it.each([null, {}])('legacy waitlist resend rejects malformed 2xx payload %j', async payload => {
    const f = setup(null, 'owner', 'waitlist_entered', payload);
    const response = await f.request();
    expect(response.status, JSON.stringify({ body: await response.clone().json(), logs: f.harness.logs,
      unexpected: f.io.unexpected, reads: f.reads, hops: f.harness.internalRequests.map(request => request.to) })).toBe(502);
    expect(await response.json()).toMatchObject({ success: false, error: 'send_failed' });
    expect(f.harness.internalRequests.map(request => request.to)).toEqual(['send-whatsapp']);
  });
  it('never-adopted waitlist resend preserves the legacy success contract', async () => {
    const f = setup(null, 'owner', 'waitlist_entered', { success: true });
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(f.harness.internalRequests.map(request => request.to)).toEqual(['send-whatsapp']);
  });
  it('adopted missing job cannot invent a new producer fact', async () => {
    const f = setup(null); expect((await f.request()).status).toBe(409);
    expect(f.reads).toEqual(['reservations', 'whatsapp_automation_jobs', 'whatsapp_automation_adoptions']);
    expect(f.harness.internalRequests).toEqual([]);
  });
  it('foreign resource refuses before ledger lookup', async () => {
    const f = setup('blocked'); f.controls.foreignResource = true;
    expect((await f.request()).status).toBe(403); expect(f.reads).toEqual(['reservations']); expect(f.harness.internalRequests).toEqual([]);
  });
  it('unauthorized caller and unsupported kind have no automation I/O', async () => {
    const f = setup('blocked', 'outsider'); expect((await f.request()).status).toBe(403);
    expect((await f.request('voucher_issued')).status).toBe(400); expect(f.reads).toEqual(['reservations']); expect(f.harness.internalRequests).toEqual([]);
  });
});

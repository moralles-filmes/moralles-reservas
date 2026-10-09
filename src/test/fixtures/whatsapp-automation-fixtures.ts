import { createAutomationResourceService, type AutomationResourceIO, type AutomationResourceTable } from '../../../supabase/functions/_shared/whatsapp-automation-resources';
import type { ScheduledIntent } from '../../../supabase/functions/_shared/whatsapp-automation-core';
import { createAutomationDispatcher } from '../../../supabase/functions/_shared/whatsapp-automation-dispatch';
import { catalogHash, TEMPLATE_CATALOG } from '../../../supabase/functions/_shared/whatsapp-template-catalog-core';
import type { TemplateSendInput, TemplateSendOutcome } from '../../../supabase/functions/_shared/whatsapp-template-provider-core';
import { createEdgeRequestHarness, type EdgeName } from './edge-request-harness';

/** Mutable database I/O only. No SQL, auth, eligibility or dispatch decision is emulated. */
export function createAutomationFixture(options: { templateStatus?: string } = {}) {
  const ids = { unit: 'bbbbbbbb-0000-0000-0000-000000000001', organization: 'aaaaaaaa-0000-0000-0000-000000000001',
    customer: 'cccccccc-0000-0000-0000-000000000001', reservation: 'eeeeeeee-0000-0000-0000-000000000001',
    foreignUnit: 'bbbbbbbb-0000-0000-0000-000000000003' };
  const nowISO = '2026-10-05T15:00:00Z';
  let now = Date.parse(nowISO);
  const rows: Record<AutomationResourceTable, Record<string, unknown>[]> = {
    reservations: [{ id: ids.reservation, unit_id: ids.unit, customer_id: ids.customer, date: '2026-10-05', time: '20:30:00',
      status: 'confirmed', payment_status: null, source: 'web', party_size: 4, reservation_code: 'RES123',
      applied_discount_percent: null, satisfaction_rating: null }],
    units: [{ id: ids.unit, organization_id: ids.organization, name: 'Restaurante Exemplo', slug: 'exemplo', timezone: 'America/Sao_Paulo' }],
    organizations: [{ id: ids.organization }],
    customers: [{ id: ids.customer, organization_id: ids.organization, name: 'Marina', phone: '55912345678', do_not_contact: false, deleted_at: null }],
    waitlist: [], vouchers: [], voucher_rules: [], settings: [],
  };
  const calls = Object.assign([] as { table: string; columns: string; predicates: Readonly<Record<string, string>> }[],
    { email: 0, legacyText: 0, post: 0, recordSent: 0 });
  const projections: Record<AutomationResourceTable, string> = {
    reservations: 'id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,applied_discount_percent,satisfaction_rating',
    waitlist: 'id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at',
    vouchers: 'id,unit_id,customer_id,rule_id,code,discount_percent,status,issued_at,created_at,expires_at',
    customers: 'id,organization_id,name,phone,do_not_contact,deleted_at',
    units: 'id,organization_id,name,slug,timezone', organizations: 'id', settings: 'value', voucher_rules: 'id,unit_id,trigger_type',
  };
  const readOne: AutomationResourceIO['readOne'] = async (table, columns, predicates) => {
      const keys = Object.keys(predicates).sort().join(',');
      const permittedKeys = table === 'settings' ? ['key,unit_id'] : table === 'voucher_rules' ? ['id,unit_id']
        : table === 'customers' ? ['id','organization_id,phone'] : ['id'];
      if (!(table in rows) || columns !== projections[table] || !permittedKeys.includes(keys)
        || Object.values(predicates).some(value => typeof value !== 'string' || !value)) throw new Error('unexpected_fixture_query');
      calls.push({ table, columns, predicates });
      const matches = rows[table].filter(row => Object.entries(predicates).every(([k, v]) => row[k] === v));
      if (matches.length > 1) throw new Error('fixture_cardinality');
      if (!matches[0]) return null;
      const result: Record<string, unknown> = {};
      for (const field of columns.split(',')) {
        if (!(field in matches[0])) throw new Error(`fixture_missing_column:${table}.${field}`);
        result[field] = matches[0][field];
      }
      return result;
    };
  const resources = createAutomationResourceService({ now: () => now, readOne });
  const intent: ScheduledIntent = { kind: 'confirmation', unitId: ids.unit, reservationId: ids.reservation,
    sourceEventKey: 'outbox:00000000-0000-4000-8000-000000000001', factAt: '2026-10-05T20:30:00-03:00' };
  const base = { ids, rows, calls, resources, readOne, intent, nowISO, setNow: (value: string) => { now = Date.parse(value); } };
  let producer: ReturnType<typeof createReservationProducerIO> | undefined;
  const getProducer = () => producer ??= createReservationProducerIO(base, options);
  return { ...base, producer: getProducer,
    runReservationProducer: (kind: 'confirmation' | 'reminder_d1' | 'survey_d1' | 'outbox', overrides: Record<string, unknown> = {}) =>
      getProducer().run(kind, overrides) };
}

export async function createTemplateDispatchFixture(promotional = false) {
  const f = createDispatchFixture();
  const accountId = '88888888-0000-4000-8000-000000000001', templateId = '99999999-0000-4000-8000-000000000001';
  const logical = promotional ? 'fila_feedback_v1' : 'res_confirmacao_v1';
  const hash = await catalogHash(TEMPLATE_CATALOG[logical]);
  Object.assign(f.row, { provider: 'datafy', transport: 'template', account_id: accountId, remote_template_id: templateId,
    template_version: 1, sync_epoch: 3, initial_catalog_key: logical });
  if (promotional) {
    Object.assign(f.row, { kind: 'waitlist_feedback', reservation_id: null, waitlist_id: f.ids.reservation,
      fact_at: '2026-10-04T23:59:00-03:00', expires_at: '2026-10-06T02:59:00Z' });
    f.rows.waitlist.push({ id: f.ids.reservation, unit_id: f.ids.unit, customer_id: f.ids.customer, customer_name: 'Marina', customer_phone: '55912345678',
      party_size: 4, code: 12, status: 'seated', created_at: '2026-10-04T12:00:00Z', seated_at: '2026-10-04T15:00:00Z' });
  }
  const template: Record<string, unknown> = { id: templateId, account_id: accountId, logical_id: logical, name: logical, version: 1,
    language: 'pt_BR', desired_hash: hash, observed_hash: hash, requested_category: promotional ? 'MARKETING' : 'UTILITY',
    effective_category: promotional ? 'MARKETING' : 'UTILITY', quality: 'GREEN', local_status: 'usable', remote_status: 'APPROVED', sync_required: false,
    last_synced_at: f.nowISO, remote_id: 'remote-native-template', sync_epoch: 3 };
  if (promotional) f.consentEvents.push({ unit_id: f.ids.unit, customer_id: f.ids.customer, purpose: 'promotional', decision: 'opt_in', revision: 1 });
  const controls = { outcome: { state: 'accepted', status: 200, providerMessageId: 'native-template-1' } as TemplateSendOutcome,
    prepareResult: true, syncFails: false };
  const sent: TemplateSendInput[] = [], hashes: string[] = [];
  const io = { ...f.io,
    readOne: async (table: string, columns: string, predicates: Readonly<Record<string, string>>, latest?: string): Promise<unknown> => {
      if (table === 'whatsapp_remote_templates' && columns === '*' && predicates.id === templateId && predicates.account_id === accountId) return { ...template };
      if (table === 'whatsapp_channels' && columns === 'id,unit_id,phone_number_id:credentials->>phone_number_id' && predicates.id === f.row.channel_id && predicates.unit_id === f.ids.unit) return { id: predicates.id, unit_id: f.ids.unit, phone_number_id: '1234567890' };
      return f.io.readOne(table, columns, predicates, latest);
    },
    rpc: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === 'issue_whatsapp_preference_token') { if (args.p_job_id !== f.jobId || typeof args.p_token_hash !== 'string') throw new Error('unexpected_token_rpc'); hashes.push(args.p_token_hash); return true; }
      if (name === 'prepare_whatsapp_automation_post' && !controls.prepareResult) return false;
      return f.io.rpc(name, args);
    },
    observeTemplates: async () => { if (controls.syncFails) throw new Error('synthetic_sync_failed'); template.last_synced_at = f.nowISO; template.sync_required = false; },
    prepareScheduledChannel: async () => {
      f.calls.operations.push('channel:prepare');
      if (f.row.state === 'posting') f.controls.duringLastPrepare();
      return { ok: true as const, channel: { id: String(f.row.channel_id), unitId: f.ids.unit, provider: 'datafy' as const,
      bindingId: String(f.row.binding_id), generation: 1, credentialRevision: 1, accountId, transport: 'template' as const,
      sendTemplate: async (input: TemplateSendInput) => { f.calls.operations.push('adapter'); f.calls.post++; sent.push(input); return controls.outcome; } } };
    },
  };
  return { ...f, template, templateControls: controls, sent, hashes, io, dispatch: () => createAutomationDispatcher(io).dispatchExistingJob(f.jobId) };
}

/** Minimal real-SDK-shaped I/O for the actual Request loader. Unknown operations fail visibly. */
export function createAutomationEndpointIO(role: 'owner' | 'gerente' | 'operador' | 'platform_admin' | 'foreign' | 'outsider' | 'invalid' = 'owner', queued = false) {
  const f = createDispatchFixture();
  if (!queued) { f.row.state = 'accepted'; f.row.provider_message_id = 'native-request'; }
  const queries: { table: string; columns: string; predicates: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const userId = '77777777-0000-4000-8000-000000000001';
  const fail = (reason: string): never => { unexpected.push(reason); throw new Error('unexpected_endpoint_io'); };
  const db = {
    auth: { getUser: async (token: string) => token === 'synthetic-jwt' && role !== 'invalid'
      ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: 'synthetic_invalid' } } },
    from(table: string) {
      const predicates: Record<string, unknown> = {};
      let columns = '', head = false, latestOrder: string | undefined;
      let patch: Record<string, unknown> | null = null;
      const project = (row: Record<string, unknown>) => Object.fromEntries(columns.split(',').map(part => {
        const key = part.trim(); if (!(key in row)) return fail(`missing_projection:${table}.${key}`); return [key, row[key]];
      }));
      async function execute(single: boolean): Promise<{ data: unknown; error: null; count?: number }> {
        queries.push({ table, columns, predicates: { ...predicates } });
        if (patch) {
          if (table !== 'whatsapp_automation_jobs' || columns !== 'id' || Object.keys(patch).join(',') !== 'safe_log_body'
            || predicates.id !== f.jobId || predicates.claim_token !== f.row.claim_token || predicates.state !== 'claimed'
            || predicates.posting_started_at !== null || predicates.provider_message_id !== null || predicates.customer_erased_at !== null) return fail('capture_shape');
          Object.assign(f.row, patch); return { data: [{ id: f.jobId }], error: null };
        }
        if (table === 'whatsapp_channels') {
          if (predicates.unit_id !== f.ids.unit) return fail('channel_tenant');
          if (head && columns === 'id' && predicates.is_active === true) return { data: null, count: 1, error: null };
          const channel = { id: f.row.channel_id, unit_id: f.ids.unit, provider: 'zapi', credentials: { instance_id: 'synthetic-instance', token: 'synthetic-token', client_token: 'synthetic-client' },
            instance_token_secret_id: null, status: 'connected', last_health_check_at: f.nowISO, is_active: true, template_credential_revision: 1 };
          if (predicates.id !== channel.id) return fail('channel_id');
          return { data: project(channel), error: null };
        }
        if (table === 'whatsapp_template_bindings') {
          if (predicates.unit_id !== f.ids.unit || predicates.channel_id !== f.row.channel_id || predicates.provider !== 'zapi') return fail('binding_scope');
          return { data: project({ id: f.row.binding_id, channel_id: f.row.channel_id, unit_id: f.ids.unit, provider: 'zapi', account_id: null, generation: 1, channel_credential_revision: 1 }), error: null };
        }
        if (table === 'units' && columns === 'organization_id' && predicates.id === f.ids.unit) return { data: { organization_id: f.ids.organization }, error: null };
        if (table === 'organizations' && columns === 'billing_status, whatsapp_legacy_grandfathered, whatsapp_grandfather_revoked_at' && predicates.id === f.ids.organization) return { data: { billing_status: 'active', whatsapp_legacy_grandfathered: true, whatsapp_grandfather_revoked_at: null }, error: null };
        if (table === 'organization_entitlement_overrides' && columns === 'enabled, starts_at, ends_at' && predicates.organization_id === f.ids.organization && predicates.feature === 'whatsapp' && predicates.revoked_at === null) return { data: [], error: null };
        if (table === 'billing_subscriptions' && columns === 'id, status, canceled_at, suspended_at, billing_plans!inner(category, included_features)' && predicates.organization_id === f.ids.organization) return { data: [], error: null };
        if (table === 'platform_flags' && predicates.key === 'whatsapp_service_enforcement') return { data: { value: false }, error: null };
        if (queued && !(table === 'reservations' && columns === 'id,unit_id') && !['unit_members','platform_admins','whatsapp_automation_jobs'].includes(table)) {
          const filter: Record<string, string> = {};
          for (const [key,value] of Object.entries(predicates)) { if (typeof value !== 'string') return fail('resource_filter'); filter[key] = value; }
          return { data: await f.io.readOne(table, columns, filter, latestOrder), error: null };
        }
        if (table === 'reservations' && columns === 'id,unit_id' && predicates.id === f.ids.reservation)
          return { data: role === 'foreign' || role === 'outsider' ? null : { id: f.ids.reservation, unit_id: f.ids.unit }, error: null };
        if (table === 'platform_admins' && columns === 'user_id' && predicates.user_id === userId)
          return { data: role === 'platform_admin' ? { user_id: userId } : null, error: null };
        if (table === 'unit_members' && columns === 'role' && predicates.user_id === userId && predicates.unit_id === f.ids.unit)
          return { data: ['owner','gerente','operador'].includes(role) ? { role } : null, error: null };
        if (table === 'whatsapp_automation_jobs' && columns === '*') {
          if (Object.entries(predicates).some(([key,value]) => !(key in f.row) || f.row[key] !== value)) return { data: null, error: null };
          return { data: { ...f.row }, error: null };
        }
        return fail(`${table}:${columns}:${single}`);
      }
      const query = {
        select(value: string, options?: { head?: boolean }) { columns = value; head = options?.head === true; return query; },
        update(value: Record<string, unknown>) { patch = value; return query; },
        eq(key: string, value: unknown) { predicates[key] = value; return query; },
        is(key: string, value: null) { predicates[key] = value; return query; },
        neq(key: string, value: string) { if (table !== 'billing_subscriptions' || key !== 'status' || value !== 'canceled') fail('neq_shape'); return query; },
        lte(key: string, value: string) { if (table !== 'organization_entitlement_overrides' || key !== 'starts_at' || !Number.isFinite(Date.parse(value))) fail('lte_shape'); return query; },
        or(value: string) { if (table !== 'organization_entitlement_overrides' || !value.startsWith('ends_at.is.null,ends_at.gt.')) fail('or_shape'); return query; },
        order(key: string, options: { ascending: boolean }) { if (table !== 'whatsapp_message_consent_events' || key !== 'revision' || options.ascending !== false) fail('order_shape'); latestOrder = key; return query; },
        limit(count: number) { if (count !== 1) fail('limit_shape'); return query; },
        maybeSingle: () => execute(true),
        then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) { return execute(false).then(onfulfilled, onrejected); },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (queued && name !== 'reconcile_whatsapp_automation_acceptance') return { data: await f.io.rpc(name, args), error: null };
      if (name !== 'reconcile_whatsapp_automation_acceptance' || args.p_job_id !== f.jobId) return fail(`rpc:${name}`);
      f.calls.reconcile++;
      return { data: { state: 'reconciled', history: 'recorded' }, error: null };
    },
  };
  return { ...f, db, queries, unexpected };
}

/** Scripted database responses are I/O evidence, not an implementation of SQL guards. */
export function createDispatchFixture(options: { finalizeFailsOnce?: boolean; beforeCommitFailure?: boolean; finalLeaseGap?: boolean } = {}) {
  const f = createAutomationFixture();
  const jobId = '11111111-0000-4000-8000-000000000001';
  const fence = '22222222-0000-4000-8000-000000000001';
  const channelId = '33333333-0000-4000-8000-000000000001';
  const bindingId = '44444444-0000-4000-8000-000000000001';
  const row: Record<string, unknown> = { id: jobId, unit_id: f.ids.unit, organization_id: f.ids.organization,
    kind: 'confirmation', reservation_id: f.ids.reservation, waitlist_id: null, voucher_id: null,
    customer_id: f.ids.customer, source_event_key: f.intent.sourceEventKey, fact_at: f.intent.factAt,
    expires_at: '2026-10-05T23:30:00Z', state: 'queued', pin_phase: 'bound', attempts: 0, error_code: null,
    provider_message_id: null, provider: 'zapi', transport: 'text', channel_id: channelId, binding_id: bindingId,
    binding_generation: 1, initial_credential_revision: 1, initial_catalog_key: 'res_confirmacao_v1',
    account_id: null, remote_template_id: null, template_version: null, sync_epoch: null,
    claim_token: null, claimed_until: null, posting_started_at: null, safe_log_body: null,
    consent_revision: null, cost_authorization_id: null, reconcile_required: false, customer_erased_at: null,
    notification_id: '55555555-0000-4000-8000-000000000001', finished_at: null };
  const consentEvents: { unit_id: string; customer_id: string; purpose: 'operational' | 'promotional'; decision: string; revision: number }[] = [];
  const calls = { consentReads: [] as { columns: string; predicates: Readonly<Record<string, string>>; latest: string }[],
    prepares: [] as Record<string, unknown>[], confirms: [] as Record<string, unknown>[], resourceConfirms: [] as Record<string, unknown>[],
    post: 0, reconcile: 0, operations: [] as string[], finishes: [] as Record<string, unknown>[], bodies: [] as string[], sqlNow: Date.parse(f.nowISO) };
  const controls = { afterPrepare: () => {}, duringLastPrepare: () => {}, resourceConfirm: { allowed: true } as unknown,
    durableRejection: { state: 'retry_wait', retry_at: '2026-10-05T15:00:45Z' } as { state: 'retry_wait' | 'rejected'; retry_at: string | null },
    adapterThrow: false, messageId: 'native-test-1', gate: true as unknown,
    finalChannelError: null as string | null, finalRevision: 1, claimReturnsNull: false, requeueReturnsFalse: false };
  let finishFailed = false;
  const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.operations.push(name);
    if ('p_job_id' in args && args.p_job_id !== jobId) throw new Error('unexpected_job');
    switch (name) {
      case 'claim_whatsapp_automation':
        if (controls.claimReturnsNull) return null;
        Object.assign(row, { state: 'claimed', claim_token: fence, claimed_until: '2026-10-05T15:01:30Z' }); return { ...row };
      case 'requeue_whatsapp_automation':
        if (controls.requeueReturnsFalse) return false;
        row.state = 'queued'; return true;
      case 'get_whatsapp_promotion_preference': return { decision: 'unknown', revision: null };
      case 'prepare_whatsapp_automation_post':
        calls.prepares.push({ ...args });
        Object.assign(row, { state: 'posting', attempts: 1, posting_started_at: f.nowISO }); controls.afterPrepare(); return true;
      case 'confirm_whatsapp_automation_post':
        calls.confirms.push({ ...args }); return !options.finalLeaseGap;
      case 'confirm_whatsapp_automation_resource_post': {
        calls.resourceConfirms.push({ ...args });
        const { p_expected: _expected, ...authorityArgs } = args;
        calls.confirms.push(authorityArgs);
        return options.finalLeaseGap ? { allowed: false, reason: 'authority_changed' } : controls.resourceConfirm;
      }
      case 'block_whatsapp_automation_preflight':
        Object.assign(row, { state: 'blocked', error_code: args.p_reason }); return true;
      case 'finish_whatsapp_automation': {
        const result = args.p_result as Record<string, unknown>;
        calls.finishes.push(result);
        if (options.beforeCommitFailure) throw new Error('synthetic_before_commit');
        if (result.outcome === 'accepted') Object.assign(row, { state: 'accepted', provider_message_id: result.provider_message_id, finished_at: f.nowISO, reconcile_required: true });
        else if (result.outcome === 'uncertain') Object.assign(row, { state: 'uncertain', reconcile_required: true });
        else if (result.outcome === 'rejected') Object.assign(row, { ...controls.durableRejection, error_code: result.reason });
        else if (result.outcome === 'local_preflight_refused') Object.assign(row, { state: 'blocked', attempts: 0, error_code: result.reason, posting_started_at: null });
        if (options.finalizeFailsOnce && !finishFailed) { finishFailed = true; throw new Error('synthetic_response_lost_after_commit'); }
        return true;
      }
      default: throw new Error(`unexpected_rpc:${name}`);
    }
  };
  const readOne = async (table: string, columns: string, predicates: Readonly<Record<string, string>>, latest?: string): Promise<unknown> => {
    calls.operations.push(`read:${table}`);
    if (table === 'whatsapp_automation_jobs') {
      if (columns !== '*' || predicates.id !== jobId) throw new Error('unexpected_job_query');
      return { ...row };
    }
    if (table === 'platform_flags' && columns === 'value' && predicates.key === 'whatsapp_automation_dispatch') return { value: controls.gate };
    if (table === 'reservation_message_templates' && columns === 'customized,body' && predicates.unit_id === f.ids.unit && ['reminder_d1','survey_d1'].includes(predicates.event)) return null;
    if (table === 'whatsapp_message_consent_events') {
      if (columns !== 'decision,revision' || Object.keys(predicates).sort().join(',') !== 'customer_id,purpose,unit_id'
        || Object.values(predicates).some(value => typeof value !== 'string' || !value)
        || !['operational','promotional'].includes(predicates.purpose) || latest !== 'revision') throw new Error('unexpected_consent_query');
      calls.consentReads.push({ columns, predicates: { ...predicates }, latest });
      const latestEvent = consentEvents.filter(event => Object.entries(predicates).every(([key, value]) => event[key as keyof typeof event] === value))
        .sort((a, b) => b.revision - a.revision)[0];
      return latestEvent ? { decision: latestEvent.decision, revision: latestEvent.revision } : null;
    }
    return f.readOne(table as AutomationResourceTable, columns, predicates);
  };
  const io = {
    readOne, rpc, now: () => Date.parse(f.nowISO), appBaseUrl: 'https://example.com', allowedOrigins: ['https://example.com'],
    capture: async (job: string, claim: string, body: string) => { if (job !== jobId || claim !== fence) throw new Error('unexpected_capture'); row.safe_log_body = body; return true; },
    repairAccepted: async () => { calls.reconcile++; Object.assign(row, { state: 'reconciled', reconcile_required: false }); return { state: 'reconciled' as const, history: 'recorded' as const }; },
    prepareScheduledChannel: async () => {
      calls.operations.push('channel:prepare');
      if (row.state === 'posting') {
        controls.duringLastPrepare();
        if (options.finalLeaseGap) { await Promise.resolve(); calls.sqlNow += 91_000; }
        if (controls.finalChannelError) return { ok: false as const, error: controls.finalChannelError };
      }
      return { ok: true as const, channel: { id: channelId, unitId: f.ids.unit, provider: 'zapi' as const,
        bindingId, generation: 1, credentialRevision: row.state === 'posting' ? controls.finalRevision : 1, accountId: null, transport: 'text' as const,
        sendText: async (message: { toPhone: string; text: string }) => { calls.operations.push('adapter'); calls.post++; calls.bodies.push(message.text);
          if (controls.adapterThrow) throw new Error('synthetic_transport_failure');
          return { ok: true, providerMessageId: controls.messageId }; } } };
    },
  };
  return { ...f, row, jobId, calls, io, controls, consentEvents, dispatch: () => createAutomationDispatcher(io).dispatchExistingJob(jobId) };
}

/** Actual Request handlers and declared hops; only SDK/provider ports are scripted.
 * RPC writes/replies below are deliberately supplied fixture I/O, not SQL guard evidence. */
function createReservationProducerIO(base: {
  ids: ReturnType<typeof createAutomationFixture>['ids']; rows: ReturnType<typeof createAutomationFixture>['rows'];
  calls: ReturnType<typeof createAutomationFixture>['calls']; nowISO: string;
}, options: { templateStatus?: string }) {
  const f = createDispatchFixture();
  const token = '66666666-0000-4000-8000-000000000001', outboxId = '00000000-0000-4000-8000-000000000001';
  const polls = { ledger_state: 'queued', outbox_status: 'pending', disposition: 'pending', reason: 'automation_queued', retry_after_seconds: 60 };
  const controls = { adopted: true, flag: true as unknown, bindingEnabled: true as unknown, ledger: false,
    initialClaim: token as string | null, delegate: true, emailAccepted: true, email: 'synthetic@example.invalid' as string | null,
    promotion: 'row' as 'row' | 'zero' | 'error', queryError: '' as string, pollResult: polls as unknown,
    emptyOutbox: false, pollError: false, recoveryResult: [] as unknown, selectorsEmpty: false,
    resendReceipt: false, plain: false, resend: false, requestUnit: base.ids.unit, outboxOverride: undefined as string | undefined,
    outbox: true, templateStatus: options.templateStatus, templateCategory: 'UTILITY' };
  const rpcReplies: Record<string, { data: unknown; error: unknown }[]> = {};
  const queryReplies: Record<string, { data: unknown; error: unknown }[]> = {};
  const responseScripts: { from: EdgeName; to: EdgeName; reply: (response: Response) => Response | Promise<Response> }[] = [];
  const outbox: Record<string, unknown> = { id: outboxId, reservation_id: base.ids.reservation, unit_id: base.ids.unit,
    kind: 'confirmation', status: 'pending', attempts: 2, next_attempt_at: base.nowISO, created_at: base.nowISO,
    updated_at: base.nowISO, last_error: null, automation_job_id: null, automation_initial_token: null };
  const trace: { name: string; args: Record<string, unknown> }[] = [], unexpected: string[] = [], requests: Record<string, unknown>[] = [];
  const queries: { table: string; columns: string; filters: Record<string, unknown>; patch: Record<string, unknown> | null }[] = [];
  const fail = (label: string): never => { unexpected.push(label); throw new Error(`producer_io:${label}`); };
  const tables: Record<string, Record<string, unknown>[]> = base.rows;
  const channel = { id: f.row.channel_id, unit_id: base.ids.unit, provider: 'zapi', status: 'connected', is_active: true,
    credentials: { instance_id: 'synthetic-instance', token: 'synthetic-token', client_token: 'synthetic-client' },
    instance_token_secret_id: null, last_health_check_at: base.nowISO, template_credential_revision: 1 };
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {}; let columns = '*', patch: Record<string, unknown> | null = null;
      let insert: Record<string, unknown> | null = null, head = false, limit = 10000;
      const extra: ((row: Record<string, unknown>) => boolean)[] = [];
      let sort: { key: string; ascending: boolean } | null = null;
      const matches = (row: Record<string, unknown>) => Object.entries(filters).every(([key,value]) => row[key] === value) && extra.every(predicate => predicate(row));
      const project = (row: Record<string, unknown>) => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(k => {
        const key = k.trim(); if (!(key in row)) return fail(`column:${table}:${key}`); return [key,row[key]];
      }));
      async function execute(single = false): Promise<{ data: unknown; error: unknown; count?: number }> {
        queries.push({ table, columns, filters: { ...filters }, patch });
        const scripted = queryReplies[table]?.shift();
        if (scripted) return scripted;
        if (controls.queryError === table) return { data: null, error: { code: 'synthetic_dependency' } };
        if (insert) {
          if (table !== 'notifications_sent') return fail(`insert:${table}`);
          if (insert.kind !== 'confirmation_email') base.calls.recordSent++;
          requests.push({ ...insert }); return { data: null, error: null };
        }
        if (table === 'reservations' && columns.startsWith('*, customer:customers')) {
          const row = tables.reservations.find(matches);
          return { data: row ? { ...row, customer: { ...tables.customers[0], email: controls.email }, unit: { ...tables.units[0], phone: '', instagram: '', website: '', address: null } } : null, error: null };
        }
        let rows: Record<string, unknown>[];
        if (table === 'whatsapp_automation_jobs') rows = controls.ledger ? [f.row] : [];
        else if (table === 'notification_outbox') rows = controls.emptyOutbox ? [] : [outbox];
        else if (table === 'whatsapp_automation_adoptions') rows = controls.adopted ? [{ unit_id: base.ids.unit, adopted_at: '2026-10-01T00:00:00Z' }] : [];
        else if (table === 'platform_flags') rows = [{ key: 'whatsapp_automation_dispatch', value: controls.flag }, { key: 'whatsapp_service_enforcement', value: false }];
        else if (table === 'whatsapp_template_bindings') rows = [{ id: f.row.binding_id, unit_id: base.ids.unit, channel_id: f.row.channel_id,
          provider: 'zapi', account_id: null, generation: 1, channel_credential_revision: 1,
          dispatch_enabled: controls.bindingEnabled, adopted_at: controls.adopted ? '2026-10-01T00:00:00Z' : null }];
        else if (table === 'whatsapp_channels') rows = [channel];
        else if (table === 'whatsapp_remote_templates') rows = tables.whatsapp_remote_templates ?? [];
        else if (table === 'organizations') rows = [{ ...tables.organizations[0], billing_status: 'active', whatsapp_legacy_grandfathered: true, whatsapp_grandfather_revoked_at: null }];
        else if (['organization_entitlement_overrides','billing_subscriptions','reservation_message_templates','whatsapp_message_consent_events'].includes(table)) rows = [];
        else if (table === 'notifications_sent') rows = controls.resendReceipt ? [{ id: f.row.notification_id, unit_id: base.ids.unit, reservation_id: base.ids.reservation, kind: 'confirmation', status: 'failed' }] : [];
        else if (table in tables) rows = tables[table];
        else return fail(`table:${table}`);
        rows = rows.filter(matches);
        if (sort) { const { key, ascending } = sort; rows.sort((a,b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0) * (ascending ? 1 : -1)); }
        rows = rows.slice(0,limit);
        if (patch) {
          if (!['reservations','notification_outbox','whatsapp_automation_jobs'].includes(table)) return fail(`update:${table}`);
          if (table === 'reservations' && controls.promotion !== 'row') return { data: [], error: controls.promotion === 'error' ? { code: 'synthetic_update' } : null };
          for (const row of rows) Object.assign(row, patch);
        }
        if (head) return { data: null, error: null, count: rows.length };
        const projected = rows.map(project);
        return { data: single ? projected[0] ?? null : projected, error: null };
      }
      const q = {
        select(value: string, opt?: { head?: boolean }) { columns = value; head = opt?.head === true; return q; },
        eq(key: string, value: unknown) { filters[key] = value; return q; },
        is(key: string, value: null) { filters[key] = value; return q; },
        in(key: string, value: unknown[]) { if (!['key','id'].includes(key) || !Array.isArray(value)) fail('in'); extra.push(row => value.includes(row[key])); return q; },
        lte(key: string, value: unknown) { if (!['next_attempt_at','starts_at'].includes(key) || typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('lte');
          extra.push(row => typeof row[key] === 'string' && Date.parse(row[key]) <= Date.parse(String(value))); return q; },
        neq(key: string, value: unknown) { if (table !== 'billing_subscriptions' || key !== 'status' || value !== 'canceled') fail('neq'); extra.push(row => row[key] !== null && row[key] !== value); return q; },
        or(value: string) { const prefix = 'ends_at.is.null,ends_at.gt.';
          if (table !== 'organization_entitlement_overrides' || !value.startsWith(prefix) || !Number.isFinite(Date.parse(value.slice(prefix.length)))) fail('or');
          extra.push(row => row.ends_at === null || typeof row.ends_at === 'string' && Date.parse(row.ends_at) > Date.parse(value.slice(prefix.length))); return q; },
        order(key: string, options: { ascending: boolean }) { if (!['revision','due_date'].includes(key) || typeof options.ascending !== 'boolean') fail('order'); sort = { key, ascending: options.ascending }; return q; },
        limit(value: number) { limit = value; return q; },
        update(value: Record<string, unknown>) { patch = value; return q; }, insert(value: Record<string, unknown>) { insert = value; return q; },
        single: () => execute(true), maybeSingle: () => execute(true),
        then<A = { data: unknown; error: unknown; count?: number }, B = never>(yes?: ((v: { data: unknown; error: unknown; count?: number }) => A | PromiseLike<A>) | null,
          no?: ((e: unknown) => B | PromiseLike<B>) | null) { return execute().then(yes,no); },
      }; return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      trace.push({ name, args });
      const scripted = rpcReplies[name]?.shift();
      if (scripted) return scripted;
      if (name.startsWith('get_reservations_for_')) {
        const r = tables.reservations[0];
        return { data: controls.selectorsEmpty ? [] : [{ reservation_id: r.id, unit_id: r.unit_id,
          customer_phone: tables.customers[0].phone, customer_name: tables.customers[0].name, reservation_time: r.time, party_size: r.party_size, code: r.reservation_code }], error: null };
      }
      if (name === 'recover_delegated_notification_outbox') return { data: controls.recoveryResult, error: null };
      if (name === 'claim_notification_outbox_initial') {
        if (controls.initialClaim) outbox.automation_initial_token = controls.initialClaim;
        return { data: controls.initialClaim, error: null };
      }
      if (name === 'delegate_notification_outbox_automation') {
        if (controls.delegate) outbox.automation_job_id = args.p_job_id;
        return { data: controls.delegate, error: null };
      }
      if (name === 'finish_notification_outbox_initial') return { data: true, error: null };
      if (name === 'poll_notification_outbox_automation') {
        // Explicit supplied DB outcome. No copy of SQL mapping/authorization lives here.
        outbox.status = 'pending';
        return { data: controls.pollResult, error: controls.pollError ? { code: 'synthetic_poll' } : null };
      }
      if (name === 'defer_notification_outbox_automation_dependency') { outbox.status = 'pending'; return { data: true, error: null }; }
      if (name === 'enqueue_whatsapp_automation') {
        controls.ledger = true; const intent = args.p_intent as Record<string, unknown>;
        Object.assign(f.row, intent); return { data: f.jobId, error: null };
      }
      if (name === 'reconcile_whatsapp_automation_acceptance') {
        f.row.state = 'reconciled'; base.calls.recordSent++; return { data: { state: 'reconciled', history: 'recorded' }, error: null };
      }
      if (name === 'mark_outbox_done' || name === 'mark_outbox_failed') return { data: null, error: null };
      if (name === 'get_or_create_whatsapp_conversation') return { data: '88888888-0000-4000-8000-000000000001', error: null };
      if (name === 'append_conversation_message') return { data: true, error: null };
      return { data: await f.io.rpc(name,args), error: null };
    },
  };
  const url = 'https://fixture.supabase.invalid', sendUrl = 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text';
  const h = createEdgeRequestHarness({ now: Date.parse(base.nowISO),
    env: { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', INTERNAL_API_KEY: 'synthetic-internal',
      APP_BASE_URL: 'https://example.com', RESEND_API_KEY: 'synthetic-email', RESEND_FROM_EMAIL: 'synthetic@example.invalid' },
    createClient: () => db,
    afterInternalResponse: (from, to, response) => {
      const script = responseScripts[0];
      return script?.from === from && script.to === to ? responseScripts.shift()!.reply(response) : response;
    },
    internalHops: [
      { from: 'process-notification-outbox', to: 'send-confirmation' }, { from: 'send-confirmation', to: 'send-scheduled-whatsapp' },
      { from: 'process-notification-outbox', to: 'send-scheduled-whatsapp' },
      { from: 'process-reservation-reminders', to: 'send-scheduled-whatsapp' }, { from: 'process-satisfaction-surveys', to: 'send-scheduled-whatsapp' },
      { from: 'process-reservation-reminders', to: 'send-whatsapp' }, { from: 'process-satisfaction-surveys', to: 'send-whatsapp' },
    ],
    transport: [
      { from: 'send-confirmation', method: 'POST', url: 'https://api.resend.com/emails', respond: async request => {
        base.calls.email++; requests.push(await request.json()); return Response.json(controls.emailAccepted ? { id: 'synthetic-email-id' } : { error: 'synthetic' }, { status: controls.emailAccepted ? 200 : 500 }); } },
      { from: 'send-scheduled-whatsapp', method: 'POST', url: sendUrl, respond: async request => {
        base.calls.post++; requests.push(await request.json()); return Response.json({ messageId: 'native-scheduled' }); } },
      ...(['send-confirmation','send-whatsapp'] as const).map(from => ({ from, method: 'POST', url: sendUrl, respond: async (request: Request) => {
        base.calls.legacyText++; requests.push(await request.json()); return Response.json({ messageId: 'native-legacy' }); } })),
    ],
  });
  async function run(kind: 'confirmation' | 'reminder_d1' | 'survey_d1' | 'outbox', overrides: Record<string, unknown>) {
    Object.assign(tables.reservations[0],overrides);
    if (controls.templateStatus) {
      const logical = kind === 'survey_d1' ? 'res_pesquisa_reserva_v1' : kind === 'reminder_d1' ? 'res_lembrete_dia_v1'
        : Number(tables.reservations[0].applied_discount_percent) > 0 ? 'res_confirmacao_desconto_v1' : 'res_confirmacao_v1';
      const hash = await catalogHash(TEMPLATE_CATALOG[logical]);
      const accountId = '88888888-0000-4000-8000-000000000001', templateId = '99999999-0000-4000-8000-000000000001';
      Object.assign(f.row, { provider: 'official', transport: 'template', account_id: accountId,
        remote_template_id: templateId, template_version: 1, sync_epoch: 3, initial_catalog_key: logical });
      tables.whatsapp_remote_templates = [{ id: templateId, account_id: accountId, logical_id: logical, name: logical,
        version: 1, language: 'pt_BR', desired_hash: hash, observed_hash: hash, requested_category: 'UTILITY',
        effective_category: controls.templateCategory, quality: 'GREEN', local_status: 'usable',
        remote_status: controls.templateStatus, sync_required: false, last_synced_at: base.nowISO,
        remote_id: 'native-template', sync_epoch: 3 }];
    }
    const endpoints: Record<typeof kind, EdgeName> = { confirmation: 'send-confirmation', reminder_d1: 'process-reservation-reminders', survey_d1: 'process-satisfaction-surveys', outbox: 'process-notification-outbox' };
    if (kind === 'confirmation') outbox.status = 'processing';
    const body = kind === 'confirmation' ? { record: { id: base.ids.reservation, unit_id: controls.requestUnit },
      ...(controls.plain || controls.resend || !controls.outbox ? {} : { outbox_id: controls.outboxOverride ?? outboxId }),
      ...(controls.resend ? { resend_whatsapp_only: true } : {}) } : {};
    return h.request(endpoints[kind],new Request(`${url}/functions/v1/${endpoints[kind]}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': 'synthetic-internal' }, body: JSON.stringify(body) }));
  }
  return { controls, outbox, row: f.row, db, harness: h, run, trace, unexpected, requests, queries, outboxId, rpcReplies, queryReplies, responseScripts };
}

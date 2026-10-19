import { createAutomationFixture } from './whatsapp-automation-fixtures';
import { createEdgeRequestHarness, type EdgeName } from './edge-request-harness';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * Two actual Edge module isolates sharing synthetic relational I/O. The existing
 * automation fixture supplies RPC results; it does NOT execute PostgreSQL,
 * adoption, locks, JWT, RLS or the future cutover guard. This fixture adds only
 * notification persistence/errors and a barrier at the real provider fetch.
 */
export function createCutoverDedupFixture() {
  const base = createAutomationFixture();
  const producer = base.producer();
  Object.assign(producer.controls, { adopted: false, flag: false, bindingEnabled: false, email: null });
  const notifications: Row[] = [];
  const events: { kind: string; session?: string; endpoint?: EdgeName; at?: string }[] = [];
  const posts: { session: string; endpoint: EdgeName; id: string; at: string }[] = [];
  const controls = { holdFirstPost: false, notificationWriteFailures: 0, adoptedAt: null as string | null,
    providerStatus: 200, providerThrows: false, omitMessageId: false, notificationWriteThrows: false };
  // Explicit SQL replies for JS wiring tests. No SQL decision/lock model lives here.
  const legacyRpcReplies: Record<string, unknown[]> = {
    claim_whatsapp_legacy_automation_post: [{ allowed: true, intent_id: '11111111-0000-4000-8000-000000000002', fence: '22222222-0000-4000-8000-000000000002' }],
    confirm_whatsapp_legacy_automation_post: [{ allowed: true }],
    finish_whatsapp_legacy_automation_post: [{ recorded: true, state: 'accepted' }],
  };
  const legacyCalls: { name: string; args: Row }[] = [];
  const entered = deferred(), release = deferred();
  const url = 'https://fixture.supabase.invalid';
  const env = { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    INTERNAL_API_KEY: 'synthetic-internal', APP_BASE_URL: 'https://example.com' };
  const permittedColumns = new Set(['id', 'unit_id', 'reservation_id', 'waitlist_id', 'kind', 'status', 'error',
    'provider_message_id', 'whatsapp_provider', 'whatsapp_channel_id', 'sent_at', 'delivered_at', 'read_at', 'failed_at']);
  const unexpected: string[] = [];
  function fail(reason: string): never { unexpected.push(reason); throw new Error(`cutover_fixture:${reason}`); }
  const db = {
    ...producer.db,
    async rpc(name: string, args: Row) {
      if (!(name in legacyRpcReplies)) return producer.db.rpc(name, args);
      legacyCalls.push({ name, args: structuredClone(args) }); events.push({ kind: `rpc:${name}` });
      if (!legacyRpcReplies[name].length) return fail(`missing_rpc_reply:${name}`);
      const reply = legacyRpcReplies[name].shift();
      if (reply instanceof Error) throw reply;
      return { data: reply, error: null };
    },
    from(table: string) {
      if (table !== 'notifications_sent') {
        const original = producer.db.from(table);
        if (!['whatsapp_automation_adoptions', 'whatsapp_template_bindings'].includes(table)) return original;
        // Replace the old fixture's fixed timestamp at the I/O boundary only.
        // All actual producer cutoff decisions remain in repository handlers.
        const snapshot = (result: { data: unknown; error: unknown }) => {
          const rewrite = (row: unknown) => {
            if (row === null || typeof row !== 'object' || !('adopted_at' in row)) return row;
            if (producer.controls.adopted && controls.adoptedAt === null) return fail('adoption_time_required');
            return { ...row, adopted_at: controls.adoptedAt };
          };
          return { ...result, data: Array.isArray(result.data) ? result.data.map(rewrite) : rewrite(result.data) };
        };
        const wrapped = new Proxy(original, { get(target, key) {
          if (key === 'then') return <T, E>(yes?: (result: ReturnType<typeof snapshot>) => T | PromiseLike<T>, no?: (error: unknown) => E | PromiseLike<E>) =>
            Promise.resolve(target).then(snapshot).then(yes, no);
          if (key === 'maybeSingle' || key === 'single') return async () => snapshot(await target[key]());
          const method = Reflect.get(target, key);
          return typeof method === 'function' ? (...args: unknown[]) => {
            const result = Reflect.apply(method, target, args); return result === target ? wrapped : result;
          } : method;
        } });
        return wrapped;
      }
      let columns = '', operation: 'select' | 'insert' | 'update' = 'select';
      let values: Row = {};
      const predicates: [string, unknown][] = [];
      const project = (row: Row) => Object.fromEntries(columns.split(',').map(key => {
        if (!permittedColumns.has(key)) return fail(`notification_projection:${key}`);
        return [key, structuredClone(row[key] ?? null)];
      }));
      async function execute(single = false): Promise<Result> {
        events.push({ kind: `notification:${operation}` });
        if (operation !== 'select' && controls.notificationWriteThrows) throw new Error('synthetic notification transport failure');
        if (operation !== 'select' && controls.notificationWriteFailures > 0) {
          controls.notificationWriteFailures--;
          events.push({ kind: 'notification:write_error' });
          return { data: null, error: { code: '08006', message: 'synthetic persistence unavailable' } };
        }
        let matches = notifications.filter(row => predicates.every(([key, value]) => row[key] === value));
        if (operation === 'insert') {
          const collision = notifications.some(row => row.kind === values.kind
            && ((values.reservation_id != null && row.reservation_id === values.reservation_id)
              || (values.waitlist_id != null && row.waitlist_id === values.waitlist_id)));
          if (collision) return { data: null, error: { code: '23505', message: 'synthetic unique notification' } };
          const row = { id: '55555555-0000-4000-8000-000000000001', ...structuredClone(values) };
          notifications.push(row); matches = [row];
        } else if (operation === 'update') matches.forEach(row => Object.assign(row, structuredClone(values)));
        const data = columns ? matches.map(project) : null;
        if (single && matches.length > 1) return fail('notification_cardinality');
        return { data: single ? data?.[0] ?? null : data, error: null };
      }
      const mutation = (op: 'insert' | 'update', input: Row) => {
        for (const key of Object.keys(input)) if (!permittedColumns.has(key)) fail(`notification_write:${key}`);
        operation = op; values = input; return query;
      };
      const query = {
        select(value: string) { columns = value.split(',').map(key => key.trim()).join(','); return query; },
        eq(key: string, value: unknown) { if (!permittedColumns.has(key)) fail(`notification_filter:${key}`); predicates.push([key, value]); return query; },
        insert: (input: Row) => mutation('insert', input), update: (input: Row) => mutation('update', input),
        single: () => execute(true), maybeSingle: () => execute(true),
        then<T = Result, E = never>(yes?: (value: Result) => T | PromiseLike<T>, no?: (error: unknown) => E | PromiseLike<E>) {
          return execute().then(yes, no);
        },
      };
      return query;
    },
  };
  const sessions = ['legacy-a', 'session-b'].map((session, index) => createEdgeRequestHarness({
    env, now: Date.parse(base.nowISO), createClient: () => db,
    internalHops: [{ from: 'process-notification-outbox', to: 'send-confirmation' },
      { from: 'send-confirmation', to: 'send-scheduled-whatsapp' },
      { from: 'process-reservation-reminders', to: 'send-whatsapp' },
      { from: 'process-reservation-reminders', to: 'send-scheduled-whatsapp' }],
    transport: (['send-confirmation', 'send-whatsapp', 'send-scheduled-whatsapp'] as const).map(endpoint => ({
      from: endpoint, method: 'POST',
      url: 'https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text',
      respond: async () => {
        const post = { session, endpoint, id: `synthetic-accepted-${posts.length + 1}`, at: new Date(sessions[index].now).toISOString() };
        posts.push(post); events.push({ kind: 'provider:post', session, endpoint });
        if (posts.length === 1) {
          entered.resolve();
          if (controls.holdFirstPost) await release.promise;
        }
        if (controls.providerThrows) throw new Error('synthetic response lost');
        if (controls.providerStatus === 200) events.push({ kind: 'provider:accepted', session, endpoint });
        return Response.json(controls.omitMessageId ? {} : { messageId: post.id }, { status: controls.providerStatus });
      },
    })),
  }));
  function request(session: 0 | 1, endpoint: 'send-confirmation' | 'send-whatsapp' | 'process-notification-outbox' | 'process-reservation-reminders' | 'send-scheduled-whatsapp', extra: Row = {}) {
    const body = endpoint === 'send-confirmation'
      ? { record: { id: base.ids.reservation, unit_id: base.ids.unit }, ...extra } : extra;
    return sessions[session].request(endpoint, new Request(`${url}/functions/v1/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': env.INTERNAL_API_KEY },
      body: JSON.stringify(body),
    }));
  }
  return { base, producer, controls, posts, notifications, events, sessions, request, legacyRpcReplies, legacyCalls,
    // Supplied external committed state, never a simulation/proof of adoption SQL.
    observeAdoptedState(at: string) {
      if (!Number.isFinite(Date.parse(at))) return fail('adoption_time_invalid');
      controls.adoptedAt = at;
      events.push({ kind: 'fixture:adopted_snapshot', at });
      Object.assign(producer.controls, { adopted: true, flag: true, bindingEnabled: true });
      producer.outbox.status = 'processing';
    },
    async setClock(session: 0 | 1, at: string) {
      const target = Date.parse(at);
      if (!Number.isFinite(target) || target < sessions[session].now) return fail('clock_invalid');
      await sessions[session].advanceTime(target - sessions[session].now);
    },
    async waitForFirstPost() {
      let timeout!: ReturnType<typeof setTimeout>;
      try { await Promise.race([entered.promise, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('First actual provider POST not reached')), 3000);
      })]); } finally { clearTimeout(timeout); }
    },
    releaseFirstPost: release.resolve,
    assertNoUnexpectedIo() {
      if (unexpected.length || producer.unexpected.length) throw new Error(`Unexpected fixture I/O: ${[...unexpected, ...producer.unexpected].join(',')}`);
      if (Object.values(legacyRpcReplies).some(replies => replies.length > 0)) throw new Error('Expected legacy guard RPC was not exercised by the actual handler');
      sessions.forEach(session => session.assertNoUnexpectedIo());
    },
    dispose() { release.resolve(); sessions.forEach(session => session.dispose()); producer.harness.dispose(); },
  };
}

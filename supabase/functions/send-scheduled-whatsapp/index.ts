import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireInternalAuth } from '../_shared/security.ts';
import { corsHeadersFor } from '../_shared/cors.ts';
import { prepareScheduledChannel } from '../_shared/whatsapp-send.ts';
import { repairAcceptedAutomation } from '../_shared/conversation-log.ts';
import { createTemplateRuntime } from '../_shared/whatsapp-template-runtime.ts';
import { createAutomationDispatcher, type AutomationDispatchIO } from '../_shared/whatsapp-automation-dispatch.ts';
import { hasUnitAccess } from '../_shared/authz.ts';

const url = Deno.env.get('SUPABASE_URL')!;
declare const EdgeRuntime: { waitUntil(work: Promise<unknown>): void };
const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const appBaseUrl = Deno.env.get('APP_BASE_URL') ?? 'https://reservas.moralles.com.br';
const readOne: AutomationDispatchIO['readOne'] = async (table, columns, predicates, latest) => {
  let query = db.from(table).select(columns);
  for (const [key, value] of Object.entries(predicates)) query = query.eq(key, value);
  if (latest) query = query.order(latest, { ascending: false }).limit(1);
  const result: { data: unknown; error: unknown } = await query.maybeSingle();
  if (result.error) throw new Error('dependency_unavailable');
  return result.data;
};
const dispatcher = createAutomationDispatcher({
  readOne, now: Date.now, appBaseUrl, allowedOrigins: [new URL(appBaseUrl).origin],
  rpc: async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error('dependency_unavailable');
    return data;
  },
  capture: async (jobId, fence, safeBody) => {
    const { data, error } = await db.from('whatsapp_automation_jobs').update({ safe_log_body: safeBody })
      .eq('id', jobId).eq('claim_token', fence).eq('state', 'claimed').is('posting_started_at', null)
      .is('provider_message_id', null).is('customer_erased_at', null).select('id');
    return !error && data?.length === 1 && data[0].id === jobId;
  },
  repairAccepted: jobId => repairAcceptedAutomation({ supabase: db, jobId }),
  prepareScheduledChannel: (unitId, channelId) => prepareScheduledChannel(channelId, unitId),
  defer: work => EdgeRuntime.waitUntil(work),
  observeTemplates: async accountId => {
    const result = await createTemplateRuntime(db).syncTemplateAccount(accountId);
    if (result.state !== 'synced') throw new Error('template_sync_failed');
    return result;
  },
});
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

serve(async req => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let value: unknown;
  try { value = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!record(value)) return json({ error: 'intent_invalid' }, 400);
  const body = value;
  try {
    if (body.action === 'dispatch_operator' || body.action === 'resend') {
      const operator = body.action === 'dispatch_operator';
      if (Object.keys(body).some(key => !['action','kind','resource_id','unit_id'].includes(key))
        || (operator ? body.kind !== 'cancellation' && body.kind !== 'waitlist_table_ready'
          : !['confirmation','waitlist_entered','cancellation','waitlist_table_ready'].includes(String(body.kind)))
        || !uuid(body.resource_id) || (body.unit_id !== undefined && !uuid(body.unit_id))
        || (!operator && !uuid(body.unit_id))) return json({ error: 'intent_invalid' }, 400);
      if (operator && !requireInternalAuth(req)) return json({ error: 'unauthorized' }, 401);
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!jwt) return json({ error: 'unauthorized' }, 401);
      const { data: auth, error: authError } = await db.auth.getUser(jwt);
      if (authError || !auth.user) return json({ error: 'unauthorized' }, 401);
      const table = body.kind === 'confirmation' || body.kind === 'cancellation' ? 'reservations' : 'waitlist';
      const resource = await readOne(table, 'id,unit_id', { id: body.resource_id });
      if (!record(resource) || resource.id !== body.resource_id || !uuid(resource.unit_id)
        || (body.unit_id !== undefined && body.unit_id !== resource.unit_id)) return json({ error: 'authorization_refused' }, 403);
      if (!(await hasUnitAccess(db, auth.user.id, resource.unit_id))) return json({ error: 'authorization_refused' }, 403);
      if (operator) return json(await dispatcher.dispatchOperatorIntent({ kind: body.kind as 'cancellation' | 'waitlist_table_ready',
        resourceId: body.resource_id, unitId: resource.unit_id }));
      const key = table === 'reservations' ? 'reservation_id' : 'waitlist_id';
      const existing = await readOne('whatsapp_automation_jobs', '*', { unit_id: resource.unit_id, kind: body.kind, [key]: resource.id });
      if (!record(existing) || !uuid(existing.id)) return json({ state: 'not_enqueued', jobId: null, reason: 'provenance_refused' });
      return json(await dispatcher.dispatchExistingJob(existing.id));
    }
    if (body.action === 'dispatch_existing' || body.action === 'dispatch' || body.action === 'enqueue') {
      if (!requireInternalAuth(req)) return json({ error: 'unauthorized' }, 401);
      if (body.action === 'enqueue') {
        if (Object.keys(body).sort().join(',') !== 'action,kind,outbox_id,resource_id,unit_id'
          || body.kind !== 'confirmation' || !uuid(body.resource_id) || !uuid(body.unit_id) || !uuid(body.outbox_id))
          return json({ error: 'intent_invalid' }, 400);
        return json(await dispatcher.enqueueScheduledIntent({ kind: 'confirmation', resourceId: body.resource_id,
          unitId: body.unit_id, outboxId: body.outbox_id }));
      }
      if (body.action === 'dispatch_existing') {
        if (Object.keys(body).some(key => !['action','job_id'].includes(key)) || !uuid(body.job_id)) return json({ error: 'intent_invalid' }, 400);
        return json(await dispatcher.dispatchExistingJob(body.job_id));
      }
      if (Object.keys(body).some(key => !['action','kind','resource_id','unit_id','outbox_id','target_date'].includes(key))
        || !uuid(body.resource_id) || (body.unit_id !== undefined && !uuid(body.unit_id))
        || (body.outbox_id !== undefined && !uuid(body.outbox_id))
        || (body.target_date !== undefined && (typeof body.target_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.target_date)))) return json({ error: 'intent_invalid' }, 400);
      const kind = body.kind;
      if (kind !== 'confirmation' && kind !== 'reminder_d1' && kind !== 'survey_d1' && kind !== 'waitlist_entered' && kind !== 'waitlist_feedback' && kind !== 'voucher_issued') return json({ error: 'intent_invalid' }, 400);
      return json(await dispatcher.dispatchScheduledIntent({ kind, resourceId: body.resource_id,
        unitId: typeof body.unit_id === 'string' ? body.unit_id : undefined,
        outboxId: typeof body.outbox_id === 'string' ? body.outbox_id : undefined,
        targetDate: typeof body.target_date === 'string' ? body.target_date : undefined }));
    }
    return json({ error: 'intent_invalid' }, 400);
  } catch { return json({ error: 'dependency_unavailable' }, 503); }
});

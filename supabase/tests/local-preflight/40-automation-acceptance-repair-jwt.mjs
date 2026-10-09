// Genuine GoTrue/PostgREST, only after MAIN READY and review of this exact script.
// Keys and genuine sessions remain in memory; no response/error bodies are printed.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = resolve(root, '.superpowers/sdd/2026-10-03-whatsapp-templates-programados/local-runtime');
const docker = 'C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const project = 'moralles-templates-20261003', container = `supabase_db_${project}`;
const base = 'http://127.0.0.1:55451';
function run(args, input) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.status !== 0) throw new Error('task40_own_local_process_failed');
  return result.stdout.trim();
}
if (process.argv.length !== 2 || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH) throw new Error('task40_override_refused');
if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}']))
  || run(['inspect','--format','{{ .State.Running }}',container]) !== 'true'
  || run(['inspect','--format','{{ .Name }}',container]) !== `/${container}`
  || run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container]) !== project
  || run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container]) !== '55452') throw new Error('task40_own_stack_required');
let keys;
try { keys = JSON.parse(readFileSync(resolve(runtime, 'secrets/local-status.json'), 'utf8')); }
catch { throw new Error('task40_local_key_read_failed'); }
if (keys.API_URL !== base || typeof keys.ANON_KEY !== 'string' || typeof keys.SERVICE_ROLE_KEY !== 'string') throw new Error('task40_loopback_keys_required');
const users = {};
let checks = 0;
function ok(condition, label) { if (!condition) throw new Error(`FAIL ${label}`); checks++; console.log(`GREEN ${label}`); }
function sql(statement) { return run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'], statement); }
async function http(path, role, method = 'POST', body) {
  const target = new URL(path, base);
  if (target.origin !== base || !['/auth/v1/','/rest/v1/'].some(prefix => target.pathname.startsWith(prefix))) throw new Error('task40_remote_refused');
  const key = role === 'service' ? keys.SERVICE_ROLE_KEY : keys.ANON_KEY;
  const token = role === 'service' || role === 'anon' ? key : users[role].token;
  const response = await fetch(target, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  if (response.status !== 204) { try { data = await response.json(); } catch { throw new Error('task40_response_invalid'); } }
  return { status: response.status, data };
}
const ids = Object.fromEntries(['org','unit','foreignOrg','foreignUnit','customer','reservation','channel','binding','job','fence'].map(key => [key, randomUUID()]));
const flagsBefore = sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value) order by key),'[]') from public.platform_flags");
try {
  for (const role of ['owner','gerente','operador','platform_admin','foreign_member','outsider']) {
    const email = `task40-${role}-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex');
    const created = await http('/auth/v1/admin/users','service','POST',{ email, password, email_confirm: true });
    ok(created.status === 200 && typeof created.data.id === 'string', `GoTrue create ${role}`);
    users[role] = { id: created.data.id };
    const login = await http('/auth/v1/token?grant_type=password','anon','POST',{ email, password });
    ok(login.status === 200 && typeof login.data.access_token === 'string', `genuine GoTrue login ${role}`);
    users[role].token = login.data.access_token;
  }
  sql(`begin;
    insert into public.organizations(id,name) values('${ids.org}','Task40'),('${ids.foreignOrg}','Task40 foreign');
    insert into public.units(id,organization_id,name) values('${ids.unit}','${ids.org}','Task40'),('${ids.foreignUnit}','${ids.foreignOrg}','Task40 foreign');
    insert into public.customers(id,organization_id,name,phone) values('${ids.customer}','${ids.org}','Synthetic','11999994040');
    insert into public.reservations(id,unit_id,customer_id) values('${ids.reservation}','${ids.unit}','${ids.customer}');
    insert into public.platform_admins values('${users.platform_admin.id}');
    ${['owner','gerente','operador'].map(role => `insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
    insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
    insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp());
    insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider) values('${ids.binding}','${ids.unit}','${ids.channel}','zapi');
    insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
    values('${ids.job}','${ids.unit}','${ids.org}','confirmation','${ids.reservation}','${ids.customer}','task40',clock_timestamp(),clock_timestamp()+interval '1 hour','${ids.channel}','zapi','${ids.binding}',1,'text','posting','${ids.fence}',clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Task40 frozen redacted');
    commit;`);
  ok(sql(`select not exists(select from public.unit_members where user_id='${users.platform_admin.id}')`) === 't', 'platform admin has no membership');
  const rpc = (name, args, role = 'service') => http(`/rest/v1/rpc/${name}`, role, 'POST', args);
  for (const role of ['anon',...Object.keys(users)]) {
    const denied = await rpc('reconcile_whatsapp_automation_acceptance', { p_job_id: ids.job }, role);
    ok([401,403].includes(denied.status) && denied.data.code === '42501', `${role} denied service-only repair RPC`);
    const write = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${ids.job}`, role, 'PATCH', { state: 'reconciled' });
    ok([401,403].includes(write.status) && write.data.code === '42501', `${role} cannot forge acceptance via REST`);
  }
  const absent = await rpc('reconcile_whatsapp_automation_acceptance', { p_job_id: ids.job });
  ok(absent.status === 200 && absent.data.state === 'not_accepted', 'posting without durable ID is not repaired');
  const finished = await rpc('finish_whatsapp_automation', { p_job_id: ids.job, p_fence: ids.fence,
    p_result: { outcome: 'accepted', reason: 'provider_accepted', provider_message_id: 'task40-native' } });
  ok(finished.status === 200 && finished.data === true, 'service actual durable finish');
  const repaired = await rpc('reconcile_whatsapp_automation_acceptance', { p_job_id: ids.job });
  ok(repaired.status === 200 && repaired.data.state === 'reconciled' && repaired.data.history === 'recorded', 'service actual atomic repair');
  sql(`insert into public.conversations(unit_id,customer_id,messages,contact_name,updated_at)
    values('${ids.unit}','${ids.customer}','[]','Task40 newer B',clock_timestamp()+interval '1 minute');`);
  ok(sql(`select contact_name='Task40 newer B' from public.conversations where unit_id='${ids.unit}' and customer_id='${ids.customer}' order by updated_at desc,id limit 1`) === 't', 'second legitimate conversation is newer before service repeat');
  const historyBefore = sql(`select jsonb_agg(to_jsonb(x) order by id) from public.conversations x where unit_id='${ids.unit}' and customer_id='${ids.customer}'`);
  const notificationBefore = sql(`select to_jsonb(x) from public.notifications_sent x where unit_id='${ids.unit}'`);
  const repeated = await rpc('reconcile_whatsapp_automation_acceptance', { p_job_id: ids.job });
  ok(repeated.status === 200 && repeated.data.state === 'reconciled' && repeated.data.history === 'recorded', 'service idempotent repair across legitimate conversations');
  ok(sql(`select (select count(*) from public.notifications_sent where unit_id='${ids.unit}')=1 and
    (select count(*) from public.conversations x cross join lateral jsonb_array_elements(x.messages) e
     where x.unit_id='${ids.unit}' and x.customer_id='${ids.customer}' and e->>'event_id'='automation:${ids.job}:accepted')=1`) === 't', 'actual notification and accepted event cardinality one across exact pair');
  ok(sql(`select jsonb_agg(to_jsonb(x) order by id) from public.conversations x where unit_id='${ids.unit}' and customer_id='${ids.customer}'`) === historyBefore, 'service repeat leaves both conversation rows and timestamps unchanged');
  ok(sql(`select to_jsonb(x) from public.notifications_sent x where unit_id='${ids.unit}'`) === notificationBefore, 'service repeat preserves original notification evidence');
  console.log(`${checks} genuine JWT/PostgREST checks; zero provider requests. Endpoint Request controls are separate.`);
} finally {
  sql(`delete from public.conversations where unit_id='${ids.unit}'; delete from public.notifications_sent where unit_id='${ids.unit}'; delete from public.whatsapp_automation_jobs where unit_id='${ids.unit}'; delete from public.whatsapp_template_bindings where id='${ids.binding}'; delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');`);
  for (const role of Object.keys(users)) {
    const result = await http(`/auth/v1/admin/users/${users[role].id}`,'service','DELETE');
    if (![200,204].includes(result.status)) throw new Error('task40_cleanup_failed');
  }
  // No flags are written; absence and exact JSON survive, rather than absent becoming present/null.
  ok(sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value) order by key),'[]') from public.platform_flags") === flagsBefore, 'original flag existence and JSON unchanged');
}

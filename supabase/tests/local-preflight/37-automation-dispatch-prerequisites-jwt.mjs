// Reproducible genuine GoTrue + PostgREST proof, ONLY the named disposable stack.
// Keys/passwords/JWTs stay in memory; never log response bodies or child errors.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = resolve(root, '.superpowers/sdd/2026-10-03-whatsapp-templates-programados/local-runtime');
const docker = 'C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const container = 'supabase_db_moralles-templates-20261003';
const base = 'http://127.0.0.1:55451';
function localProcess(args, input) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PGCLIENTENCODING: 'UTF8' }, windowsHide: true });
  if (result.status !== 0) throw new Error('own_local_process_failed');
  return result.stdout.trim();
}
// Validate identity and endpoints BEFORE the sole in-memory local-key read.
const project = localProcess(['inspect', '--format', '{{ index .Config.Labels "com.supabase.cli.project" }}', container]);
const port = localProcess(['inspect', '--format', '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}', container]);
const config = readFileSync(resolve(runtime, 'supabase/config.toml'), 'utf8');
if (project !== 'moralles-templates-20261003' || port !== '55452'
  || !/^project_id = "moralles-templates-20261003"$/m.test(config)
  || !/\[api\][\s\S]*?\nport = 55451\r?\n/.test(config)
  || new URL(base).hostname !== '127.0.0.1') throw new Error('own_project_loopback_required');
let keys;
try {
  keys = JSON.parse(readFileSync(resolve(runtime, 'secrets/local-status.json'), 'utf8'));
} catch {
  // JSON parse errors may quote source bytes. Never surface those bytes.
  throw new Error('own_local_key_file_unreadable');
}
if (keys.API_URL !== base || typeof keys.ANON_KEY !== 'string' || typeof keys.SERVICE_ROLE_KEY !== 'string') {
  throw new Error('own_local_key_shape_refused');
}
let checks = 0;
function ok(value, label) {
  if (!value) throw new Error(`FAIL: ${label}`);
  checks++;
  console.log(`GREEN: ${label}`);
}
function sql(statement) {
  return localProcess(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], statement);
}
const users = {};
async function http(path, role, method = 'POST', body, extraHeaders = {}) {
  const url = new URL(path, base);
  if (url.origin !== base || !['/auth/v1/', '/rest/v1/'].some(prefix => url.pathname.startsWith(prefix))) throw new Error('nonlocal_request_refused');
  const key = role === 'service' ? keys.SERVICE_ROLE_KEY : keys.ANON_KEY;
  const token = role === 'service' || role === 'anon' ? key : users[role].token;
  const started = performance.now();
  // Aborted/timed-out I/O throws; it can NEVER count as a received denial.
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('local_http_json_invalid'); }
  return { status: response.status, data, elapsed: performance.now() - started };
}
const rpc = (name, args, role = 'service') => http(`/rest/v1/rpc/${name}`, role, 'POST', args);
const o = randomUUID(), u = randomUUID(), c = randomUUID(), r = randomUUID();
const missingUnit = randomUUID(), missingReservation = randomUUID();
const ch = randomUUID(), a = randomUUID(), b = randomUUID(), t = randomUUID();
const run = Date.now();
const oldFlag = sql("select coalesce((select value::text from public.platform_flags where key='whatsapp_automation_dispatch'),'null')");
let fixtureCreated = false;
try {
  for (const role of ['owner', 'gerente', 'operador', 'platform_admin', 'outsider']) {
    const email = `task37-${role}-${run}@example.invalid`, password = randomBytes(24).toString('hex');
    const created = await http('/auth/v1/admin/users', 'service', 'POST', { email, password, email_confirm: true });
    ok(created.status === 200 && typeof created.data.id === 'string', `GoTrue creates synthetic ${role}`);
    users[role] = { id: created.data.id };
    const login = await http('/auth/v1/token?grant_type=password', 'anon', 'POST', { email, password });
    ok(login.status === 200 && typeof login.data.access_token === 'string', `genuine GoTrue login ${role}`);
    users[role].token = login.data.access_token;
  }
  sql(`begin;
    insert into public.organizations(id,name) values('${o}','Task37 synthetic');
    insert into public.units(id,organization_id,name) values('${u}','${o}','Task37'),('${missingUnit}','${o}','Task37 missing');
    insert into public.customers(id,organization_id,name,phone) values('${c}','${o}','Synthetic','11999993737');
    insert into public.reservations(id,unit_id,customer_id) values('${r}','${u}','${c}'),('${missingReservation}','${missingUnit}','${c}');
    insert into public.platform_admins values('${users.platform_admin.id}');
    ${['owner', 'gerente', 'operador'].map(role => `insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${u}','${role}');`).join('\n')}
    insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ch}','${u}','datafy','connected',true,clock_timestamp());
    insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('${a}','${o}','${run}',clock_timestamp());
    insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('${b}','${u}','${ch}','${a}','datafy',clock_timestamp());
    select set_config('request.jwt.claims','{"role":"authenticated","sub":"${users.platform_admin.id}"}',true);
    update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id='${b}';
    insert into public.whatsapp_automation_adoptions(unit_id,adopted_at) values('${missingUnit}',clock_timestamp());
    insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
    insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('${t}','${a}','res_lembrete_dia_v1',1,'pt_BR','res_lembrete_dia_v1',repeat('a',64),'UTILITY',1);
    select public.publish_whatsapp_template_sync('${a}',1,public.begin_whatsapp_template_sync('${a}'),jsonb_build_array(jsonb_build_object('id','${t}','remote_id','task37','name','res_lembrete_dia_v1','language','pt_BR','observed_hash',repeat('a',64),'effective_category','UTILITY','remote_status','APPROVED','quality','GREEN')));
    commit;`);
  fixtureCreated = true;
  const fact = new Date().toISOString(), expiry = new Date(Date.now() + 3600000).toISOString();
  const intent = { unit_id: u, kind: 'reminder_d1', reservation_id: r, source_event_key: 'task37-current', fact_at: fact, expires_at: expiry };
  const enqueued = await rpc('enqueue_whatsapp_automation', { p_intent: intent });
  ok(enqueued.status === 200 && typeof enqueued.data === 'string', 'service JWT real enqueue');
  const j = enqueued.data;
  const claimed = await rpc('claim_whatsapp_automation', { p_job_id: j });
  ok(claimed.status === 200 && claimed.data.state === 'claimed', 'service JWT real claim');
  const f = claimed.data.claim_token, e = claimed.data.sync_epoch;
  const args = { p_job_id: j, p_fence: f, p_generation: 1, p_consent_revision: null, p_sync_epoch: e };
  const endpoints = [
    ['enqueue_whatsapp_automation', { p_intent: intent }], ['claim_whatsapp_automation', { p_job_id: j }],
    ['requeue_whatsapp_automation', { p_job_id: j }], ['select_due_whatsapp_automations', { p_limit: 20 }],
    ['prepare_whatsapp_automation_post', args], ['confirm_whatsapp_automation_post', args],
    ['block_whatsapp_automation_preflight', { p_job_id: j, p_fence: f, p_reason: 'reservation_pending' }],
  ];
  for (const role of ['anon', 'owner', 'gerente', 'operador', 'platform_admin', 'outsider']) {
    for (const [name, body] of endpoints) {
      const response = await rpc(name, body, role);
      ok([401, 403].includes(response.status) && response.data.code === '42501', `${role} denied service RPC ${name}`);
    }
    const write = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, role, 'PATCH', { pin_phase: 'preconfiguration', initial_credential_revision: 99 });
    ok([401, 403].includes(write.status) && write.data.code === '42501', `${role} denied direct table pins`);
  }
  for (const role of ['anon', 'owner', 'gerente', 'operador', 'platform_admin', 'outsider', 'service']) {
    const privateCall = await rpc('consume_whatsapp_automation_pin_initialization', { p_job_id: j, p_old_pins: {}, p_new_pins: {} }, role);
    ok(privateCall.status === 404 && privateCall.data.code === 'PGRST202', `${role} cannot expose private permit RPC`);
    const privateTable = await http('/rest/v1/whatsapp_automation_pin_initialization_permits', role, 'POST', {}, { 'Content-Profile': 'app_private' });
    ok(privateTable.status === 406 && privateTable.data.code === 'PGRST106', `${role} cannot expose private schema`);
  }
  const blocked = await rpc('block_whatsapp_automation_preflight', { p_job_id: j, p_fence: f, p_reason: 'reservation_pending' });
  ok(blocked.status === 200 && blocked.data === true, 'service JWT real initial block');
  ok((await rpc('requeue_whatsapp_automation', { p_job_id: j })).data === true, 'service JWT same-job requeue');
  const reclaim = await rpc('claim_whatsapp_automation', { p_job_id: j });
  args.p_fence = reclaim.data.claim_token;
  ok((await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, 'service', 'PATCH', { safe_log_body: 'Task37 synthetic render' })).status === 200, 'service preparatory render');
  ok((await rpc('prepare_whatsapp_automation_post', args)).data === true, 'service JWT actual prepare positive');
  const before = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, 'service', 'GET');
  ok((await rpc('confirm_whatsapp_automation_post', args)).data === true, 'service JWT actual final confirm positive');
  const after = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, 'service', 'GET');
  ok(JSON.stringify(before.data) === JSON.stringify(after.data), 'real REST confirm byte readonly');
  for (const patch of [{ initial_credential_revision: 99 }, { initial_catalog_key: 'fila_entrada_v1' }, { consent_revision: 99 }, { cost_authorization_id: randomUUID() }, { posting_started_at: null }]) {
    const result = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, 'service', 'PATCH', patch);
    ok(result.status === 400 && result.data.code === '23514', `service direct forgery refused ${Object.keys(patch)[0]}`);
  }
  const missingIntent = { ...intent, unit_id: missingUnit, reservation_id: missingReservation };
  const missing = await rpc('enqueue_whatsapp_automation', { p_intent: missingIntent });
  ok(missing.status === 200 && typeof missing.data === 'string', 'service actual missing-configuration ledger');
  const forged = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${missing.data}`, 'service', 'PATCH', { pin_phase: 'bound', channel_id: ch, provider: 'datafy', binding_id: b, binding_generation: 1, account_id: a, transport: 'template', remote_template_id: t, template_version: 1, sync_epoch: e, initial_credential_revision: 0, state: 'queued' });
  ok(forged.status === 400 && forged.data.code === '23514', 'service cannot forge private initialization via REST');
  sql("update public.platform_flags set value='\"unknown\"' where key='whatsapp_automation_dispatch'");
  const dependency = await rpc('confirm_whatsapp_automation_post', args);
  ok(dependency.status === 503 && dependency.data.code === 'PT503' && dependency.data.message === 'automation_dependency_unavailable' && dependency.elapsed < 5000, `actual received PT503 status/body in ${Math.ceil(dependency.elapsed)}ms`);
  const afterFailure = await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${j}`, 'service', 'GET');
  ok(JSON.stringify(before.data) === JSON.stringify(afterFailure.data), 'PT503 transaction leaves original row unchanged');
  console.log(`${checks} genuine GoTrue/PostgREST checks GREEN; provider requests 0; public initializer not implemented or claimed`);
} finally {
  if (fixtureCreated) sql(`delete from public.whatsapp_automation_jobs where unit_id in('${u}','${missingUnit}'); delete from public.whatsapp_template_jobs where account_id='${a}'; delete from public.whatsapp_template_bindings where id='${b}'; delete from public.whatsapp_template_accounts where id='${a}'; delete from public.organizations where id='${o}'; update public.platform_flags set value='${oldFlag}'::jsonb where key='whatsapp_automation_dispatch';`);
  for (const user of Object.values(users)) if (user.id) {
    const response = await fetch(`${base}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}` } });
    if (!response.ok) throw new Error('local_synthetic_user_cleanup_failed');
  }
}

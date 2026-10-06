// Authored offline. Genuine GoTrue/PostgREST/SDK gate only after MAIN READY.
// No provider call; generated local keys and real sessions stay in memory.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const docker = 'C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const project = 'moralles-templates-20261003', container = `supabase_db_${project}`;
const base = 'http://127.0.0.1:55451';
function run(args, input) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.status !== 0) throw new Error('task43_own_local_process_failed');
  return result.stdout.trim();
}
if (process.argv.length !== 2 || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH)
  throw new Error('task43_override_refused');
if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}']))
  || run(['inspect','--format','{{ .State.Running }}',container]) !== 'true'
  || run(['inspect','--format','{{ .Name }}',container]) !== `/${container}`
  || run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container]) !== project
  || run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container]) !== '55452')
  throw new Error('task43_own_stack_required');
let keys;
try { keys = JSON.parse(readFileSync(resolve(root,'.superpowers/sdd/2026-10-03-whatsapp-templates-programados/local-runtime/secrets/local-status.json'),'utf8')); }
catch { throw new Error('task43_local_key_read_failed'); }
if (keys.API_URL !== base || typeof keys.ANON_KEY !== 'string' || typeof keys.SERVICE_ROLE_KEY !== 'string')
  throw new Error('task43_loopback_keys_required');
const users = {}, ids = Object.fromEntries(['org','unit','foreignOrg','foreignUnit','customer','reservation','channel','binding','job','fence'].map(key => [key,randomUUID()]));
let checks = 0;
function ok(condition,label) { if (!condition) throw new Error(`FAIL ${label}`); checks++; console.log(`GREEN ${label}`); }
const literal = value => `'${value.replaceAll("'","''")}'`;
function sql(statement) { return run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement); }
function target(path) {
  const url = new URL(path,base);
  if (url.origin !== base || !['/auth/v1/','/rest/v1/'].some(prefix => url.pathname.startsWith(prefix))) throw new Error('task43_remote_refused');
  return url;
}
async function http(path,role,method='POST',body,extra={}) {
  const key = role === 'service' ? keys.SERVICE_ROLE_KEY : keys.ANON_KEY;
  const token = role === 'service' || role === 'anon' ? key : users[role].token;
  const response = await fetch(target(path),{method,redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},
    body:body === undefined ? undefined : JSON.stringify(body)});
  let data=null;
  if (response.status !== 204) { try { data=await response.json(); } catch { throw new Error('task43_response_invalid'); } }
  return {status:response.status,data};
}
// SDK must use precisely this loopback REST origin; no automatic auth refresh.
const db = createClient(base,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,options) => {
  target(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
  return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
}}});
ok(sql("select array_agg(attname::text order by attname)=array['key','value'] from pg_attribute where attrelid='public.platform_flags'::regclass and attnum>0 and not attisdropped") === 't','known local flags shape');
const flagsBefore=sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'");
let failure;
try {
  for (const role of ['owner','gerente','operador','platform_admin','foreign_member','outsider']) {
    const email=`task43-${role}-${randomUUID()}@example.invalid`, password=randomBytes(24).toString('hex');
    const created=await http('/auth/v1/admin/users','service','POST',{email,password,email_confirm:true});
    ok(created.status === 200 && typeof created.data.id === 'string',`GoTrue create ${role}`);
    users[role]={id:created.data.id};
    const login=await http('/auth/v1/token?grant_type=password','anon','POST',{email,password});
    ok(login.status === 200 && typeof login.data.access_token === 'string',`genuine GoTrue login ${role}`);
    users[role].token=login.data.access_token;
  }
  sql(`begin;
    insert into public.organizations(id,name) values('${ids.org}','Task43'),('${ids.foreignOrg}','Task43 foreign');
    insert into public.units(id,organization_id,name,slug,timezone) values('${ids.unit}','${ids.org}','Task43','task43-${ids.unit}','america/sao_paulo'),('${ids.foreignUnit}','${ids.foreignOrg}','Foreign','task43-${ids.foreignUnit}','UTC');
    insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values('${ids.customer}','${ids.org}','Synthetic','55912345678',false,null);
    insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
      values('${ids.reservation}','${ids.unit}','${ids.customer}',(clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'23:59:00','confirmed',null,'web',4,'TASK43-${ids.reservation}',null,null);
    insert into public.platform_admins values('${users.platform_admin.id}');
    ${['owner','gerente','operador'].map(role => `insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
    insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
    insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp());
    select set_config('request.jwt.claims','{"role":"authenticated","sub":"${users.platform_admin.id}"}',true);
    insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values('${ids.binding}','${ids.unit}','${ids.channel}','zapi',clock_timestamp(),true);
    select set_config('request.jwt.claims','{"role":"service_role"}',true);
    insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
    insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
      values('${ids.job}','${ids.unit}','${ids.org}','confirmation','${ids.reservation}','${ids.customer}','task43',clock_timestamp(),clock_timestamp()+interval '7 days','${ids.channel}','zapi','${ids.binding}',1,'text','posting','${ids.fence}',clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Task43 frozen redacted');
    commit;`);
  ok(sql(`select not exists(select from public.unit_members where user_id='${users.platform_admin.id}')`) === 't','platform admin has no membership');
  async function row(table,columns,id) {
    const found=await http(`/rest/v1/${table}?select=${columns}&id=eq.${id}`,'service','GET');
    ok(found.status === 200 && Array.isArray(found.data) && found.data.length === 1,`actual PostgREST ${table} projection`);
    return found.data[0];
  }
  const expected={version:1,kind:'confirmation',
    resource:await row('reservations','id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,applied_discount_percent,satisfaction_rating',ids.reservation),
    customer:await row('customers','id,organization_id,name,phone,do_not_contact,deleted_at',ids.customer),
    unit:await row('units','id,organization_id,name,slug,timezone',ids.unit),rule:null,setting:{key:null,present:false,value:null}};
  ok(expected.resource.time === '23:59:00' && expected.customer.deleted_at === null && expected.unit.timezone === 'america/sao_paulo','actual time/null/raw IANA parity');
  const args={p_job_id:ids.job,p_fence:ids.fence,p_generation:1,p_consent_revision:null,p_sync_epoch:null,p_expected:expected};
  for (const role of ['anon',...Object.keys(users)]) {
    const denied=await http('/rest/v1/rpc/confirm_whatsapp_automation_resource_post',role,'POST',args);
    ok([401,403].includes(denied.status) && denied.data?.code === '42501',`${role} denied service-only resource RPC`);
  }
  const before=sql(`select to_jsonb(j) from public.whatsapp_automation_jobs j where id='${ids.job}'`);
  async function confirm(value,label,wanted) {
    const result=await db.rpc('confirm_whatsapp_automation_resource_post',{...args,p_expected:value});
    ok(result.error === null && result.data !== null && Object.keys(result.data).sort().join(',') === Object.keys(wanted).sort().join(',')
      && Object.entries(wanted).every(([key,value]) => result.data[key] === value),label);
    ok(sql(`select to_jsonb(j) from public.whatsapp_automation_jobs j where id='${ids.job}'`) === before,`${label} readonly`);
  }
  await confirm(expected,'actual SDK service positive closed result',{allowed:true});
  await confirm({...expected,resource:{...expected.resource,time:'23:59'}},'PostgREST typed time comparison',{allowed:true});
  for (const invalid of [null,{}, {...expected,extra:true},{...expected,resource:{...expected.resource,party_size:'4'}},{...expected,resource:{...expected.resource,date:'infinity'}}])
    await confirm(invalid,'service invalid input closed',{allowed:false,reason:'snapshot_invalid'});
  const wrongFence=await db.rpc('confirm_whatsapp_automation_resource_post',{...args,p_fence:randomUUID()});
  ok(wrongFence.error === null && wrongFence.data?.allowed === false && wrongFence.data?.reason === 'authority_changed' && Object.keys(wrongFence.data).length === 2,'service wrong fence closed');
  sql(`update public.reservations set source='whatsapp' where id='${ids.reservation}'`);
  await confirm(expected,'service current source drift proved',{allowed:false,reason:'resource_changed'});
  // Waitlist actual timestamptz serialization is read over REST, not a fabricated timestamp envelope.
  const waitId=randomUUID(), waitJob=randomUUID(), waitFence=randomUUID();
  sql(`insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at) values('${waitId}','${ids.unit}',null,'Synthetic','11912344343',4,43,'waiting',clock_timestamp(),null);`);
  const wait=await row('waitlist','id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at',waitId);
  ok(typeof wait.created_at === 'string' && Number.isFinite(Date.parse(wait.created_at)) && wait.seated_at === null,'actual PostgREST timestamptz/null parity');
  sql(`insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,waitlist_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
    values('${waitJob}','${ids.unit}','${ids.org}','waitlist_entered','${waitId}',null,'task43-wait',${literal(wait.created_at)}::timestamptz,${literal(wait.created_at)}::timestamptz+interval '2 hours','${ids.channel}','zapi','${ids.binding}',1,'text','posting','${waitFence}',clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Task43 frozen wait');`);
  const waitExpected={...expected,kind:'waitlist_entered',resource:wait,customer:null,setting:{key:'waitlist_entered_enabled',present:false,value:null}};
  const waitArgs={...args,p_job_id:waitJob,p_fence:waitFence,p_expected:waitExpected};
  const waitBefore=sql(`select to_jsonb(j) from public.whatsapp_automation_jobs j where id='${waitJob}'`);
  // Swap only the captured UTC suffix; keep every original fractional digit.
  // JS Date.toISOString truncates PostgreSQL microseconds and is not equality evidence.
  const utcStamp=/^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?)(Z|\+00:00)$/.exec(wait.created_at);
  ok(utcStamp !== null,'captured genuine UTC timestamp shape');
  const sameInstant=utcStamp[1]+(utcStamp[2] === 'Z' ? '+00:00' : 'Z');
  ok(sameInstant !== wait.created_at,'alternate UTC representation differs');
  ok(sql(`select ${literal(sameInstant)}::timestamptz=created_at from public.waitlist where id='${waitId}'`) === 't','alternate preserves exact SQL instant including microseconds');
  for (const stamp of [wait.created_at,sameInstant]) {
    const result=await db.rpc('confirm_whatsapp_automation_resource_post',{...waitArgs,p_expected:{...waitExpected,resource:{...wait,created_at:stamp}}});
    ok(result.error === null && result.data?.allowed === true && Object.keys(result.data).join(',') === 'allowed','actual SDK timestamptz/unknown operational customer equality');
    ok(sql(`select to_jsonb(j) from public.whatsapp_automation_jobs j where id='${waitJob}'`) === waitBefore,'timestamp confirm readonly');
  }
  // An actual SQL +1 microsecond controls a distinct instant, including second rollover.
  const differentInstant=sql(`select to_char((created_at+interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from public.waitlist where id='${waitId}'`);
  ok(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(differentInstant)
    && differentInstant !== sameInstant && differentInstant !== wait.created_at,'distinct timestamp retains typed full fractional syntax');
  ok(sql(`select ${literal(differentInstant)}::timestamptz=created_at+interval '1 microsecond' and ${literal(differentInstant)}::timestamptz<>created_at from public.waitlist where id='${waitId}'`) === 't','negative differs by exactly one SQL microsecond');
  const timestampDrift=await db.rpc('confirm_whatsapp_automation_resource_post',{...waitArgs,p_expected:{...waitExpected,resource:{...wait,created_at:differentInstant}}});
  ok(timestampDrift.error === null && timestampDrift.data?.allowed === false && timestampDrift.data?.reason === 'resource_changed'
    && Object.keys(timestampDrift.data).sort().join(',') === 'allowed,reason','different fractional instant returns closed resource_changed');
  ok(sql(`select to_jsonb(j) from public.whatsapp_automation_jobs j where id='${waitJob}'`) === waitBefore,'different timestamp confirm readonly');
  ok(sql(`select not has_function_privilege('anon','app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)','EXECUTE') and not has_function_privilege('authenticated','app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)','EXECUTE') and not has_function_privilege('service_role','app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)','EXECUTE')`) === 't','private overload not directly granted');
  for (const role of ['anon','owner','platform_admin','service']) {
    const hidden=await http('/rest/v1/rpc/whatsapp_automation_post_core',role,'POST',{...args,p_confirm_only:true},{'Content-Profile':'app_private'});
    ok(hidden.status === 406 && hidden.data?.code === 'PGRST106',`${role} private schema unexposed`);
  }
  console.log(`${checks} genuine JWT/PostgREST/SDK checks; zero provider requests.`);
} catch (error) { failure=error; } finally {
  const failures=[];
  try { sql(`delete from public.whatsapp_automation_jobs where unit_id='${ids.unit}'; delete from public.whatsapp_template_bindings where id='${ids.binding}'; delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');`); } catch { failures.push('fixture'); }
  for (const user of Object.values(users)) {
    try { const result=await http(`/auth/v1/admin/users/${user.id}`,'service','DELETE'); if (![200,204].includes(result.status)) failures.push('user'); }
    catch { failures.push('user'); }
  }
  try {
    sql(`begin; set local standard_conforming_strings=on; delete from public.platform_flags where key='whatsapp_automation_dispatch'; insert into public.platform_flags(key,value) select row_data->>'key',case when (row_data->>'value_is_sql_null')::boolean then null::jsonb else row_data->'value' end from jsonb_array_elements(${literal(flagsBefore)}::jsonb) as snapshot(row_data); commit;`);
    ok(sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'") === flagsBefore,'original flag absence/exact JSON restored');
  } catch { failures.push('flag'); }
  if (failures.length) { console.error('FAIL Task43 cleanup'); failure ??= new Error('task43_cleanup_failed'); }
}
if (failure) throw failure;

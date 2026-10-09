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
  if (result.status !== 0) throw new Error(`task47_own_local_process_failed_native_${result.status}`);
  return result.stdout.trim();
}
if (process.argv.length !== 2 || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || process.env.DOCKER_TLS_VERIFY || process.env.DOCKER_CERT_PATH)
  throw new Error('task47_override_refused');
if (run(['context','inspect','--format','{{ .Endpoints.docker.Host }}']) !== 'npipe:////./pipe/dockerDesktopLinuxEngine'
  || run(['inspect','--format','{{ .State.Running }}',container]) !== 'true'
  || run(['inspect','--format','{{ .Name }}',container]) !== `/${container}`
  || run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container]) !== project
  || run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container]) !== '55452')
  throw new Error('task47_own_stack_required');
let keys;
try { keys = JSON.parse(readFileSync(resolve(root,'.superpowers/sdd/2026-10-03-whatsapp-templates-programados/local-runtime/secrets/local-status.json'),'utf8')); }
catch { throw new Error('task47_local_key_read_failed'); }
if (keys.API_URL !== base || typeof keys.ANON_KEY !== 'string' || typeof keys.SERVICE_ROLE_KEY !== 'string')
  throw new Error('task47_loopback_keys_required');
const users = {}, ids = Object.fromEntries(['org','unit','foreignOrg','foreignUnit','customer','reservation','channel','binding','job','fence'].map(key => [key,randomUUID()]));
let checks = 0;
function ok(condition,label) { if (!condition) throw new Error(`FAIL ${label}`); checks++; console.log(`GREEN ${label}`); }
const literal = value => `'${value.replaceAll("'","''")}'`;
function sql(statement) { return run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement); }
function target(path) {
  const url = new URL(path,base);
  if (url.origin !== base || !['/auth/v1/','/rest/v1/'].some(prefix => url.pathname.startsWith(prefix))) throw new Error('task47_remote_refused');
  return url;
}
async function http(path,role,method='POST',body,extra={}) {
  const key = role === 'service' ? keys.SERVICE_ROLE_KEY : keys.ANON_KEY;
  const token = role === 'service' || role === 'anon' ? key : users[role].token;
  const response = await fetch(target(path),{method,redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},
    body:body === undefined ? undefined : JSON.stringify(body)});
  let data=null;
  if (response.status !== 204) { try { data=await response.json(); } catch { throw new Error('task47_response_invalid'); } }
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
    const email=`task47-${role}-${randomUUID()}@example.invalid`, password=randomBytes(24).toString('hex');
    const created=await http('/auth/v1/admin/users','service','POST',{email,password,email_confirm:true});
    ok(created.status === 200 && typeof created.data.id === 'string',`GoTrue create ${role}`);
    users[role]={id:created.data.id};
    const login=await http('/auth/v1/token?grant_type=password','anon','POST',{email,password});
    ok(login.status === 200 && typeof login.data.access_token === 'string',`genuine GoTrue login ${role}`);
    users[role].token=login.data.access_token;
  }
  sql(`begin;
    insert into public.organizations(id,name) values('${ids.org}','Task47'),('${ids.foreignOrg}','Foreign');
    insert into public.units(id,organization_id,name,slug,timezone) values('${ids.unit}','${ids.org}','Task47','task47-${ids.unit}','America/Sao_Paulo'),('${ids.foreignUnit}','${ids.foreignOrg}','Foreign','task47-${ids.foreignUnit}','America/Sao_Paulo');
    insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values('${ids.customer}','${ids.org}','Synthetic','55912345678',false,null);
    insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
      values('${ids.reservation}','${ids.unit}','${ids.customer}',current_date+1,'23:59','confirmed',null,'whatsapp',4,'TASK47-${ids.reservation}',null,null);
    insert into public.platform_admins values('${users.platform_admin.id}');
    ${['owner','gerente','operador'].map(role => `insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
    insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
    insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp());
    select set_config('request.jwt.claims','{"role":"authenticated","sub":"${users.platform_admin.id}"}',true);
    insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values('${ids.binding}','${ids.unit}','${ids.channel}','zapi',clock_timestamp(),true);
    select set_config('request.jwt.claims','{"role":"service_role"}',true);
    insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state)
      values('${ids.job}','${ids.unit}','${ids.org}','confirmation','${ids.reservation}','${ids.customer}','task47',clock_timestamp(),clock_timestamp()+interval '1 day','${ids.channel}','zapi','${ids.binding}',1,'text','queued');
    commit;`);
  ok(sql(`select not exists(select from public.unit_members where user_id='${users.platform_admin.id}')`) === 't','platform admin no membership');
  ok(sql(`select not exists(select from public.notification_outbox where reservation_id='${ids.reservation}')`) === 't','actual upstream source exclusion');
  const inserted=await http('/rest/v1/notification_outbox','service','POST',{reservation_id:ids.reservation,unit_id:ids.unit,kind:'confirmation'},{Prefer:'return=representation'});
  ok(inserted.status === 201 && inserted.data.length === 1,'service actual manual outbox INSERT');
  const outbox=inserted.data[0].id;
  const variants=[
    {reservation_id:ids.reservation,unit_id:ids.unit,kind:'confirmation'},
    {reservation_id:ids.reservation,unit_id:ids.foreignUnit,kind:'confirmation'},
    {reservation_id:randomUUID(),unit_id:ids.unit,kind:'confirmation'},
    {reservation_id:ids.reservation,unit_id:ids.unit,kind:'confirmation',automation_initial_token:randomUUID(),automation_job_id:ids.job},
  ];
  for (const role of ['anon',...Object.keys(users)]) {
    let refusal;
    for (const value of variants) {
      const result=await http('/rest/v1/notification_outbox',role,'POST',value);
      ok([401,403].includes(result.status) && result.data?.code === '42501',`${role} actual table privilege refusal`);
      refusal ??= result.data.message;
      ok(result.data.message === refusal && refusal === 'permission denied for table notification_outbox',`${role} matching/foreign/missing/markers no scope oracle`);
    }
  }
  for (const value of variants.slice(1)) {
    const result=await http('/rest/v1/notification_outbox','service','POST',value);
    ok(result.status === 403 && result.data?.code === '42501' && result.data.message === 'outbox_insert_refused','service companion guard negative');
  }
  const rpcs=[
    ['claim_notification_outbox_initial',{p_id:outbox}],
    ['delegate_notification_outbox_automation',{p_id:outbox,p_job_id:ids.job}],
    ['poll_notification_outbox_automation',{p_id:outbox}],
    ['defer_notification_outbox_automation_dependency',{p_id:outbox}],
    ['finish_notification_outbox_initial',{p_id:outbox,p_token:randomUUID()}],
    ['recover_delegated_notification_outbox',{p_limit:20}],
  ];
  for (const role of ['anon',...Object.keys(users)]) for (const [name,args] of rpcs) {
    const result=await http(`/rest/v1/rpc/${name}`,role,'POST',args);
    ok([401,403].includes(result.status) && result.data?.code === '42501',`${role} denied ${name}`);
  }
  ok(sql(`select automation_initial_token is null and automation_job_id is null from public.notification_outbox where id='${outbox}'`) === 't','JWT denials minted no marker');
  const cas=await db.from('notification_outbox').update({status:'processing',updated_at:'2099-01-01T00:00:00Z'})
    .eq('id',outbox).eq('status','pending').select('id,updated_at,automation_initial_token');
  ok(cas.error === null && cas.data.length === 1 && cas.data[0].automation_initial_token === null && Date.parse(cas.data[0].updated_at) < Date.parse('2099-01-01T00:00:00Z'),'actual SDK narrow CAS SQL clock');
  const early=await db.rpc('poll_notification_outbox_automation',{p_id:outbox});
  ok(early.error === null && early.data.reason === 'automation_initial_unclaimed' && early.data.outbox_status === 'processing','real DTO preserves initial email opportunity');
  const claim=await db.rpc('claim_notification_outbox_initial',{p_id:outbox});
  ok(claim.error === null && typeof claim.data === 'string' && /^[0-9a-f-]{36}$/.test(claim.data),'service wins initial owner');
  // The initial token stays in memory and is never logged, output, or used as delivery evidence.
  const token=claim.data;
  const loser=await db.rpc('claim_notification_outbox_initial',{p_id:outbox});
  ok(loser.error === null && loser.data === null,'second initial caller has no ownership');
  const pin=await db.rpc('delegate_notification_outbox_automation',{p_id:outbox,p_job_id:ids.job});
  ok(pin.error === null && pin.data === true,'service pins exact job');
  const forged=await db.from('notification_outbox').update({automation_job_id:randomUUID()}).eq('id',outbox);
  ok(forged.error?.code === '42501','SDK cannot forge replacement pin');
  const polled=await db.rpc('poll_notification_outbox_automation',{p_id:outbox});
  const dto={ledger_state:'queued',outbox_status:'pending',disposition:'pending',reason:'automation_queued',retry_after_seconds:60};
  ok(polled.error === null && Object.keys(polled.data).sort().join(',') === Object.keys(dto).sort().join(',')
    && Object.entries(dto).every(([key,value]) => polled.data[key] === value),'actual five-key SQL DTO');
  const before=sql(`select md5(to_jsonb(o)::text) from public.notification_outbox o where id='${outbox}'`);
  const wrong=await db.rpc('finish_notification_outbox_initial',{p_id:outbox,p_token:randomUUID()});
  ok(wrong.error === null && wrong.data === false && sql(`select md5(to_jsonb(o)::text) from public.notification_outbox o where id='${outbox}'`) === before,'wrong owner zero effects');
  for (const state of ['accepted','expired','failed']) {
    sql(`update public.whatsapp_automation_jobs set state='${state}',provider_message_id='task47-native' where id='${ids.job}'`);
    const finish=await db.rpc('finish_notification_outbox_initial',{p_id:outbox,p_token:token});
    ok(finish.error === null && finish.data === true,`original owner finishes current ${state}`);
    const observed=await db.rpc('poll_notification_outbox_automation',{p_id:outbox});
    ok(observed.error === null && observed.data.ledger_state === state && Object.keys(observed.data).length === 5
      && observed.data.disposition === ({accepted:'accepted',expired:'discarded',failed:'failed'})[state],`actual durable ${state} projection`);
  }
  const recovered=await db.rpc('recover_delegated_notification_outbox',{p_limit:0});
  ok(recovered.error === null && Array.isArray(recovered.data) && recovered.data.length === 0,'actual SETOF zero decoder');
  ok(sql(`select attempts=0 and automation_job_id='${ids.job}' from public.notification_outbox where id='${outbox}'`) === 't','attempts and historical pin preserved');
  ok(sql('select count(*)=0 from app_private.notification_outbox_mutation_permits') === 't','no orphan permits');
  for (const role of ['anon','owner','platform_admin','service']) {
    const hidden=await http('/rest/v1/notification_outbox_mutation_permits',role,'GET',undefined,{'Accept-Profile':'app_private'});
    ok(hidden.status === 406 && hidden.data?.code === 'PGRST106',`${role} private permits unexposed`);
  }
  console.log(`${checks} genuine JWT/PostgREST/SDK checks; zero provider requests.`);
} catch (error) { failure=error; } finally {
  const failures=[];
  try {
    sql(`update public.customers set deleted_at=clock_timestamp() where id='${ids.customer}' and deleted_at is null;
      delete from public.whatsapp_promotion_slots where unit_id='${ids.unit}';
      delete from public.whatsapp_automation_jobs where unit_id='${ids.unit}';
      delete from public.whatsapp_template_bindings where id='${ids.binding}';
      delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');`);
  } catch { failures.push('fixture'); }
  for (const user of Object.values(users)) {
    try { const result=await http(`/auth/v1/admin/users/${user.id}`,'service','DELETE'); if (![200,204].includes(result.status)) failures.push('user'); }
    catch { failures.push('user'); }
  }
  try {
    // Explicit typed restore distinguishes original absence, JSON null and SQL NULL.
    sql(`begin; set local standard_conforming_strings=on; delete from public.platform_flags where key='whatsapp_automation_dispatch'; insert into public.platform_flags(key,value) select row_data->>'key',case when (row_data->>'value_is_sql_null')::boolean then null::jsonb else row_data->'value' end from jsonb_array_elements(${literal(flagsBefore)}::jsonb) as snapshot(row_data); commit;`);
    ok(sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'") === flagsBefore,'exact original flags restored');
  } catch { failures.push('flag'); }
  if (failures.length) { console.error('FAIL Task47 cleanup'); failure ??= new Error('task47_cleanup_failed'); }
}
if (failure) throw failure;

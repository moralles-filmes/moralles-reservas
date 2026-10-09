// ROOT-only genuine GoTrue/PostgREST/SDK gate. Local credentials remain in memory.
// No provider transport, stub authentication, production endpoint or schema repair.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createClient} from '@supabase/supabase-js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const docker='C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const project='moralles-templates-20261003',container=`supabase_db_${project}`,base='http://127.0.0.1:55451';
function run(args,input){const r=spawnSync(docker,args,{input,encoding:'utf8',timeout:15000,windowsHide:true});if(r.status!==0)throw new Error(`task55_native_${r.status}`);return r.stdout.trim();}
if(process.argv.length!==2||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT||process.env.DOCKER_TLS_VERIFY||process.env.DOCKER_CERT_PATH)throw new Error('task55_override_refused');
if(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}'])!=='npipe:////./pipe/dockerDesktopLinuxEngine'
 ||run(['inspect','--format','{{ .State.Running }}',container])!=='true'
 ||run(['inspect','--format','{{ .Name }}',container])!==`/${container}`
 ||run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container])!==project
 ||run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container])!=='55452')throw new Error('task55_own_stack_required');
let keys;
try{keys=JSON.parse(readFileSync(resolve(root,'.superpowers/sdd/2026-10-03-whatsapp-templates-programados/local-runtime/secrets/local-status.json'),'utf8'));}
catch{throw new Error('task55_local_keys_unavailable');}
if(keys.API_URL!==base||typeof keys.ANON_KEY!=='string'||typeof keys.SERVICE_ROLE_KEY!=='string')throw new Error('task55_loopback_keys_required');
function target(path){const url=new URL(path,base);if(url.origin!==base||!['/auth/v1/','/rest/v1/'].some(p=>url.pathname.startsWith(p)))throw new Error('task55_remote_refused');return url;}
const users={},ids=Object.fromEntries(['org','foreignOrg','unit','foreignUnit','customer','channel','binding','reservation','job'].map(k=>[k,randomUUID()]));
const literal=value=>`'${value.replaceAll("'","''")}'`;
const sql=statement=>run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement);
let checks=0;
function ok(condition,label){if(!condition)throw new Error(`FAIL55 ${label}`);checks++;console.log(`GREEN55 ${label}`);}
async function http(path,role,method='POST',body,extra={}){
 const key=role==='service'?keys.SERVICE_ROLE_KEY:keys.ANON_KEY,token=role==='service'||role==='anon'?key:users[role].token;
 const response=await fetch(target(path),{method,redirect:'error',signal:AbortSignal.timeout(5000),
  headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
 let data=null;if(response.status!==204){try{data=await response.json();}catch{throw new Error('task55_invalid_response');}}
 return {status:response.status,data};
}
const db=createClient(base,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,options)=>{
 target(typeof url==='string'?url:url instanceof URL?url.href:url.url);return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
}}});
ok(sql("select not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) and not exists(select from net.http_request_queue)")==='t','persistent quarantine before fixtures');
let failure;
try {
 for(const role of ['owner','gerente','operador','platform_admin','foreign_member','outsider']) {
  const email=`task55-${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('hex');
  const created=await http('/auth/v1/admin/users','service','POST',{email,password,email_confirm:true});
  ok(created.status===200&&typeof created.data.id==='string',`GoTrue create ${role}`);users[role]={id:created.data.id};
  const login=await http('/auth/v1/token?grant_type=password','anon','POST',{email,password});
  ok(login.status===200&&typeof login.data.access_token==='string',`genuine login ${role}`);users[role].token=login.data.access_token;
 }
 sql(`begin;set local statement_timeout='10s';
  insert into public.organizations(id,name) values('${ids.org}','Task55'),('${ids.foreignOrg}','Task55 foreign');
  insert into public.units(id,organization_id,name) values('${ids.unit}','${ids.org}','Task55'),('${ids.foreignUnit}','${ids.foreignOrg}','Task55 foreign');
  insert into public.customers(id,organization_id,name,phone) values('${ids.customer}','${ids.org}','Synthetic','11999995555');
  insert into public.platform_admins values('${users.platform_admin.id}');
  ${['owner','gerente','operador'].map(role=>`insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
  insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp());
  insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values('${ids.binding}','${ids.unit}','${ids.channel}','zapi',1);
  select set_config('request.jwt.claims','{"role":"authenticated","sub":"${users.platform_admin.id}"}',true);
  insert into public.whatsapp_automation_adoptions(unit_id) values('${ids.unit}');
  insert into public.reservations(id,unit_id,customer_id) values('${ids.reservation}','${ids.unit}','${ids.customer}');
  insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
   values('${ids.job}','${ids.unit}','${ids.org}','confirmation','${ids.reservation}','${ids.customer}','task55:${ids.reservation}',clock_timestamp(),clock_timestamp()+interval '1 hour','${ids.channel}','zapi','${ids.binding}',1,'text','posting',gen_random_uuid(),clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Synthetic acceptance');
  select public.finish_whatsapp_automation(id,claim_token,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"task55-native"}') from public.whatsapp_automation_jobs where id='${ids.job}';
  commit;`);
 const revision=Number(sql(`select template_credential_revision from public.whatsapp_channels where id='${ids.channel}'`));
 const args={p_channel_id:ids.channel,p_unit_id:ids.unit,p_provider:'zapi',p_credential_revision:revision,p_external_instance_id:null,
  p_events:[{provider_message_id:'task55-native',status:'read',provider_timestamp:null}]};
 const rpcs=[['record_whatsapp_automation_receipts',args],['reconcile_whatsapp_automation_receipts',{p_job_id:ids.job,p_limit:20}],
  ['maintain_and_select_whatsapp_automation_work',{p_limit:20}],['purge_whatsapp_automation_workers',{p_receipt_limit:500,p_job_limit:20}]];
 for(const role of ['anon',...Object.keys(users)]) for(const [name,body] of rpcs) {
  const result=await http(`/rest/v1/rpc/${name}`,role,'POST',body);
  ok([401,403].includes(result.status)&&result.data?.code==='42501',`${role} denied ${name}`);
 }
 let result=await http('/rest/v1/rpc/record_whatsapp_automation_receipts','service','POST',args);
 ok(result.status===200&&result.data.state==='recorded'&&result.data.inserted===1,'service genuine recorder effect');
 result=await http('/rest/v1/rpc/record_whatsapp_automation_receipts','service','POST',args);
 ok(result.status===200&&result.data.inserted===0,'service duplicate stable digest');
 result=await http('/rest/v1/rpc/record_whatsapp_automation_receipts','service','POST',{...args,p_unit_id:ids.foreignUnit});
 ok(result.status===200&&result.data.state==='authority_changed','service forged tenant refused');
 result=await http('/rest/v1/rpc/reconcile_whatsapp_automation_receipts','service','POST',{p_job_id:ids.job,p_limit:20});
 ok(result.status===200&&result.data.state==='reconciled'&&result.data.processed===1,'service real acceptance and receipt repair');
 ok(sql(`select delivered_at is not null and read_at is not null and status='sent' from public.notifications_sent where unit_id='${ids.unit}' and provider_message_id='task55-native'`)==='t','actual notification effect');
 for(const role of ['owner','gerente','operador','platform_admin']) {
  const page=await http('/rest/v1/rpc/get_whatsapp_automation_delivery_state',role,'POST',{p_unit_id:ids.unit,p_limit:1,p_offset:0});
  ok(page.status===200&&page.data.version===1&&page.data.rows[0].job_id===ids.job,`${role} own read projection`);
  ok(!JSON.stringify(page.data).includes('task55-native')&&!JSON.stringify(page.data).includes('Synthetic acceptance'),`${role} no native id or render`);
 }
 ok(sql(`select not exists(select from public.unit_members where user_id='${users.platform_admin.id}')`)==='t','admin read without membership');
 for(const role of ['owner','gerente','operador','foreign_member','outsider']) {
  const forbidden=role==='foreign_member'||role==='outsider'?ids.unit:ids.foreignUnit;
  const foreign=await http('/rest/v1/rpc/get_whatsapp_automation_delivery_state',role,'POST',{p_unit_id:forbidden,p_limit:2147483647,p_offset:2147483647});
  const missing=await http('/rest/v1/rpc/get_whatsapp_automation_delivery_state',role,'POST',{p_unit_id:randomUUID(),p_limit:null,p_offset:null});
  ok(foreign.status===403&&missing.status===403&&foreign.data?.code==='42501'&&foreign.data.message===missing.data.message,`${role} uniform missing/foreign refusal before paging`);
 }
 for(const role of ['anon','service']) {
  const page=await http('/rest/v1/rpc/get_whatsapp_automation_delivery_state',role,'POST',{p_unit_id:ids.unit,p_limit:1,p_offset:0});
  ok([401,403].includes(page.status)&&page.data?.code==='42501',`${role} no read API EXECUTE`);
 }
 for(const table of ['whatsapp_automation_jobs','whatsapp_automation_receipt_events']) {
  const denied=await http(`/rest/v1/${table}?unit_id=eq.${ids.unit}`,'service','DELETE');
  ok(denied.status===403&&denied.data?.code==='42501',`service direct DELETE ${table} denied`);
  const read=await db.from(table).select('id').eq('unit_id',ids.unit);
  ok(!read.error&&read.data.length===1,`real SDK service SELECT ${table} remains`);
 }
 const denied=await http('/rest/v1/whatsapp_automation_receipt_events','service','POST',{unit_id:ids.unit,channel_id:ids.channel,provider:'zapi',provider_message_id:'bypass',status:'read',provider_timestamp:null,digest:'b'.repeat(64)});
 ok(denied.status===403&&denied.data?.code==='42501','direct service receipt INSERT denied');
 const unchanged=await db.from('whatsapp_automation_jobs').update({next_receipt_repair_at:null}).eq('id',ids.job).select('id');
 ok(!unchanged.error&&unchanged.data.length===1,'necessary service job UPDATE retained');
 result=await http('/rest/v1/rpc/maintain_and_select_whatsapp_automation_work','service','POST',{p_limit:20});
 ok(result.status===200&&result.data.version===1,'service allocator actual');
 result=await http('/rest/v1/rpc/purge_whatsapp_automation_workers','service','POST',{p_receipt_limit:0,p_job_limit:0});
 ok(result.status===200&&result.data.receipts_deleted===0&&result.data.jobs_deleted===0,'service bounded purge actual');
 console.log(`GREEN55 ${checks} genuine local Auth/PostgREST/SDK checks`);
} catch(error) { failure=error; }
finally {
 try {
  sql(`begin;set local statement_timeout='10s';delete from public.conversations where unit_id in('${ids.unit}','${ids.foreignUnit}');delete from public.notifications_sent where unit_id='${ids.unit}';delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');commit;`);
  for(const user of Object.values(users)) {const deleted=await http(`/auth/v1/admin/users/${user.id}`,'service','DELETE');if(deleted.status!==200)throw new Error('task55_user_cleanup');}
  ok(sql(`select not exists(select from public.whatsapp_automation_jobs where unit_id='${ids.unit}') and not exists(select from public.whatsapp_automation_receipt_events where unit_id='${ids.unit}') and not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))`)==='t','exact fixture cleanup and persistent quarantine');
 }catch(error){failure??=error;}
}
if(failure){console.error(failure instanceof Error?failure.message:'task55_failed');process.exit(1);}

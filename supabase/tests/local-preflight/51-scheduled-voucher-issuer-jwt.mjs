import { resolveLocalDocker } from './local-runtime-paths.mjs';
// ROOT-only genuine GoTrue/PostgREST/SDK gate. Local credentials remain in memory.
// No provider transport, stub authentication, production endpoint or schema repair.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createClient} from '@supabase/supabase-js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const docker=resolveLocalDocker();
const project='moralles-templates-20261003',container=`supabase_db_${project}`,base='http://127.0.0.1:55451';
function run(args,input){const r=spawnSync(docker,args,{input,encoding:'utf8',timeout:15000,windowsHide:true});if(r.status!==0)throw new Error(`task51_native_${r.status}`);return r.stdout.trim();}
if(process.argv.length!==2||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT||process.env.DOCKER_TLS_VERIFY||process.env.DOCKER_CERT_PATH)throw new Error('task51_override_refused');
if(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}'])!=='npipe:////./pipe/dockerDesktopLinuxEngine'
 ||run(['inspect','--format','{{ .State.Running }}',container])!=='true'
 ||run(['inspect','--format','{{ .Name }}',container])!==`/${container}`
 ||run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container])!==project
 ||run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container])!=='55452')throw new Error('task51_own_stack_required');
let keys;
try{keys=JSON.parse(readFileSync(resolve(root,'.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/secrets/local-status.json'),'utf8'));}
catch{throw new Error('task51_local_keys_unavailable');}
if(keys.API_URL!==base||typeof keys.ANON_KEY!=='string'||typeof keys.SERVICE_ROLE_KEY!=='string')throw new Error('task51_loopback_keys_required');
function target(path){const url=new URL(path,base);if(url.origin!==base||!['/auth/v1/','/rest/v1/'].some(p=>url.pathname.startsWith(p)))throw new Error('task51_remote_refused');return url;}
const users={},ids=Object.fromEntries(['org','foreignOrg','unit','foreignUnit','customer','otherCustomer','foreignCustomer','channel','binding','rule'].map(k=>[k,randomUUID()]));
const literal=value=>`'${value.replaceAll("'","''")}'`;
const sql=statement=>run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement);
let checks=0;
function ok(condition,label){if(!condition)throw new Error(`FAIL51 ${label}`);checks++;console.log(`GREEN51 ${label}`);}
async function http(path,role,method='POST',body,extra={}){
 const key=role==='service'?keys.SERVICE_ROLE_KEY:keys.ANON_KEY,token=role==='service'||role==='anon'?key:users[role].token;
 const response=await fetch(target(path),{method,redirect:'error',signal:AbortSignal.timeout(5000),
  headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
 let data=null;if(response.status!==204){try{data=await response.json();}catch{throw new Error('task51_invalid_response');}}
 return {status:response.status,data};
}
const db=createClient(base,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,options)=>{
 target(typeof url==='string'?url:url instanceof URL?url.href:url.url);return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});
}}});
ok(sql("select array_agg(attname::text order by attname)=array['key','value'] from pg_attribute where attrelid='public.platform_flags'::regclass and attnum>0 and not attisdropped")==='t','known local flags shape');
const flagsBefore=sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'");
let failure;
try{
 for(const role of ['owner','gerente','operador','platform_admin','foreign_member','outsider']){
  const email=`task51-${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('hex');
  const created=await http('/auth/v1/admin/users','service','POST',{email,password,email_confirm:true});
  ok(created.status===200&&typeof created.data.id==='string',`GoTrue create ${role}`);users[role]={id:created.data.id};
  const login=await http('/auth/v1/token?grant_type=password','anon','POST',{email,password});
  ok(login.status===200&&typeof login.data.access_token==='string',`genuine login ${role}`);users[role].token=login.data.access_token;
 }
 sql(`begin;set local statement_timeout='10s';
  insert into public.organizations(id,name) values('${ids.org}','Task51'),('${ids.foreignOrg}','Foreign');
  insert into public.units(id,organization_id,name,slug,timezone) values
   ('${ids.unit}','${ids.org}','Task51','task51-${ids.unit}','America/Sao_Paulo'),('${ids.foreignUnit}','${ids.foreignOrg}','Foreign','task51-${ids.foreignUnit}','America/Sao_Paulo');
  insert into public.customers(id,organization_id,name,phone,birthday,do_not_contact,deleted_at) values
   ('${ids.customer}','${ids.org}','Synthetic','55912345678','1990-01-01',false,null),('${ids.otherCustomer}','${ids.org}','Other','11912345678','1990-01-01',false,null),
   ('${ids.foreignCustomer}','${ids.foreignOrg}','Foreign','21912345678','1990-01-01',false,null);
  insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at)
   values('${ids.rule}','${ids.unit}','Task51','birthday',15,30,null,null,null,true,clock_timestamp(),clock_timestamp());
  insert into public.platform_admins values('${users.platform_admin.id}');
  ${['owner','gerente','operador'].map(role=>`insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
  insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp());
  select set_config('request.jwt.claims','{"role":"authenticated","sub":"${users.platform_admin.id}"}',true);
  insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values('${ids.binding}','${ids.unit}','${ids.channel}','zapi',clock_timestamp(),true);
  insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','false') on conflict(key) do update set value=excluded.value;
  commit;`);
 ok(sql(`select not exists(select from public.unit_members where user_id='${users.platform_admin.id}')`)==='t','platform admin without pseudo-membership');
 const expected={unit_id:ids.unit,trigger_type:'birthday',discount_percent:15,validity_days:30,visits_required:null,days_window:null,
  selected_brt_day:sql("select ((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date")};
 const params={p_rule_id:ids.rule,p_customer_id:ids.customer,p_code:'TASK51-CODE',p_expected_rule:expected};
 const variants=[params,{...params,p_customer_id:ids.foreignCustomer},{...params,p_customer_id:randomUUID()},
  {...params,p_rule_id:randomUUID()},{...params,p_expected_rule:{...expected,unit_id:ids.foreignUnit}}];
 for(const role of ['anon',...Object.keys(users)]){
  let refusal;
  for(const body of variants){
   const result=await http('/rest/v1/rpc/issue_scheduled_whatsapp_voucher',role,'POST',body);
   ok([401,403].includes(result.status)&&result.data?.code==='42501',`${role} no issuer EXECUTE`);
   refusal??=result.data.message;
   ok(result.data.message===refusal&&refusal==='permission denied for function issue_scheduled_whatsapp_voucher',`${role} matching/foreign/missing same refusal`);
  }
 }
 const artifactCounts=()=>sql(`select jsonb_build_array((select count(*) from public.vouchers where unit_id='${ids.unit}'),(select count(*) from public.whatsapp_automation_jobs where unit_id='${ids.unit}'))::text`);
 ok(artifactCounts()==='[0, 0]','all public JWT negatives have zero effects');
 for(const [body,state] of [[variants[1],'42501'],[variants[2],'42501'],[variants[4],'22023'],
  [{...params,p_expected_rule:{...expected,discount_percent:'15'}},'22023'],
  [{...params,p_expected_rule:{...expected,eligible:true}},'22023']]){
  const result=await db.rpc('issue_scheduled_whatsapp_voucher',body);
  ok(result.error?.code===state&&artifactCounts()==='[0, 0]',`service scope/assertion negative ${state}`);
 }
 const result=await db.rpc('issue_scheduled_whatsapp_voucher',params);
 ok(result.error===null&&Array.isArray(result.data)&&result.data.length===1,'service actual SDK issuer succeeds');
 const row=result.data[0];
 ok(Object.keys(row).sort().join(',')==='code,created_at,customer_id,discount_percent,expires_at,issued_at,job_id,rule_id,status,unit_id,voucher_id','exact eleven-key PostgREST row');
 const persisted=await db.from('vouchers').select('id,unit_id,rule_id,customer_id,code,discount_percent,status,issued_at,created_at,expires_at').eq('id',row.voucher_id).single();
 ok(persisted.error===null&&Object.entries(persisted.data).every(([key,value])=>value===row[key==='id'?'voucher_id':key]),'every returned voucher field is stored, no regenerated benefit');
 const ledger=await db.from('whatsapp_automation_jobs').select('*').eq('id',row.job_id).single();
 ok(ledger.error===null&&ledger.data.voucher_id===row.voucher_id&&ledger.data.unit_id===ids.unit&&ledger.data.customer_id===ids.customer
  &&ledger.data.fact_at===row.created_at&&ledger.data.source_event_key===row.voucher_id&&Date.parse(ledger.data.expires_at)-Date.parse(row.created_at)===604800000
  &&ledger.data.state==='paused','actual committed same ledger, fixed168h, globalOFF preserved');
 const duplicate=await db.rpc('issue_scheduled_whatsapp_voucher',{...params,p_code:'TASK51-RETRY'});
 const collision=await db.rpc('issue_scheduled_whatsapp_voucher',{...params,p_customer_id:ids.otherCustomer});
 ok(duplicate.error===null&&Array.isArray(duplicate.data)&&duplicate.data.length===0&&collision.error===null&&collision.data.length===0
  &&artifactCounts()==='[1, 1]','actual zero-row natural-key and global-code responses; one pair');
 for(const role of ['anon','owner','platform_admin','service']){
  const hidden=await http('/rest/v1/rpc/whatsapp_automation_post_core',role,'POST',{}, {'Content-Profile':'app_private'});
  ok(hidden.status===406&&hidden.data?.code==='PGRST106',`${role} private core unexposed`);
 }
 console.log(`${checks} genuine JWT/PostgREST/SDK checks; no real provider or delivery claim.`);
}catch(error){failure=error;}finally{
 const failures=[];
 try{sql(`begin;set local statement_timeout='10s';update public.customers set deleted_at=clock_timestamp() where id in('${ids.customer}','${ids.otherCustomer}') and deleted_at is null;
  delete from public.whatsapp_promotion_slots where unit_id='${ids.unit}';delete from public.whatsapp_automation_jobs where unit_id='${ids.unit}';
  delete from public.vouchers where unit_id='${ids.unit}';delete from public.voucher_rules where unit_id='${ids.unit}';
  delete from public.whatsapp_template_bindings where id='${ids.binding}';delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');commit;`);}catch{failures.push('fixture');}
 for(const user of Object.values(users)){try{const result=await http(`/auth/v1/admin/users/${user.id}`,'service','DELETE');if(![200,204].includes(result.status))failures.push('user');}catch{failures.push('user');}}
 try{sql(`begin;set local standard_conforming_strings=on;delete from public.platform_flags where key='whatsapp_automation_dispatch';
  insert into public.platform_flags(key,value) select data->>'key',case when (data->>'value_is_sql_null')::boolean then null::jsonb else data->'value' end
  from jsonb_array_elements(${literal(flagsBefore)}::jsonb) as snapshot(data);commit;`);
  ok(sql("select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'")===flagsBefore,'exact flags restored');}catch{failures.push('flag');}
 if(failures.length){console.error('FAIL51 cleanup');failure??=new Error('task51_cleanup_failed');}
}
if(failure)throw failure;

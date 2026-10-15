import { resolveLocalDocker } from './local-runtime-paths.mjs';
// ROOT-only genuine GoTrue/PostgREST/SDK proof. Keys stay in this process.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const docker=resolveLocalDocker();
const project='moralles-templates-20261003',container=`supabase_db_${project}`,base='http://127.0.0.1:55451';
function run(args,input){const r=spawnSync(docker,args,{input,encoding:'utf8',timeout:20000,windowsHide:true});if(r.status!==0)throw new Error(`task59_native_${r.status}`);return r.stdout.trim();}
if(process.argv.length!==2||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT||process.env.DOCKER_TLS_VERIFY||process.env.DOCKER_CERT_PATH)throw new Error('task59_override_refused');
if(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}'])!=='npipe:////./pipe/dockerDesktopLinuxEngine'
 ||run(['inspect','--format','{{ .State.Running }}',container])!=='true'
 ||run(['inspect','--format','{{ .Name }}',container])!==`/${container}`
 ||run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container])!==project
 ||run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container])!=='55452')throw new Error('task59_own_stack_required');
const config=readFileSync(resolve(root,'.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/supabase/config.toml'),'utf8');
if(!/^project_id\s*=\s*"moralles-templates-20261003"\s*$/m.test(config)||!/\[api\][\s\S]*?\bport\s*=\s*55451\b/.test(config)||!/\[db\][\s\S]*?\bport\s*=\s*55452\b/.test(config)
 ||run(['inspect','--format','{{ .State.Running }}',`supabase_kong_${project}`])!=='true'
 ||run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',`supabase_kong_${project}`])!==project
 ||run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort }}',`supabase_kong_${project}`])!=='55451')throw new Error('task59_local_config_required');
const sql=statement=>run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement);
if(sql("select not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) and not exists(select from net.http_request_queue)")!=='t')throw new Error('task59_quarantine_required');
const health=await fetch(`${base}/auth/v1/health`,{redirect:'error',signal:AbortSignal.timeout(5000)});
if(!health.ok)throw new Error('task59_gotrue_not_ready');
let keys;
try{keys=JSON.parse(readFileSync(resolve(root,'.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/secrets/local-status.json'),'utf8'));}
catch{throw new Error('task59_local_keys_unavailable');}
if(keys.API_URL!==base||typeof keys.ANON_KEY!=='string'||typeof keys.SERVICE_ROLE_KEY!=='string')throw new Error('task59_loopback_keys_required');
function target(path){const url=new URL(path,base);if(url.origin!==base||!['/auth/v1/','/rest/v1/'].some(p=>url.pathname.startsWith(p)))throw new Error('task59_remote_refused');return url;}
const safeFetch=(url,options)=>{target(typeof url==='string'?url:url instanceof URL?url.href:url.url);return fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(5000)});};
const users={},ids=Object.fromEntries(['org','foreignOrg','unit','sibling','foreignUnit','customer','foreignCustomer','deletedCustomer','channel','datafy','account','binding','reservation','initialJob','boundReservation','boundJob','catalogJob','template'].map(k=>[k,randomUUID()]));
const literal=value=>`'${value.replaceAll("'","''")}'`;
let checks=0;
function ok(condition,label){if(!condition)throw new Error(`FAIL59 ${label}`);checks++;console.log(`GREEN59 ${label}`);}
async function http(path,role,method='POST',body){
 const key=role==='service'?keys.SERVICE_ROLE_KEY:keys.ANON_KEY,token=role==='service'||role==='anon'?key:users[role].token;
 const response=await safeFetch(target(path),{method,headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 let data=null;if(response.status!==204){try{data=await response.json();}catch{throw new Error('task59_invalid_response');}}
 return {status:response.status,data};
}
const rpc=(name,role,args)=>http(`/rest/v1/rpc/${name}`,role,'POST',args);
const db=createClient(base,keys.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:safeFetch}});
const previousWindow=Number(sql('select window_days from app_private.whatsapp_promotion_policy where singleton'));
if(!Number.isInteger(previousWindow)||previousWindow<1||previousWindow>30)throw new Error('task59_policy_baseline_required');
let failure;
try {
 for(const role of ['owner','gerente','operador','platform_admin','foreign_member','outsider']) {
  const email=`task59-${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('hex');
  const created=await http('/auth/v1/admin/users','service','POST',{email,password,email_confirm:true});
  ok(created.status===200&&typeof created.data.id==='string',`GoTrue create ${role}`);users[role]={id:created.data.id};
  const login=await http('/auth/v1/token?grant_type=password','anon','POST',{email,password});
  ok(login.status===200&&typeof login.data.access_token==='string',`genuine login ${role}`);users[role].token=login.data.access_token;
 }
 sql(`begin;set local statement_timeout='15s';
  insert into public.organizations(id,name) values('${ids.org}','Task59'),('${ids.foreignOrg}','Task59 foreign');
  insert into public.units(id,organization_id,name) values('${ids.unit}','${ids.org}','Task59'),('${ids.sibling}','${ids.org}','Task59 sibling'),('${ids.foreignUnit}','${ids.foreignOrg}','Task59 foreign');
  insert into public.customers(id,organization_id,name,phone) values('${ids.customer}','${ids.org}','Synthetic','11999995959'),('${ids.foreignCustomer}','${ids.foreignOrg}','Synthetic foreign','11999995959'),('${ids.deletedCustomer}','${ids.org}','Synthetic erased','11999995958');
  update public.customers set deleted_at=clock_timestamp() where id='${ids.deletedCustomer}';
  insert into public.platform_admins values('${users.platform_admin.id}');
  ${['owner','gerente','operador'].map(role=>`insert into public.unit_members(user_id,unit_id,role) values('${users[role].id}','${ids.unit}','${role}');`).join('\n')}
  insert into public.unit_members(user_id,unit_id,role) values('${users.foreign_member.id}','${ids.foreignUnit}','owner');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,webhook_secret) values('${ids.channel}','${ids.unit}','zapi','connected',true,clock_timestamp(),'synthetic-task59-channel');
  insert into public.reservations(id,unit_id,customer_id) values('${ids.reservation}','${ids.unit}','${ids.customer}');
  insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,transport,pin_phase,initial_credential_revision,initial_catalog_key,state,error_code)
   values('${ids.initialJob}','${ids.unit}','${ids.org}','confirmation','${ids.reservation}','${ids.customer}','task59-initialize',clock_timestamp(),clock_timestamp()+interval '1 hour','${ids.channel}','zapi','text','preconfiguration',0,'res_confirmacao_v1','blocked','binding_unconfigured');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values('${ids.datafy}','${ids.unit}','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"5901"}','synthetic-task59-datafy');
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('${ids.account}','${ids.org}','5900000000001',clock_timestamp());
  insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('${ids.binding}','${ids.unit}','${ids.datafy}','${ids.account}','datafy',clock_timestamp());
  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('${ids.template}','${ids.account}','res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1','${'b'.repeat(64)}','UTILITY',1);
  insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,operation,target_key,state,error_code) values('${ids.catalogJob}','${ids.org}','${ids.account}','${ids.binding}',1,'provision','res_confirmacao_v1','needs_review','binding_changed');
  commit;`);
 const release={p_channel_id:ids.channel,p_scope:'dispatch',p_enabled:true,p_expected_credential_revision:0,p_expected_binding_generation:null};
 const initial={p_job_id:ids.initialJob,p_expected_channel_id:ids.channel,p_expected_binding_generation:1};
 const consent={p_unit_id:ids.unit,p_customer_id:ids.customer,p_purpose:'promotional'};
 const record={...consent,p_decision:'opt_in',p_source_code:'in_person',p_observed_at:new Date().toISOString(),p_evidence_reference:'synthetic individual reference'};
 const cost={p_channel_id:ids.datafy,p_expected_binding_generation:1,p_category:'MARKETING',p_valid_from:new Date().toISOString(),p_valid_until:new Date(Date.now()+3600000).toISOString()};
 const interfaces=[['get_whatsapp_message_consent_state',consent],['record_whatsapp_message_consent',record],['release_whatsapp_template_channel',release],['request_whatsapp_template_sync_for_channel',{p_channel_id:ids.datafy,p_expected_binding_generation:1}],['initialize_whatsapp_automation_job',initial],['revalidate_whatsapp_automation_job',initial],['revalidate_whatsapp_template_job',{p_job_id:ids.catalogJob,p_expected_channel_id:ids.datafy,p_expected_binding_generation:1}],['authorize_whatsapp_marketing_cost',cost],['configure_whatsapp_promotion_frequency',{p_window_days:7}]];
 for(const role of ['anon','service','operador','outsider','foreign_member']) for(const [name,args] of interfaces) {
  const result=await rpc(name,role,args);
  ok([401,403].includes(result.status)&&result.data?.code==='42501',`${role} denied ${name}`);
 }
 for(const role of ['owner','gerente']) for(const [name,args] of interfaces.filter(([name])=>['release_whatsapp_template_channel','initialize_whatsapp_automation_job','revalidate_whatsapp_template_job','authorize_whatsapp_marketing_cost','configure_whatsapp_promotion_frequency'].includes(name))) {
  const result=await rpc(name,role,args);ok(result.status===403&&result.data?.code==='42501',`${role} denied administrative ${name}`);
 }
 for(const role of ['owner','gerente','platform_admin']) {
  const result=await rpc('get_whatsapp_message_consent_state',role,consent);
  ok(result.status===200&&result.data?.purpose==='promotional'&&result.data?.status==='unknown'&&result.data?.revision===null&&Object.keys(result.data).sort().join(',')==='purpose,revision,status',`${role} real selected absence`);
 }
 for(const p_customer_id of [ids.foreignCustomer,ids.deletedCustomer,randomUUID()]) {
  const result=await rpc('get_whatsapp_message_consent_state','owner',{...consent,p_customer_id});
  ok(result.status===403&&result.data?.code==='42501','uniform foreign deleted missing selected contact');
 }
 let result=await rpc('get_whatsapp_message_consent_state','owner',{...consent,p_unit_id:ids.sibling});
 ok(result.status===403&&result.data?.code==='42501','same organization still needs selected unit membership');
 result=await rpc('record_whatsapp_message_consent','owner',record);ok(result.status===200&&result.data===1,'owner genuine individual record');
 result=await rpc('record_whatsapp_message_consent','gerente',{...record,p_decision:'opt_out'});ok(result.status===200&&result.data===2,'gerente next optout');
 result=await rpc('get_whatsapp_message_consent_state','platform_admin',consent);ok(result.status===200&&result.data.status==='opt_out'&&result.data.revision===2,'admin without membership latest optout');
 ok(sql(`select actor_id='${users.gerente.id}' from public.whatsapp_message_consent_events where unit_id='${ids.unit}' and customer_id='${ids.customer}' and purpose='promotional' order by revision desc limit 1`)==='t','stored real actor from JWT');
 for(const p_source_code of ['preference_link','bulk','reservation']) {result=await rpc('record_whatsapp_message_consent','owner',{...record,p_source_code});ok(result.status===400&&result.data?.code==='22023','closed manual origin');}
 result=await rpc('record_whatsapp_message_consent','owner',{...record,p_actor_id:users.platform_admin.id});ok(result.status>=400,'extra forged actor signature unavailable');
 result=await rpc('release_whatsapp_template_channel','platform_admin',release);ok(result.status===200&&result.data===true,'real admin TEXT bootstrap');
 result=await rpc('initialize_whatsapp_automation_job','platform_admin',initial);ok(result.status===200&&result.data===true,'real admin initializer');
 result=await rpc('initialize_whatsapp_automation_job','platform_admin',initial);ok(result.status===200&&result.data===false,'initializer one use');
 sql(`update public.whatsapp_automation_jobs set state='needs_review',error_code='binding_changed' where id='${ids.initialJob}';`);
 result=await rpc('revalidate_whatsapp_automation_job','owner',initial);ok(result.status===200&&result.data===true,'real owner bound revalidator');
 sql(`update public.whatsapp_automation_jobs set state='blocked',error_code='channel_unavailable' where id='${ids.initialJob}';`);
 result=await rpc('revalidate_whatsapp_automation_job','gerente',initial);ok(result.status===200&&result.data===true,'real gerente bound revalidator');
 result=await rpc('release_whatsapp_template_channel','platform_admin',{...release,p_channel_id:ids.datafy,p_scope:'catalog',p_expected_binding_generation:1});ok(result.status===200&&result.data===true,'real catalog independent grant');
 result=await rpc('authorize_whatsapp_marketing_cost','platform_admin',cost);ok(result.status===200&&typeof result.data==='string','real explicit current cost grant');
 result=await rpc('configure_whatsapp_promotion_frequency','platform_admin',{p_window_days:7});ok(result.status===200&&result.data===7,'real admin frequency');
 result=await rpc('request_whatsapp_template_sync_for_channel','owner',{p_channel_id:ids.datafy,p_expected_binding_generation:1});ok(result.status===200&&result.data===null,'confirmed catalog OFF sync unavailable');
 result=await rpc('revalidate_whatsapp_template_job','platform_admin',{p_job_id:ids.catalogJob,p_expected_channel_id:ids.datafy,p_expected_binding_generation:1});ok(result.status===200&&result.data===false,'admin cannot invent zeroPOST proof');
 // No provider transport: the real SQL prepare and local finisher create the proof.
 sql(`begin;set local statement_timeout='15s';
  create temp table task59_flag_before on commit drop as select value from public.platform_flags where key='whatsapp_template_catalog';
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),last_sync_published_at=clock_timestamp(),sync_binding_id='${ids.binding}',sync_binding_generation=1,sync_credential_revision=0 where id='${ids.account}';
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp() where id='${ids.template}';
  update public.whatsapp_template_jobs set state='queued',error_code=null where id='${ids.catalogJob}';
  do $$ declare f uuid; begin
   f:=(public.claim_whatsapp_template_job('${ids.catalogJob}')->>'claim_token')::uuid;
   if not public.prepare_whatsapp_template_provision('${ids.catalogJob}',f,1) then raise exception 'FAIL59 initial prepare';end if;
   if not public.finish_whatsapp_template_job('${ids.catalogJob}',f,'{"outcome":"local_preflight_refused","reason":"final_channel_changed"}') then raise exception 'FAIL59 local refusal';end if;
  end $$;
  update public.platform_flags set value=(select value from task59_flag_before) where key='whatsapp_template_catalog';commit;`);
 result=await rpc('revalidate_whatsapp_template_job','platform_admin',{p_job_id:ids.catalogJob,p_expected_channel_id:ids.datafy,p_expected_binding_generation:1});ok(result.status===200&&result.data===true,'genuine admin catalog correction with real zeroPOST proof');
 result=await rpc('revalidate_whatsapp_template_job','platform_admin',{p_job_id:ids.catalogJob,p_expected_channel_id:ids.datafy,p_expected_binding_generation:1});ok(result.status===200&&result.data===false,'genuine catalog correction one use');
 for(const table of ['whatsapp_message_consent_events','whatsapp_automation_adoptions','whatsapp_template_cost_authorizations']) for(const role of ['owner','platform_admin','anon']) {
  result=await http(`/rest/v1/${table}?limit=1`,role,'GET');ok(result.status>=400,'no direct client authority table read');
 }
 for(const role of ['owner','platform_admin','service']) {
  const key=role==='service'?keys.SERVICE_ROLE_KEY:keys.ANON_KEY,token=role==='service'?key:users[role].token;
  const privateRead=await safeFetch(target('/rest/v1/whatsapp_template_zero_post_evidence?limit=1'),{headers:{apikey:key,Authorization:`Bearer ${token}`,'Accept-Profile':'app_private'}});
  ok(privateRead.status>=400,'private schema and evidence not exposed');
 }
 for(const role of ['owner','platform_admin','anon']) {
  result=await http(`/rest/v1/whatsapp_template_bindings?channel_id=eq.${ids.channel}`,role,'PATCH',{dispatch_enabled:false});ok(result.status>=400,'no direct client binding write');
 }
 result=await http(`/rest/v1/whatsapp_automation_jobs?id=eq.${ids.initialJob}`,'service','PATCH',{binding_generation:2});ok(result.status===400&&result.data?.code==='23514','service direct immutable pin forgery refused');
 // The actual import-safe production Request factory, genuine getUser and RPC I/O.
 const built=await build({entryPoints:[resolve(root,'supabase/functions/_shared/whatsapp-template-management.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'es2022'});
 const {createTemplateManagementHandler}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
 const factory=createTemplateManagementHandler({
  authenticate:async jwt=>{const r=await db.auth.getUser(jwt);if(r.error)throw new Error('auth_dependency');return r.data.user?{id:r.data.user.id}:null;},
  access:async(userId,input)=>{
   const [a,m,u,c]=await Promise.all([db.from('platform_admins').select('user_id').eq('user_id',userId).maybeSingle(),db.from('unit_members').select('role').eq('user_id',userId).eq('unit_id',input.unit_id).maybeSingle(),db.from('units').select('organization_id').eq('id',input.unit_id).maybeSingle(),db.from('customers').select('organization_id,deleted_at').eq('id',input.customer_id).maybeSingle()]);
   if([a,m,u,c].some(r=>r.error))throw new Error('access_dependency');
   return {role:m.data?.role??null,isPlatformAdmin:!!a.data,exists:!!u.data&&!!c.data&&u.data.organization_id===c.data.organization_id&&c.data.deleted_at===null};
  },
  snapshot:async()=>{throw new Error('not_invoked');},
  callerRpc:async(jwt,name,args)=>{const caller=createClient(base,keys.ANON_KEY,{global:{fetch:safeFetch,headers:{Authorization:`Bearer ${jwt}`}},auth:{persistSession:false,autoRefreshToken:false}});return caller.rpc(name,args);},
 });
 const response=await factory(new Request('http://example.invalid/manage',{method:'POST',headers:{Authorization:`Bearer ${users.owner.token}`},body:JSON.stringify({action:'consent_snapshot',unit_id:ids.unit,customer_id:ids.customer,purpose:'promotional'})}));
 const projected=await response.json();ok(response.status===200&&projected.status==='opt_out'&&projected.revision===2&&Object.keys(projected).sort().join(',')==='purpose,revision,status','actual Request genuine JWT SQL safe DTO');
 // Actual provider drift persists through direct channel writer; both stops stay safe.
 sql(`update public.whatsapp_channels set provider='zapi',status='disconnected',last_health_check_at=null,webhook_secret=null where id='${ids.datafy}';`);
 result=await rpc('release_whatsapp_template_channel','platform_admin',{p_channel_id:ids.datafy,p_scope:'catalog',p_enabled:false,p_expected_credential_revision:1,p_expected_binding_generation:1});
 ok(result.status===200&&result.data===true,'genuine admin catalog stop through provider drift');
 result=await rpc('release_whatsapp_template_channel','platform_admin',{...release,p_enabled:false,p_expected_binding_generation:1});ok(result.status===200&&result.data===true,'genuine admin dispatch stop');
 console.log(`GREEN59 ${checks} genuine JWT and actual Request controls`);
} catch(error) {failure=error;}
finally {
 try {
  sql(`begin;set local statement_timeout='20s';update app_private.whatsapp_promotion_policy set window_days=${previousWindow} where singleton;commit;`);
  ok(Number(sql('select window_days from app_private.whatsapp_promotion_policy where singleton'))===previousWindow,'exact prior frequency restored');
  const ownActors=Object.values(users).map(user=>literal(user.id));
  sql(`begin;set local statement_timeout='20s';${ownActors.length?`delete from public.audit_log where actor_id in(${ownActors.join(',')});`:''}
   delete from public.conversations where unit_id in(select id from public.units where organization_id in('${ids.org}','${ids.foreignOrg}'));
   delete from public.notifications_sent where unit_id in('${ids.unit}','${ids.sibling}','${ids.foreignUnit}');
   delete from public.organizations where id in('${ids.org}','${ids.foreignOrg}');commit;`);
  for(const role of Object.keys(users)) {const removed=await http(`/auth/v1/admin/users/${users[role].id}`,'service','DELETE');ok(removed.status===200||removed.status===204,`cleanup own ${role}`);}
  ok(sql(`select not exists(select from public.organizations where id in('${ids.org}','${ids.foreignOrg}')) and not exists(select from public.audit_log where actor_id in(${ownActors.length?ownActors.join(','):'null'})) and not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) and not exists(select from net.http_request_queue)`)==='t','owned fixtures removed quarantine retained');
 } catch(error) {failure??=error;}
}
if(failure){console.error(failure instanceof Error?failure.message:'task59_failure');process.exitCode=1;}

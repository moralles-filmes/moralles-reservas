// Owned-loopback integration controller. Importing this module performs no I/O.
// ROOT reviews and explicitly invokes it; no production endpoint is configurable.
import { readFileSync } from 'node:fs';
import { spawn,spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import Module from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { build } from 'esbuild';
import { installUiParity } from './local-preflight/whatsapp-scheduled-templates-ui-testsetup.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const SCRATCH=resolve(ROOT,'.superpowers/sdd/2026-10-03-whatsapp-templates-programados');
const DOCKER='C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const PROJECT='moralles-templates-20261003', DB=`supabase_db_${PROJECT}`;
export const APP_ORIGIN='http://127.0.0.1:8080';
const API='http://127.0.0.1:55451';
export const FIXTURE_ROLES=Object.freeze(['owner','gerente','operador','platform_admin','foreign_member','outsider','orphan']);
const invariant=(condition,code)=>{if(!condition)throw new Error(code);};
let nativeStage='ownership';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const q=value=>{invariant(typeof value==='string'&&value.length<1000,'task15_literal');return `'${value.replaceAll("'","''")}'`;};
function native(args,input) {
  const result=spawnSync(DOCKER,args,{input,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,windowsHide:true});
  // SQL errors can quote private parameter values. Never expose stdout/stderr.
  if(result.error||result.status!==0){
    const failure=new Error('task15_native_failure');failure.stage=nativeStage;
    failure.sqlstate=/ERROR:\s+([A-Z0-9]{5}):/.exec(result.stderr??'')?.[1]??null;throw failure;
  }
  return result.stdout.trim();
}
const psql=statement=>native(['exec','-i',DB,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],statement);
async function acquireLease() {
  const child=spawn(DOCKER,['exec','-i','-e','PGAPPNAME=task15-fullstory-lease',DB,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let held=false,pid,output='',failed=false;
  child.stderr.on('data',()=>{failed=true;});
  const completion=new Promise(resolve=>child.once('close',(code,signal)=>{held=false;resolve({code,signal});}));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.stdin.end();reject(new Error('task15_lease_timeout'));},5000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('task15_lease_spawn'));});
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>256){clearTimeout(timer);child.stdin.end();reject(new Error('task15_lease_output'));return;}
      const match=/^([1-9]\d*)\|t\s*$/.exec(output);if(match){pid=Number(match[1]);held=true;clearTimeout(timer);resolve();}
      else if(output.includes('\n')){clearTimeout(timer);child.stdin.end();reject(new Error('task15_lease_busy'));}
    });
    child.once('close',()=>{clearTimeout(timer);if(!held)reject(new Error('task15_lease_closed'));});
    child.stdin.write("select pg_backend_pid(),pg_try_advisory_lock(20261003,15);\n");
  });
  return {get held(){return held&&!failed;},get pid(){return pid;},async release(){invariant(held&&!failed,'task15_lease_lost');child.stdin.end();const result=await completion;invariant(result.code===0&&!result.signal,'task15_lease_release');}};
}
function decodeSql(output) {
  if(!output)return null;
  if(output==='t')return true;if(output==='f')return false;
  try{return JSON.parse(output);}catch{throw new Error('task15_sql_result_shape');}
}
/** MAIN150: encoded SQL values over private stdin, not native protocol binding. */
export function restoreParameterStatement(item) {
  invariant(item?.id==='restore_baseline_units'&&item.parameters?.length===1,'task15_parameter_statement');
  const values=item.parameters[0];
  const originalNames=['A1','A2','B1'];
  invariant(Array.isArray(values)&&values.length===3&&values.every((row,index)=>Object.keys(row).sort().join(',')==='id,name,organization_id,slug,timezone'
    &&row.id===`bbbbbbbb-0000-0000-0000-00000000000${index+1}`&&row.organization_id===`aaaaaaaa-0000-0000-0000-00000000000${index===2?2:1}`
    &&row.name===originalNames[index]&&[null,'string'].includes(row.slug===null?null:typeof row.slug)
    &&[null,'string'].includes(row.timezone===null?null:typeof row.timezone)),'task15_parameter_shape');
  invariant(item.sql===RESTORE_UNIT_SQL,'task15_parameter_sql');
  const encoded=Buffer.from(JSON.stringify(values),'utf8').toString('base64');
  invariant(encoded.length<=32768&&/^[A-Za-z0-9+/]*={0,2}$/.test(encoded),'task15_parameter_size');
  return `prepare task15_restore_units(jsonb) as ${RESTORE_UNIT_SQL};\nexecute task15_restore_units(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);\ndeallocate task15_restore_units;`;
}
// Exact fixed statement shared by the selected bridge; no browser input reaches SQL.
const RESTORE_UNIT_SQL=`with restored as (update public.units u set slug=x.slug,timezone=x.timezone
          from jsonb_to_recordset($1::jsonb) as x(id uuid,name text,organization_id uuid,slug text,timezone text)
          where u.id=x.id and u.name=x.name and u.organization_id=x.organization_id returning u.id)
          select 1/((count(*)=3)::int) from restored`;

async function importSource(relative) {
  const filename=resolve(ROOT,relative);
  const compiled=await build({entryPoints:[filename],bundle:true,write:false,format:'cjs',platform:'node',target:'es2022',packages:'external',
    define:{'import.meta.url':JSON.stringify(pathToFileURL(filename).href)},logLevel:'silent'});
  const loaded=new Module(filename);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(resolve(ROOT,'src/test/fixtures'));
  loaded._compile(compiled.outputFiles[0].text,filename);return loaded.exports;
}

export async function createLocalStoryController() {
  invariant(!['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'].some(name=>process.env[name]),'task15_override_refused');
  let disposed=false,closing=false,active=0,sessionBusy=false,sessionCount=0,lease;
  const started=Date.now(),pending=new Set(),users=new Map(),clients=new Set();
  const proof={localOnly:true,externalNetworkRequests:0,unexpectedIo:0,authRequests:0,restRequests:0,
    sessionSuccesses:0,sessionRefusals:0,managementRequests:0,preferenceGets:0,preferencePosts:0,resendRequests:0,
    syntheticProviderPosts:0,syntheticProviderHealth:0,syntheticHealthPreparations:0,transportErrors:0,billingReadErrors:0,
    billingOrgLegacyReads:0,billingEmptyOverrideReads:0,billingEmptySubscriptionReads:0,checks:[],cleanup:null};
  const diagnostic=error=>({stage:nativeStage,sqlstate:typeof error?.sqlstate==='string'&&/^[A-Z0-9]{5}$/.test(error.sqlstate)?error.sqlstate:null,
    code:typeof error?.message==='string'&&/^(?:task15|ui_parity)_[a-z0-9_]+$/.test(error.message)?error.message:'closed_failure'});
  const check=(value,name)=>{invariant(value,`task15_check_${name}`);proof.checks.push(name);};
  const track=promise=>{pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
  const assertOwned=async()=>{
    invariant(!disposed,'task15_disposed');
    invariant(native(['context','inspect','--format','{{ .Endpoints.docker.Host }}'])==='npipe:////./pipe/dockerDesktopLinuxEngine','task15_pipe');
    for(const service of ['db','auth','inbucket','kong','pg_meta','rest','studio']) {
      const name=`supabase_${service}_${PROJECT}`;
      invariant(native(['inspect','--format','{{ .State.Running }}',name])==='true'
        &&native(['inspect','--format','{{ .Name }}',name])===`/${name}`
        &&native(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',name])===PROJECT,'task15_container');
    }
    invariant(native(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',DB])==='55452'
      &&native(['inspect','--format','{{ (index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort }}',`supabase_kong_${PROJECT}`])==='55451','task15_ports');
    const config=readFileSync(resolve(SCRATCH,'local-runtime/supabase/config.toml'),'utf8');
    invariant(/^project_id\s*=\s*"moralles-templates-20261003"\s*$/m.test(config)&&/\[api\][\s\S]*?\bport\s*=\s*55451\b/.test(config)
      &&/\[db\][\s\S]*?\bport\s*=\s*55452\b/.test(config),'task15_config');
    invariant(psql(`select not exists(select from cron.job)
      and not exists(select from cron.job_run_details where status in('starting','running','connecting','sending'))
      and not exists(select from net.http_request_queue)
      and not exists(select from net._http_response)
      and not exists(select from vault.secrets where name in('internal_api_key','project_url'))
      and not exists(select from pg_stat_activity where application_name in('supabase_functions','edge-runtime'))
      and (select md5(prosrc) from pg_proc where oid='public.trigger_whatsapp_template_workers()'::regprocedure)='8acc52df7ab7965653d6e5e254d19bc7'
      and not exists(select from pg_stat_activity where pid<>pg_backend_pid() and application_name like 'task15%' ${lease?.held?`and pid<>${lease.pid}`:''})`) ==='t','task15_quarantine');
    const names=native(['ps','--all','--filter',`label=com.supabase.cli.project=${PROJECT}`,'--format','{{ .Names }}|{{ .State }}']).split(/\r?\n/).sort();
    invariant(JSON.stringify(names)===JSON.stringify(['auth','db','inbucket','kong','pg_meta','rest','studio'].map(name=>`supabase_${name}_${PROJECT}|running`).sort()),'task15_unexpected_worker');
  };
  await assertOwned();
  const health=await fetch(`${API}/auth/v1/health`,{redirect:'error',signal:AbortSignal.timeout(5000)});
  invariant(health.ok,'task15_gotrue_health');await health.arrayBuffer();
  lease=await acquireLease();
  // Fixed local file is acquired once, after guards. Keys never leave this closure.
  let keys;
  try{keys=JSON.parse(readFileSync(resolve(SCRATCH,'local-runtime/secrets/local-status.json'),'utf8'));}
  catch{await lease.release();throw new Error('task15_local_key_read');}
  if(keys.API_URL!==API||typeof keys.ANON_KEY!=='string'||typeof keys.SERVICE_ROLE_KEY!=='string'){keys=null;await lease.release();throw new Error('task15_key_origin');}
  const safeFetch=(input,init)=>track((async()=>{
    const request=new Request(input,init),url=new URL(request.url);
    if(url.origin!==API||url.username||url.password||url.hash||!['/auth/v1/','/rest/v1/'].some(prefix=>url.pathname.startsWith(prefix))) {
      proof.unexpectedIo++;throw new Error('task15_sdk_egress');
    }
    if(url.pathname.startsWith('/auth/'))proof.authRequests++;else proof.restRequests++;
    try{
      const response=await fetch(request,{redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});
      // Consume into memory while tracked, so cleanup truly drains.
      const bytes=await response.arrayBuffer();
      const billingKind=url.pathname==='/rest/v1/organizations'&&url.searchParams.get('select')==='billing_status,whatsapp_legacy_grandfathered,whatsapp_grandfather_revoked_at'?'org':
        url.pathname==='/rest/v1/organization_entitlement_overrides'?'override':url.pathname==='/rest/v1/billing_subscriptions'?'subscription':null;
      if(billingKind){
        let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{value=null;}
        const organization=Array.isArray(value)&&value.length===1?value[0]:value;
        if(!response.ok){proof.billingReadErrors++;}
        else if(billingKind==='org'&&organization?.whatsapp_legacy_grandfathered===true&&organization.whatsapp_grandfather_revoked_at===null){proof.billingOrgLegacyReads++;}
        else if(Array.isArray(value)&&value.length===0&&billingKind!=='org'){if(billingKind==='override')proof.billingEmptyOverrideReads++;else proof.billingEmptySubscriptionReads++;}
        else proof.billingReadErrors++;
      }
      return new Response([204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch{proof.transportErrors++;throw new Error('task15_sdk_transport');}
  })());
  const newClient=(key,headers={})=>{
    const client=createClient(API,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:safeFetch,headers}});
    clients.add(client);return client;
  };
  const db=newClient(keys.SERVICE_ROLE_KEY);
  const query=async item=>{
    invariant(Array.isArray(item.parameters)&&item.parameters.length===0,'task15_query_parameters');
    const result=psql(item.sql);
    // Install contains two explicit row-count assertions; neither is application data.
    if(result==='1\n1'||result==='1\r\n1')return null;
    return decodeSql(result);
  };
  const transaction=async statements=>{
    invariant(Array.isArray(statements)&&statements.length===2&&statements[0].parameters.length===0,'task15_restore_transaction');
    psql(`begin;set local statement_timeout='20s';${statements[0].sql}\n${restoreParameterStatement(statements[1])}\ncommit;`);
  };
  const assertDrained=async()=>{
    await Promise.allSettled([...pending]);
    invariant(active===0&&pending.size===0&&!sessionBusy,'task15_pending_work');
  };
  let bridge;
  const ids=Object.fromEntries(['org','foreignOrg','unit','sibling','foreignUnit','customer','foreignCustomer','deletedCustomer','channel','siblingChannel','foreignChannel','crossChannel','account','binding','reservation','foreignReservation','notificationOwn','notificationForeign','notificationMixed','voucher','rule','siblingRule','waitlist','outbox'].map(name=>[name,randomUUID()]));
  const slug='task15-owned-a',foreignSlug='task15-owned-b';
  let harness,preferences,capabilities=[],initialized=false,rateBucket,confirmationJob;
  let initialFlag;
  try{
    initialFlag=decodeSql(psql("select jsonb_build_object('exists',exists(select from public.platform_flags where key='whatsapp_automation_dispatch'),'literal',(select quote_literal(value::text) from public.platform_flags where key='whatsapp_automation_dispatch'))"));
    invariant(typeof initialFlag.exists==='boolean'&&(initialFlag.exists?typeof initialFlag.literal==='string'&&/^(?:E)?'/.test(initialFlag.literal)&&initialFlag.literal.endsWith("'"):initialFlag.literal===null),'task15_flag_shape');
  }catch(error){keys=null;await lease.release();throw error;}
  const rpc=async(name,args)=>{const result=await db.rpc(name,args);invariant(!result.error,'task15_rpc_dependency');return result.data;};
  const ownActors=()=>[...users.values()].map(user=>q(user.id));

  async function cleanup() {
    nativeStage='cleanup';proof.stage=nativeStage;
    invariant(!disposed,'task15_cleanup_twice');closing=true;
    await assertDrained();
    if(harness){
      try{await harness.drainBackground(20000);}catch{proof.handlerFailure=true;}
      invariant(harness.pendingBackground===0,'task15_background_not_drained');
      try{harness.assertNoUnexpectedIo();}catch{proof.unexpectedIo++;}
      harness.dispose();harness=undefined;
    }
    await assertOwned();
    for(const client of clients){await client.removeAllChannels();client.auth.stopAutoRefresh();}
    psql(`begin;set local statement_timeout='20s';
      ${ownActors().length?`delete from public.audit_log where actor_id in(${ownActors().join(',')});`:''}
      delete from public.audit_log where unit_id in(${q(ids.unit)},${q(ids.sibling)},${q(ids.foreignUnit)}) or organization_id in(${q(ids.org)},${q(ids.foreignOrg)});
      do $cleanup$ begin if to_regclass('public.webhook_executions') is not null then
        delete from public.webhook_executions where unit_id in(${q(ids.unit)},${q(ids.sibling)},${q(ids.foreignUnit)});
      end if;end $cleanup$;
      delete from public.notifications_sent where unit_id in(${q(ids.unit)},${q(ids.sibling)},${q(ids.foreignUnit)});
      delete from public.conversations where unit_id in(${q(ids.unit)},${q(ids.sibling)},${q(ids.foreignUnit)});
      delete from public.organizations where id in(${q(ids.org)},${q(ids.foreignOrg)});
      ${rateBucket?`delete from app_private.whatsapp_preference_rate_buckets where bucket_hash=${q(rateBucket)};`:''}
      ${initialFlag.exists?`insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch',${initialFlag.literal}::jsonb) on conflict(key) do update set value=excluded.value;`:
        "delete from public.platform_flags where key='whatsapp_automation_dispatch';"}
      commit;`);
    for(const user of users.values()) {
      if(user.deleted)continue;
      const result=await db.auth.admin.deleteUser(user.id);invariant(!result.error,'task15_own_auth_cleanup');
      user.deleted=true;
    }
    await assertDrained();
    invariant(psql(`select not exists(select from public.organizations where id in(${q(ids.org)},${q(ids.foreignOrg)}))
      and not exists(select from auth.users where id in(${ownActors().length?ownActors().join(','):'null'}))`) === 't','task15_rows_remain');
    const afterFlag=decodeSql(psql("select jsonb_build_object('exists',exists(select from public.platform_flags where key='whatsapp_automation_dispatch'),'literal',(select quote_literal(value::text) from public.platform_flags where key='whatsapp_automation_dispatch'))"));
    invariant(JSON.stringify(afterFlag)===JSON.stringify(initialFlag),'task15_flag_restore');
    nativeStage='restore';proof.stage=nativeStage;
    proof.cleanup=bridge?await bridge.restore():{restored:true,installationNeverStarted:true};
    await lease.release();capabilities=[];users.clear();clients.clear();keys=null;disposed=true;
    return structuredClone(proof);
  }

  try {
    nativeStage='install';proof.stage=nativeStage;
    bridge=await installUiParity({query,transaction,assertOwned,assertDrained,lease,onRecoveryReady:value=>{bridge=value;}});
    nativeStage='seed';proof.stage=nativeStage;
    for(const role of FIXTURE_ROLES) {
      const email=`task15-${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('hex');
      const result=await db.auth.admin.createUser({email,password,email_confirm:true});
      invariant(!result.error&&uuid(result.data.user?.id),'task15_fixture_user');
      users.set(role,{id:result.data.user.id,email,password});
    }
    psql(`begin;set local statement_timeout='20s';
      insert into public.organizations(id,name,slug) values(${q(ids.org)},'Task15 sintética',${q(slug)}),(${q(ids.foreignOrg)},'Task15 estrangeira',${q(foreignSlug)});
      update public.organizations set whatsapp_legacy_grandfathered=true where id in(${q(ids.org)},${q(ids.foreignOrg)});
      insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true'::jsonb) on conflict(key) do update set value=excluded.value;
      insert into public.units(id,organization_id,name,slug) values(${q(ids.unit)},${q(ids.org)},'Unidade Task15 A',${q(slug)}),
        (${q(ids.sibling)},${q(ids.org)},'Unidade Task15 A2',${q(slug+'-sibling')}),(${q(ids.foreignUnit)},${q(ids.foreignOrg)},'Unidade Task15 B',${q(foreignSlug)});
      insert into public.customers(id,organization_id,name,phone) values(${q(ids.customer)},${q(ids.org)},'Contato sintético DDD55','55912345678'),
        (${q(ids.foreignCustomer)},${q(ids.foreignOrg)},'Contato estrangeiro sintético','55912345678'),(${q(ids.deletedCustomer)},${q(ids.org)},'Contato removido sintético','11912345678');
      update public.customers set deleted_at=clock_timestamp() where id=${q(ids.deletedCustomer)};
      insert into public.platform_admins(user_id) values(${q(users.get('platform_admin').id)});
      ${['owner','gerente','operador'].map(role=>`insert into public.unit_members(user_id,unit_id,role) values(${q(users.get(role).id)},${q(ids.unit)},${q(role)});`).join('\n')}
      insert into public.unit_members(user_id,unit_id,role) values(${q(users.get('foreign_member').id)},${q(ids.foreignUnit)},'owner');
      insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret,manual_echo_verified_at)
        values(${q(ids.channel)},${q(ids.unit)},'zapi','connected',true,clock_timestamp(),'{"instance_id":"task15-synthetic","token":"task15-synthetic","client_token":"task15-synthetic"}','task15-synthetic',clock_timestamp()),
          (${q(ids.siblingChannel)},${q(ids.sibling)},'zapi','connected',true,clock_timestamp(),'{"instance_id":"task15-synthetic-b","token":"task15-synthetic","client_token":"task15-synthetic"}','task15-synthetic-b',clock_timestamp());
      insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret,manual_echo_verified_at)
        values(${q(ids.foreignChannel)},${q(ids.foreignUnit)},'datafy','connected',true,clock_timestamp(),'{"phone_number_id":"150015","access_token":"task15-synthetic-datafy"}','task15-synthetic-datafy-secret',clock_timestamp()),
          (${q(ids.crossChannel)},${q(ids.unit)},'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"150016","access_token":"task15-synthetic-datafy"}','task15-synthetic-datafy-secret',clock_timestamp());
      insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values(${q(ids.account)},${q(ids.foreignOrg)},'15001500150015',clock_timestamp());
      insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values(${q(ids.binding)},${q(ids.foreignUnit)},${q(ids.foreignChannel)},${q(ids.account)},'datafy',clock_timestamp());
      commit;`);
    const harnessModule=await importSource('src/test/fixtures/edge-request-harness.ts');
    const preferenceModule=await importSource('supabase/functions/_shared/whatsapp-message-preferences-handler.ts');
    const tokenModule=await importSource('supabase/functions/_shared/whatsapp-message-preferences-core.ts');
    const technicalBucket=await tokenModule.hashPreferenceTechnicalKey('preferences:v1:unknown');
    invariant(psql(`select not exists(select from app_private.whatsapp_preference_rate_buckets where bucket_hash=${q(technicalBucket)})`)==='t','task15_rate_bucket_not_owned');
    rateBucket=technicalBucket;
    const env={SUPABASE_URL:'https://supabase.task15.invalid',SUPABASE_ANON_KEY:'task15-synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'task15-synthetic-service',
      INTERNAL_API_KEY:'task15-synthetic-internal',APP_BASE_URL:'https://app.task15.invalid'};
    harness=harnessModule.createEdgeRequestHarness({env,now:Date.now(),
      createClient:(url,key,options)=>{
        invariant(url===env.SUPABASE_URL&&[env.SUPABASE_ANON_KEY,env.SUPABASE_SERVICE_ROLE_KEY].includes(key),'task15_vm_client_boundary');
        const headers=options?.global?.headers??{};
        invariant(Object.keys(headers).every(name=>name==='Authorization'),'task15_vm_headers');
        return newClient(key===env.SUPABASE_ANON_KEY?keys.ANON_KEY:keys.SERVICE_ROLE_KEY,headers);
      },
      internalHops:[{from:'resend-notification',to:'send-scheduled-whatsapp'},{from:'resend-notification',to:'send-whatsapp'},
        {from:'send-confirmation',to:'send-scheduled-whatsapp'},{from:'process-notification-outbox',to:'send-confirmation'}],
      transport:[{method:'GET',url:'https://api.z-api.io/instances/task15-synthetic/token/task15-synthetic/status',respond:()=>{
        proof.syntheticProviderHealth++;return Response.json({connected:true,smartphoneConnected:true});
      }},{method:'POST',url:'https://api.z-api.io/instances/task15-synthetic/token/task15-synthetic/send-text',respond:()=>{
        proof.syntheticProviderPosts++;return Response.json({messageId:`task15-synthetic-message-${proof.syntheticProviderPosts}`});
      }},{method:'GET',url:'https://api.z-api.io/instances/task15-synthetic-b/token/task15-synthetic/status',respond:()=>{
        proof.syntheticProviderHealth++;return Response.json({connected:true,smartphoneConnected:true});
      }},{method:'POST',url:'https://api.z-api.io/instances/task15-synthetic-b/token/task15-synthetic/send-text',respond:()=>{
        proof.syntheticProviderPosts++;return Response.json({messageId:`task15-synthetic-message-${proof.syntheticProviderPosts}`});
      }}],
    });
    preferences=preferenceModule.createPreferencesHandler({allowedOrigins:[APP_ORIGIN],
      lookup:hash=>rpc('lookup_whatsapp_preference_token',{p_token_hash:hash}),
      optOut:hash=>rpc('revoke_whatsapp_promotion',{p_token_hash:hash}),
      rateGate:hash=>rpc('check_whatsapp_preference_rate',{p_bucket_hash:hash,p_limit:30,p_window_seconds:60}),
    });
    initialized=true;
    const adminSession=await session('platform_admin');
    const admin=newClient(keys.ANON_KEY,{Authorization:`Bearer ${adminSession.access_token}`});
    const selectedDay=new Date(Date.now()-10800000).toISOString().slice(0,10);
    for(const [unit,channel,rule] of [[ids.unit,ids.channel,ids.rule],[ids.sibling,ids.siblingChannel,ids.siblingRule]]) {
      const released=await admin.rpc('release_whatsapp_template_channel',{p_channel_id:channel,p_scope:'dispatch',p_enabled:true,p_expected_credential_revision:0,p_expected_binding_generation:null});
      check(!released.error&&released.data===true,'genuine_admin_release');
      const consent=await admin.rpc('record_whatsapp_message_consent',{p_unit_id:unit,p_customer_id:ids.customer,p_purpose:'promotional',p_decision:'opt_in',p_source_code:'in_person',p_observed_at:new Date().toISOString(),p_evidence_reference:'Task15 own synthetic consent'});
      check(!consent.error&&Number.isSafeInteger(consent.data),'genuine_admin_consent');
      psql(`insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days) values(${q(rule)},${q(unit)},'Task15 birthday precondition','birthday',10,30);`);
      // Native issuer is a real atomic producer boundary; birthday selection itself
      // is a declared fixture precondition, separately covered by full Request tests.
      const issued=await rpc('issue_scheduled_whatsapp_voucher',{p_rule_id:rule,p_customer_id:ids.customer,p_code:'T15'+rule.slice(0,8),
        p_expected_rule:{unit_id:unit,trigger_type:'birthday',discount_percent:10,validity_days:30,visits_required:null,days_window:null,selected_brt_day:selectedDay}});
      check(Array.isArray(issued)&&issued.length===1&&uuid(issued[0].job_id),'native_atomic_voucher_job');
      const token=await tokenModule.createPreferenceToken();
      check(await rpc('issue_whatsapp_preference_token',{p_job_id:issued[0].job_id,p_token_hash:token.hash})===true,'native_public_capability_issued');
      capabilities.push({unit,token:token.token,hash:token.hash,issued:true,job:issued[0].job_id,voucher:issued[0].voucher_id});
    }
    nativeStage='confirmation';proof.stage=nativeStage;
    // Real web inserts occur after adoption. Their unchanged producer trigger
    // owns outbox provenance; never duplicate or backdate that row.
    psql(`insert into public.reservations(id,unit_id,customer_id,date,time,party_size,status,source,reservation_code)
      values(${q(ids.reservation)},${q(ids.unit)},${q(ids.customer)},current_date+1,'20:00',2,'confirmed','web',${q('T15'+ids.reservation.slice(0,8))}),
        (${q(ids.foreignReservation)},${q(ids.sibling)},${q(ids.customer)},current_date+1,'20:00',2,'confirmed','web',${q('T15'+ids.foreignReservation.slice(0,8))});`);
    const ownOutbox=await db.from('notification_outbox').select('id,reservation_id,unit_id,kind')
      .eq('reservation_id',ids.reservation).eq('unit_id',ids.unit).eq('kind','confirmation').single();
    check(!ownOutbox.error&&uuid(ownOutbox.data?.id)&&ownOutbox.data.reservation_id===ids.reservation
      &&ownOutbox.data.unit_id===ids.unit&&ownOutbox.data.kind==='confirmation','native_trigger_outbox_single_own');
    ids.outbox=ownOutbox.data.id;
    const enqueued=await harness.request('send-scheduled-whatsapp',new Request('https://supabase.task15.invalid/functions/v1/send-scheduled-whatsapp',{
      method:'POST',headers:{'Content-Type':'application/json','x-internal-key':'task15-synthetic-internal'},
      body:JSON.stringify({action:'enqueue',kind:'confirmation',resource_id:ids.reservation,unit_id:ids.unit,outbox_id:ids.outbox})}));
    const queued=await enqueued.json();check(enqueued.status===200&&uuid(queued.jobId),'actual_confirmation_producer_enqueued');confirmationJob=queued.jobId;
    psql(`insert into public.notifications_sent(unit_id,reservation_id,kind,status,sent_at,error) values(${q(ids.unit)},${q(ids.reservation)},'confirmation','failed',clock_timestamp(),'synthetic resend precondition');`);
  } catch(error) {
    // Return the recovery handle instead of destroying original snapshots.
    // The launcher enters cleanup-only stdin mode and keeps the lease alive.
    initialized=false;proof.setupFailed=true;proof.failure={stage:nativeStage,sqlstate:error.sqlstate??null,
      code:/^(?:task15|ui_parity)_[a-z0-9_]+$/.test(error.message)?error.message:'closed_setup_failure'};
    return Object.freeze({ready:false,cleanup,diagnostic,safeProof:()=>structuredClone(proof)});
  }

  async function session(role) {
    invariant(initialized&&!closing&&!disposed&&Date.now()-started<=3600000,'task15_session_lifetime');
    invariant((FIXTURE_ROLES.includes(role)||role==='public_preferences')&&!sessionBusy&&sessionCount<32,'task15_session_request');
    sessionBusy=true;
    try {
      if(role==='public_preferences'){
        invariant(capabilities.length===2&&capabilities.every(item=>item.issued&&[ids.unit,ids.sibling].includes(item.unit)),'task15_own_capabilities');
        sessionCount++;proof.sessionSuccesses++;return {tokens:capabilities.map(item=>item.token),anon:keys.ANON_KEY};
      }
      const fixture=users.get(role),client=newClient(keys.ANON_KEY);
      const result=await client.auth.signInWithPassword({email:fixture.email,password:fixture.password});
      invariant(!result.error&&result.data.user?.id===fixture.id&&typeof result.data.session?.access_token==='string'
        &&typeof result.data.session.refresh_token==='string','task15_session_auth');
      sessionCount++;proof.sessionSuccesses++;
      return {access_token:result.data.session.access_token,refresh_token:result.data.session.refresh_token,anon:keys.ANON_KEY};
    } finally {sessionBusy=false;}
  }
  async function forward(request) {
    invariant(initialized&&!closing&&!disposed&&Date.now()-started<=3600000,'task15_forward_lifetime');
    const url=new URL(request.url),name=url.pathname.replace('/functions/v1/','');
    invariant(url.origin===APP_ORIGIN&&!url.search&&['manage-whatsapp-templates','whatsapp-message-preferences','resend-notification'].includes(name),'task15_forward_path');
    if(name==='resend-notification')await prepareFixtureHealth();
    active++;
    try {
      if(name==='whatsapp-message-preferences') {
        if(request.method==='GET')proof.preferenceGets++;if(request.method==='POST')proof.preferencePosts++;
        return await preferences(request);
      }
      if(name==='manage-whatsapp-templates')proof.managementRequests++;else proof.resendRequests++;
      return await harness.request(name,request);
    } finally {active--;}
  }
  async function verify() {
    await assertDrained();harness.assertNoUnexpectedIo();
    check(proof.unexpectedIo===0&&proof.externalNetworkRequests===0,'closed_egress');
    check(psql(`select not exists(select from public.unit_members where user_id=${q(users.get('platform_admin').id)})`)==='t','admin_without_membership');
    check(psql(`select count(*)=1 from public.customers where id=${q(ids.customer)} and phone='55912345678'`)==='t','canonical_ddd55_customer');
    return structuredClone(proof);
  }
  async function authority() {
    nativeStage='authority';proof.stage=nativeStage;
    invariant(!closing,'task15_closed');
    const roleSessions=new Map();
    for(const role of FIXTURE_ROLES)roleSessions.set(role,await session(role));
    const request=async(role,body)=>{
      const token=roleSessions.get(role)?.access_token;
      const response=await forward(new Request(APP_ORIGIN+'/functions/v1/manage-whatsapp-templates',{method:'POST',headers:{'Content-Type':'application/json',Origin:APP_ORIGIN,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)}));
      return {status:response.status,body:await response.json()};
    };
    for(const role of ['owner','gerente','operador','platform_admin']) {
      const value=await request(role,{action:'snapshot',unit_id:ids.unit});
      check(value.status===200&&value.body.mode==='unofficial','real_snapshot_'+role);
    }
    for(const role of ['foreign_member','outsider','orphan']) {
      const value=await request(role,{action:'snapshot',unit_id:ids.unit});check(value.status===403&&value.body.error==='forbidden','real_snapshot_refused_'+role);
    }
    const missing=await request('owner',{action:'snapshot',unit_id:randomUUID()});
    const foreign=await request('owner',{action:'snapshot',unit_id:ids.foreignUnit});
    check(missing.status===403&&foreign.status===403&&missing.body.error===foreign.body.error,'missing_foreign_uniform');
    const official=await request('foreign_member',{action:'snapshot',unit_id:ids.foreignUnit});
    check(official.status===200&&official.body.mode==='official'&&official.body.templates.length===7,'native_official_snapshot');
    const bindingArgs={p_channel_id:ids.foreignChannel,p_unit_id:ids.foreignUnit,p_provider:'datafy',p_credential_revision:0,p_phone_number_id:'150015',p_waba_id:'15001500150015'};
    const unauthenticated=await request('missing',{action:'snapshot',unit_id:ids.unit});
    check(unauthenticated.status===401,'management_missing_jwt');
    for(const role of ['owner','platform_admin']){
      const client=newClient(keys.ANON_KEY,{Authorization:`Bearer ${roleSessions.get(role).access_token}`});
      const refused=await client.rpc('bind_whatsapp_template_account',bindingArgs);
      check(refused.status===403&&refused.error?.code==='42501','bind_service_only_'+role);
    }
    const bound=await db.rpc('bind_whatsapp_template_account',bindingArgs);
    check(!bound.error&&bound.data?.accountId===ids.account,'bind_current_positive');
    const cross=await db.rpc('bind_whatsapp_template_account',{...bindingArgs,p_channel_id:ids.crossChannel,p_unit_id:ids.unit,p_phone_number_id:'150016'});
    check(cross.status===403&&cross.error?.code==='42501','foreign_waba_refused');
    const rotated=await db.from('whatsapp_channels').update({credentials:{phone_number_id:'150015',access_token:'task15-synthetic-rotated'}}).eq('id',ids.foreignChannel).select('template_credential_revision').single();
    check(!rotated.error&&rotated.data?.template_credential_revision===1,'binding_real_revision_change');
    const beforeBinding=psql(`select jsonb_build_object('binding',(select to_jsonb(b) from public.whatsapp_template_bindings b where id=${q(ids.binding)}),'account',(select to_jsonb(a) from public.whatsapp_template_accounts a where id=${q(ids.account)}))`);
    const start=Date.now(),stale=await db.rpc('bind_whatsapp_template_account',{...bindingArgs,p_credential_revision:1});
    check(stale.status===409&&stale.error?.code==='PT409'&&stale.error?.message==='template_binding_changed'&&Date.now()-start<15000,'bounded_native_http409');
    check(psql(`select jsonb_build_object('binding',(select to_jsonb(b) from public.whatsapp_template_bindings b where id=${q(ids.binding)}),'account',(select to_jsonb(a) from public.whatsapp_template_accounts a where id=${q(ids.account)}))`)===beforeBinding,'binding_refusal_zero_effect');
    check(await rpc('reconcile_whatsapp_template_credentials',{p_channel_id:ids.foreignChannel})===true,'binding_real_reconciliation');
    const rebound=await db.rpc('bind_whatsapp_template_account',{...bindingArgs,p_credential_revision:1});
    check(!rebound.error&&rebound.data?.accountId===ids.account,'bind_after_reconcile_positive');
    for(const role of ['operador','foreign_member','outsider']) {
      const value=await request(role,{action:'consent_snapshot',unit_id:ids.unit,customer_id:ids.customer,purpose:'promotional'});
      check(value.status===403&&value.body.error==='forbidden','real_consent_refused_'+role);
    }
    for(const customer_id of [ids.foreignCustomer,ids.deletedCustomer,randomUUID()]) {
      const value=await request('owner',{action:'consent_snapshot',unit_id:ids.unit,customer_id,purpose:'promotional'});
      check(value.status===403&&value.body.error==='forbidden','real_contact_refused');
    }
    const operational=await request('owner',{action:'consent_snapshot',unit_id:ids.unit,customer_id:ids.customer,purpose:'operational'});
    check(operational.status===200&&operational.body.status==='unknown'&&operational.body.revision===null,'selected_operational_absence');
    // Native service PostgREST executes the same embedded join and independent
    // notification/resource tenant filters used by the survey handler.
    const third=randomUUID(),fourth=randomUUID();
    psql(`begin;
      insert into public.reservations(id,unit_id,customer_id,status) values(${q(third)},${q(ids.unit)},${q(ids.customer)},'confirmed'),(${q(fourth)},${q(ids.sibling)},${q(ids.customer)},'confirmed');
      insert into public.notifications_sent(unit_id,reservation_id,kind,status,sent_at) values
        (${q(ids.unit)},${q(ids.reservation)},'survey_d1','sent',clock_timestamp()-interval '3 minutes'),
        (${q(ids.sibling)},${q(ids.foreignReservation)},'survey_d1','sent',clock_timestamp()-interval '2 minutes'),
        (${q(ids.sibling)},${q(third)},'survey_d1','sent',clock_timestamp()-interval '1 minute'),
        (${q(ids.unit)},${q(fourth)},'survey_d1','sent',clock_timestamp());commit;`);
    const selected=await db.from('notifications_sent').select('reservation_id,reservations!inner(id,customer_id,unit_id,satisfaction_rating)')
      .eq('kind','survey_d1').eq('unit_id',ids.unit).eq('reservations.unit_id',ids.unit).eq('reservations.customer_id',ids.customer)
      .is('reservations.satisfaction_rating',null).order('sent_at',{ascending:false}).limit(1).maybeSingle();
    check(!selected.error&&selected.data?.reservation_id===ids.reservation,'native_survey_embedded_independent_tenants');
    for(const column of ['unit_id','customer_id']) {
      const replacement=column==='unit_id'?ids.sibling:ids.deletedCustomer;
      const reassigned=await db.from('reservations').update({[column]:replacement}).eq('id',third).select('id');
      check(!reassigned.error&&reassigned.data?.length===1,'native_survey_reassignment');
      for(const change of [{satisfaction_rating:5},{satisfaction_comment:'Synthetic comment'}]) {
        const changed=await db.from('reservations').update(change).eq('id',third).eq('unit_id',ids.unit).eq('customer_id',ids.customer).select('id');
        check(!changed.error&&changed.data?.length===0,'native_survey_zero_row_'+column);
      }
      const restored=await db.from('reservations').update({[column]:column==='unit_id'?ids.unit:ids.customer}).eq('id',third).select('id');
      check(!restored.error&&restored.data?.length===1,'native_survey_fixture_restore');
    }
    psql(`begin;delete from public.notifications_sent where kind='survey_d1' and unit_id in(${q(ids.unit)},${q(ids.sibling)});delete from public.reservations where id in(${q(third)},${q(fourth)});commit;`);
    check(proof.syntheticProviderPosts===0,'authority_no_provider_post');
    return structuredClone(proof);
  }
  async function dispatch() {
    nativeStage='dispatch';proof.stage=nativeStage;
    await prepareFixtureHealth();
    const choices=await Promise.all(capabilities.map(item=>rpc('lookup_whatsapp_preference_token',{p_token_hash:item.hash})));
    check(choices[0]?.choice==='opt_out'&&choices[1]?.choice==='opt_in','browser_optout_before_dispatch');
    for(const [index,item]of capabilities.entries()) {
      const beforePosts=proof.syntheticProviderPosts;
      const response=await harness.request('send-scheduled-whatsapp',new Request('https://supabase.task15.invalid/functions/v1/send-scheduled-whatsapp',{
        method:'POST',headers:{'Content-Type':'application/json','x-internal-key':'task15-synthetic-internal'},body:JSON.stringify({action:'dispatch_existing',job_id:item.job})}));
      const result=await response.json();await harness.drainBackground();
      check(response.status===200,'real_dispatch_request');
      check(index===0?proof.syntheticProviderPosts===beforePosts&&result.state==='blocked':proof.syntheticProviderPosts===beforePosts+1&&['accepted','reconciled'].includes(result.state),
        index===0?'queued_optout_no_post':'native_acceptance_persistence');
      check(psql(`select count(*)=1 from public.vouchers where id=${q(item.voucher)} and unit_id=${q(item.unit)}`)==='t','original_voucher_unique');
    }
    check(proof.billingReadErrors===0&&proof.billingOrgLegacyReads>0&&proof.billingEmptyOverrideReads>0&&proof.billingEmptySubscriptionReads>0,'actual_legacy_gate_reads_without_error');
    check(proof.syntheticProviderHealth===0,'fresh_projection_health_branch_not_exercised');
    harness.assertNoUnexpectedIo();return structuredClone(proof);
  }
  async function receipt() {
    nativeStage='receipt';proof.stage=nativeStage;
    const item=capabilities[1];
    const job=await db.from('whatsapp_automation_jobs').select('provider_message_id').eq('id',item.job).single();
    check(!job.error&&typeof job.data.provider_message_id==='string','accepted_provider_id');
    const body={type:'DeliveryCallback',status:'RECEIVED',ids:[job.data.provider_message_id]};
    const response=await harness.request('webhook-whatsapp',new Request(`https://supabase.task15.invalid/functions/v1/webhook-whatsapp?channel=${ids.siblingChannel}`,{
      method:'POST',headers:{'Content-Type':'application/json','x-webhook-secret':'task15-synthetic-b'},body:JSON.stringify(body)}));
    await harness.drainBackground();check(response.status===200,'real_receipt_handler');harness.assertNoUnexpectedIo();
    await rpc('reconcile_whatsapp_automation_receipts',{p_job_id:item.job,p_limit:20});
    const delivered=await db.from('notifications_sent').select('delivered_at').eq('unit_id',ids.sibling).eq('whatsapp_channel_id',ids.siblingChannel)
      .eq('whatsapp_provider','zapi').eq('provider_message_id',job.data.provider_message_id).single();
    check(!delivered.error&&typeof delivered.data.delivered_at==='string','receipt_real_four_field_persistence');
    return structuredClone(proof);
  }
  async function billing(blocked){
    nativeStage='billing';proof.stage=nativeStage;await assertDrained();await assertOwned();
    const result=await db.from('organizations').update({billing_status:blocked?'blocked':'active'}).eq('id',ids.org).select('id,billing_status').single();
    check(!result.error&&result.data?.id===ids.org&&result.data.billing_status===(blocked?'blocked':'active'),blocked?'billing_fixture_blocked':'billing_fixture_restored');
    return structuredClone(proof);
  }
  async function prepareFixtureHealth(){
    const previousStage=nativeStage;nativeStage='fixture_health';proof.stage=nativeStage;
    invariant(initialized&&!closing&&!disposed&&Date.now()-started<=3600000,'task15_health_fixture_lifetime');
    await assertDrained();await assertOwned();
    invariant(active===0&&pending.size===0&&!sessionBusy&&harness.pendingBackground===0&&harness.pendingTimers===0,'task15_health_fixture_pending');
    // MAIN155: synthetic fixture precondition, never a provider health proof.
    // Refresh only the same two owned connected channels and align the test VM
    // with that real SQL instant; SQL's clock itself is never replaced.
    const snapshot=decodeSql(psql(`with refreshed as (
      update public.whatsapp_channels c set last_health_check_at=clock_timestamp()
      from public.units u where c.unit_id=u.id and u.organization_id=${q(ids.org)}
       and ((c.id=${q(ids.channel)} and u.id=${q(ids.unit)}) or (c.id=${q(ids.siblingChannel)} and u.id=${q(ids.sibling)}))
       and c.provider='zapi' and c.status='connected' and c.is_active is true
      returning c.last_health_check_at)
      select jsonb_build_object('count',count(*),'stamp',ceil(max(extract(epoch from last_health_check_at))*1000),
        'guard',1/((count(*)=2)::int)) from refreshed`));
    invariant(snapshot.count===2&&snapshot.guard===1&&Number.isSafeInteger(snapshot.stamp),'task15_health_fixture_rows');
    const delta=Math.max(0,snapshot.stamp-harness.now);
    invariant(delta<=3600000,'task15_health_fixture_clock');
    await harness.advanceTime(delta);
    invariant(harness.now>=snapshot.stamp&&harness.now-snapshot.stamp<=300000,'task15_health_fixture_freshness');
    proof.syntheticHealthPreparations++;nativeStage=previousStage;proof.stage=nativeStage;
  }
  return Object.freeze({ready:true,session,forward,verify,cleanup,assertOwned,authority,dispatch,receipt,diagnostic,
    billing_block:()=>billing(true),billing_restore:()=>billing(false),
    safeRoutes:Object.freeze({reservas:`/g/${slug}/reservas/comunicacao`,fila:`/g/${slug}/fila/comunicacao`,giftback:`/g/${slug}/giftback/ajustes`,entregas:`/o/${slug}/entregas`,foreign:`/g/${foreignSlug}/reservas/comunicacao`}),
    safeProof:()=>structuredClone(proof),noteSessionRefusal:()=>{proof.sessionRefusals++;},
  });
}

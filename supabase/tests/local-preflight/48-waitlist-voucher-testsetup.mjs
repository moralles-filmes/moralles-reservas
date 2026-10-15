import { resolveLocalDocker } from './local-runtime-paths.mjs';
// Bounded local bridge: actual nullable birthday + exact historical feedback RPC.
// No production schema repair, cron, pg_net, Auth stand-in or expiration stub.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const docker=resolveLocalDocker();
const project='moralles-templates-20261003', container=`supabase_db_${project}`;
const source=readFileSync(fileURLToPath(new URL('../../migrations/20260514181701_048_waitlist_automation.sql',import.meta.url)),'utf8');
const matches=[...source.matchAll(/create or replace function public\.get_waitlist_for_feedback\([\s\S]*?grant execute on function public\.get_waitlist_for_feedback\(date, uuid\) to service_role;/g)];
if(matches.length!==1)throw new Error('task48_historical_source_mismatch');
const selector=matches[0][0], body=selector.split('as $$')[1]?.split('$$;')[0];
if(!body)throw new Error('task48_body_missing');
const literal=value=>`'${value.replaceAll("'","''")}'`;
const schema=`
do $birthday$
begin
 if not exists(select from pg_attribute where attrelid='public.customers'::regclass and attname='birthday' and not attisdropped) then
  alter table public.customers add column birthday date;
 end if;
 if not exists(select from pg_attribute a where a.attrelid='public.customers'::regclass and a.attname='birthday' and not a.attisdropped
   and format_type(a.atttypid,a.atttypmod)='date' and not a.attnotnull
   and not exists(select from pg_attrdef d where d.adrelid=a.attrelid and d.adnum=a.attnum)) then raise exception 'task48_birthday_drift'; end if;
 if to_regclass('public.resource41_voucher_rule_customer') is null or to_regclass('public.resource41_voucher_code') is null
   or to_regclass('public.voucher_rules') is null then raise exception 'task48_bridge41_required'; end if;
end $birthday$;
do $selector$
begin
 if to_regprocedure('public.get_waitlist_for_feedback(date,uuid)') is null then execute ${literal(selector)}; end if;
 if not exists(select from pg_proc p where p.oid='public.get_waitlist_for_feedback(date,uuid)'::regprocedure
   and p.prosrc=${literal(body)} and p.prosecdef and p.provolatile='s' and p.proretset
   and p.proconfig=array['search_path=public'] and p.pronargdefaults=1
   and pg_get_function_identity_arguments(p.oid)='p_target_date date, p_unit_id uuid'
   and pg_get_function_result(p.oid)='TABLE(waitlist_id uuid, unit_id uuid, customer_phone text, customer_name text, party_size integer, code integer)'
   and pg_get_expr(p.proargdefaults,0)='NULL::uuid') then raise exception 'task48_selector_drift'; end if;
 if has_function_privilege('anon','public.get_waitlist_for_feedback(date,uuid)','EXECUTE')
   or has_function_privilege('authenticated','public.get_waitlist_for_feedback(date,uuid)','EXECUTE')
   or not has_function_privilege('service_role','public.get_waitlist_for_feedback(date,uuid)','EXECUTE')
   or exists(select from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where p.oid='public.get_waitlist_for_feedback(date,uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')
   then raise exception 'task48_selector_acl_drift'; end if;
end $selector$;
`;
if(process.argv.length===3&&process.argv[2]==='--source-check'){
 console.log(`SOURCE48 actual048 selector sha256=${createHash('sha256').update(selector).digest('hex')}`);
 console.log(`SOURCE48 bridge sha256=${createHash('sha256').update(schema).digest('hex')}; SQL NOT executed`);process.exit(0);
}
function run(args,input){const r=spawnSync(docker,args,{input,encoding:'utf8',timeout:30000,windowsHide:true});if(r.status!==0)throw new Error(`task48_native_${r.status}`);return r.stdout.trim();}
if(process.argv.length!==2||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT||process.env.DOCKER_TLS_VERIFY||process.env.DOCKER_CERT_PATH)throw new Error('task48_override_refused');
if(run(['context','inspect','--format','{{ .Endpoints.docker.Host }}'])!=='npipe:////./pipe/dockerDesktopLinuxEngine'
 ||run(['inspect','--format','{{ .State.Running }}',container])!=='true'
 ||run(['inspect','--format','{{ .Name }}',container])!==`/${container}`
 ||run(['inspect','--format','{{ index .Config.Labels "com.supabase.cli.project" }}',container])!==project
 ||run(['inspect','--format','{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',container])!=='55452')throw new Error('task48_own_stack_required');
const sql=statement=>run(['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],statement);
// Full dependency definitions/ACLs and inherited table shape, excluding ONLY
// the two authorized additions. Existing NULL data and UUID defaults must survive.
const snapshot=`select jsonb_build_object(
 'columns',(select jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r' and not(c.relname='customers' and a.attname='birthday')),
 'relations',(select jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
 'constraints',(select jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,pg_get_constraintdef(oid),convalidated) order by conrelid,conname) from pg_constraint where connamespace='public'::regnamespace),
 'indexes',(select jsonb_agg(jsonb_build_array(indexrelid::regclass::text,pg_get_indexdef(indexrelid)) order by indexrelid) from pg_index where indrelid in(select oid from pg_class where relnamespace='public'::regnamespace)),
 'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.proacl) order by n.nspname,p.proname,p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private') and p.prokind='f' and p.proname<>'get_waitlist_for_feedback'),
 'legacy_source_null',(select count(*) from public.reservations where source is null),
 'legacy_voucher_null',(select count(*) from public.vouchers where rule_id is null or issued_at is null or code is null))::text;`;
const before=sql(snapshot);
let installed;
for(let pass=1;pass<=2;pass++){
 sql(`begin;set local lock_timeout='5s';set local statement_timeout='20s';${schema}commit;`);
 if(sql(snapshot)!==before)throw new Error('task48_unapproved_dependency_change');
 const after=sql("select jsonb_build_array(pg_get_functiondef('public.get_waitlist_for_feedback(date,uuid)'::regprocedure),(select proacl from pg_proc where oid='public.get_waitlist_for_feedback(date,uuid)'::regprocedure),(select to_jsonb(a) from pg_attribute a where attrelid='public.customers'::regclass and attname='birthday'))::text");
 if(installed&&installed!==after)throw new Error('task48_second_pass_changed');installed=after;
 console.log(`GREEN48 pass ${pass}; dependency shapes/ACL/body/NULL rows unchanged; nullable bridge only`);
}

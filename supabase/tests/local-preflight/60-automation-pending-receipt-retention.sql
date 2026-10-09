\set ON_ERROR_STOP on
-- ROOT only: established local bridge, exact cron quarantine, no Edge worker.
-- Run against the predecessor for RED, then CLI-applied migration for GREEN.
begin;
set local transaction isolation level read committed;
set local lock_timeout='5s'; set local statement_timeout='60s';
create temp table checks60(label text) on commit drop;
create function pg_temp.ok60(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL60 %',label; end if; insert into checks60 values(label); end $$;
create function pg_temp.job60(u uuid,c uuid,ch uuid,b uuid) returns uuid language plpgsql as $$
declare r uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); o uuid;
begin
 select organization_id into o from public.units where id=u;
 insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
 insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,
   channel_id,provider,binding_id,binding_generation,transport,state,due_at)
 values(j,u,o,'confirmation',r,c,'task60:'||r,clock_timestamp(),clock_timestamp()+interval '1 hour',ch,'zapi',b,1,'text','queued',clock_timestamp());
 return j;
end $$;
-- Synthetic historical PRECONDITION: recorder uses the real current clock and
-- immutable receipt timestamps cannot be aged by UPDATE. Scope triggers remain on.
create function pg_temp.old_receipt60(ch uuid,message text,s text,observed timestamptz,native timestamptz default null) returns uuid language plpgsql as $$
declare e uuid:=gen_random_uuid();
begin
 insert into public.whatsapp_automation_receipt_events(id,unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest,received_at)
 select e,c.unit_id,c.provider,c.id,message,s,native,encode(sha256(convert_to(e::text,'UTF8')),'hex'),observed
   from public.whatsapp_channels c where c.id=ch;
 if not found then raise exception 'historical receipt channel missing'; end if;
 return e;
end $$;
do $$ declare f oid:='public.purge_whatsapp_automation_workers(integer,integer)'::regprocedure; begin
 perform pg_temp.ok60(not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')),'persisted cron quarantine');
 perform pg_temp.ok60(not has_function_privilege('anon',f,'EXECUTE') and not has_function_privilege('authenticated',f,'EXECUTE')
   and has_function_privilege('service_role',f,'EXECUTE'),'purge native role ACL');
 perform pg_temp.ok60(not exists(select from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=f and a.grantee=0 and a.privilege_type='EXECUTE'),'purge PUBLIC denied');
 perform pg_temp.ok60((select prosecdef and provolatile='v' and pronargdefaults=0 and proconfig=array['search_path=""'] from pg_proc where oid=f),'purge definer signature and empty search_path');
 perform pg_temp.ok60(not has_table_privilege('service_role','public.whatsapp_automation_receipt_events','INSERT')
   and not has_table_privilege('service_role','public.whatsapp_automation_receipt_events','DELETE')
   and not has_table_privilege('service_role','public.whatsapp_automation_jobs','DELETE'),'direct insert and technical deletes remain revoked');
 perform pg_temp.ok60(not has_schema_privilege('anon','app_private','USAGE') and not has_schema_privilege('authenticated','app_private','USAGE'),'private schema remains closed to clients');
 perform pg_temp.ok60(not has_function_privilege('service_role','app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)','EXECUTE'),'private post authority remains denied');
end $$;
-- A genuine native service role call, without direct-table DELETE permission.
grant insert on checks60 to service_role;
set local role service_role;
select pg_temp.ok60(public.purge_whatsapp_automation_workers(0,0)->>'receipts_deleted'='0','native service purge executes');
reset role;
do $$ declare
 o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();u2 uuid:=gen_random_uuid();c uuid:=gen_random_uuid();a uuid:=gen_random_uuid();
 ch uuid:=gen_random_uuid();ch_alt uuid:=gen_random_uuid();ch_provider uuid:=gen_random_uuid();ch_unit uuid:=gen_random_uuid();b uuid:=gen_random_uuid();
 j uuid;j2 uuid;r uuid;n uuid:=gen_random_uuid();f uuid;rev bigint;receipt uuid;receipt2 uuid;result jsonb;before_job jsonb;before_legacy jsonb;before_receipt jsonb;
 observed timestamptz:=clock_timestamp()-interval '91 days';native timestamptz:=clock_timestamp()-interval '92 days';i integer;
begin
 insert into auth.users(id) values(a);insert into public.platform_admins values(a);
 insert into public.organizations(id,name) values(o,'Task60');
 insert into public.units(id,organization_id,name) values(u,o,'Task60'),(u2,o,'Task60 other');
 insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999996060');
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at)
 values(ch,u,'zapi','connected',true,clock_timestamp()),(ch_alt,u,'zapi','disconnected',false,clock_timestamp()),
   (ch_provider,u,'waha','disconnected',false,clock_timestamp()),(ch_unit,u2,'zapi','disconnected',false,clock_timestamp());
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values(b,u,ch,'zapi',1);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',a)::text,true);
 insert into public.whatsapp_automation_adoptions(unit_id) values(u),(u2);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 select template_credential_revision into rev from public.whatsapp_channels where id=ch;
 -- A genuine natural-key conflict, never overwritten by acceptance repair.
 j:=pg_temp.job60(u,c,ch,b);select reservation_id into r from public.whatsapp_automation_jobs where id=j;
 insert into public.notifications_sent(id,unit_id,reservation_id,kind,status,sent_at) values(n,u,r,'confirmation','sent',observed);
 select to_jsonb(x) into before_legacy from public.notifications_sent x where id=n;
 f:=gen_random_uuid();
 update public.whatsapp_automation_jobs set state='posting',claim_token=f,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic retention conflict' where id=j;
 perform pg_temp.ok60(public.finish_whatsapp_automation(j,f,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"conflict60"}'),'real finish records accepted evidence');
 result:=public.reconcile_whatsapp_automation_acceptance(j);
 perform pg_temp.ok60(result='{"state":"deferred","reason":"notification_conflict"}'::jsonb,'actual notification conflict defers acceptance');
 perform pg_temp.ok60(public.record_whatsapp_automation_receipts(ch,u,'zapi',rev,null,
   jsonb_build_array(jsonb_build_object('provider_message_id','fresh60','status','read','provider_timestamp',null)))->>'inserted'='1','real recorder admits fresh pending control');
 receipt:=pg_temp.old_receipt60(ch,'conflict60','read',observed);
 update public.whatsapp_automation_jobs set finished_at=observed where id=j;
 select to_jsonb(x) into before_job from public.whatsapp_automation_jobs x where id=j;
 select to_jsonb(x) into before_receipt from public.whatsapp_automation_receipt_events x where id=receipt;
 result:=public.purge_whatsapp_automation_workers(500,20);
 perform pg_temp.ok60((select to_jsonb(x)=before_job and state='accepted' and reconcile_required from public.whatsapp_automation_jobs x where id=j),'old accepted conflict job survives unchanged');
 -- This is the intended RED assertion against 20261009135808.
 perform pg_temp.ok60((select to_jsonb(x)=before_receipt and processing_state='pending' from public.whatsapp_automation_receipt_events x where id=receipt),'old pending correlated conflict receipt survives unchanged');
 perform pg_temp.ok60((select to_jsonb(x)=before_legacy from public.notifications_sent x where id=n),'purge preserves conflicting legacy notification');
 -- Resolve only our synthetic conflict, then project the ORIGINAL receipt clock.
 delete from public.notifications_sent where id=n;
 result:=public.reconcile_whatsapp_automation_receipts(j,20);
 perform pg_temp.ok60(result='{"state":"reconciled","processed":1}'::jsonb,'repair after conflict consumes retained receipt');
 perform pg_temp.ok60((select delivered_at=observed and read_at=observed and sent_at=observed from public.notifications_sent where id=(select notification_id from public.whatsapp_automation_jobs where id=j)),'absent native timestamp preserves original received_at');
 perform pg_temp.ok60((select processing_state='processed' and received_at=observed and provider_timestamp is null and processed_at>observed from public.whatsapp_automation_receipt_events where id=receipt),'repair changes processing only, retains receipt clocks');
 perform pg_temp.ok60((select state='reconciled' and not reconcile_required and attempts=1 and
   (to_jsonb(x)-array['state','reconcile_required','error_code','next_receipt_repair_at'])=(before_job-array['state','reconcile_required','error_code','next_receipt_repair_at']) from public.whatsapp_automation_jobs x where id=j),'repair preserves frozen posting evidence and one attempt');
 perform pg_temp.ok60(public.reconcile_whatsapp_automation_receipts(j,20)->>'processed'='0','repeat repair cannot consume twice');
 perform pg_temp.ok60((select count(*)=1 from public.conversations cv cross join lateral jsonb_array_elements(coalesce(cv.messages,'[]'::jsonb)) m
   where cv.unit_id=u and m->>'event_id'='automation:'||j::text||':accepted'),'repeat repair appends one acceptance history event');
 -- A locally reconciled job still needs later matched pending evidence.
 j2:=pg_temp.job60(u,c,ch,b);f:=gen_random_uuid();
 update public.whatsapp_automation_jobs set state='posting',claim_token=f,claimed_until=clock_timestamp()+interval '90 seconds',posting_started_at=clock_timestamp(),attempts=1,safe_log_body='Synthetic reconciled retention' where id=j2;
 perform public.finish_whatsapp_automation(j2,f,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"reconciled60"}');
 perform pg_temp.ok60(public.reconcile_whatsapp_automation_acceptance(j2)->>'state'='reconciled','second job genuinely reconciled');
 receipt2:=pg_temp.old_receipt60(ch,'reconciled60','delivered',observed,native);
 update public.whatsapp_automation_jobs set finished_at=observed where id=j2;
 -- Valid channel identities: independently vary native ID, channel, provider,
 -- and unit; provider/unit changes also need another channel by the scope trigger.
 perform pg_temp.old_receipt60(ch,'unmatched60','read',observed);
 perform pg_temp.old_receipt60(ch_alt,'reconciled60','read',observed);
 perform pg_temp.old_receipt60(ch_provider,'reconciled60','read',observed);
 perform pg_temp.old_receipt60(ch_unit,'reconciled60','read',observed);
 result:=public.purge_whatsapp_automation_workers(500,20);
 perform pg_temp.ok60(result->>'receipts_deleted'='5' and result->>'jobs_deleted'='1','processed match and four unmatched vectors expire; repaired terminal job purged');
 perform pg_temp.ok60(not exists(select from public.whatsapp_automation_jobs where id=j) and exists(select from public.whatsapp_automation_jobs where id=j2),'only outstanding reconciled job remains');
 perform pg_temp.ok60((select processing_state='pending' and received_at=observed and provider_timestamp=native from public.whatsapp_automation_receipt_events where id=receipt2),'reconciled job retains exact pending native-time receipt');
 perform pg_temp.ok60((select count(*)=2 from public.whatsapp_automation_receipt_events where unit_id in(u,u2)),'fresh receipt survives and mismatched receipts all expire');
 perform pg_temp.ok60((select delivered_at=observed and read_at=observed from public.notifications_sent where unit_id=u and reservation_id=r and kind='confirmation'),'legacy delivery projection outlives technical job purge');
 -- Eligibility filtering precedes LIMIT: a protected older row must not starve
 -- eligible unmatched rows. Zero/negative/max/NULL limits preserve the contract.
 for i in 1..3 loop
   perform pg_temp.old_receipt60(ch,'limit60:'||i,'sent',observed+interval '12 hours');
 end loop;
 perform pg_temp.ok60(public.purge_whatsapp_automation_workers(-1,-1)->>'receipts_deleted'='0','negative limit consumes nothing');
 result:=public.purge_whatsapp_automation_workers(1,0);
 perform pg_temp.ok60(result->>'receipts_deleted'='1' and result->>'receipt_limit'='1','protected oldest receipt does not occupy eligible limit');
 perform pg_temp.ok60((select count(*)=2 from public.whatsapp_automation_receipt_events where unit_id=u and provider_message_id like 'limit60:%'),'one-row limit leaves two unmatched');
 result:=public.purge_whatsapp_automation_workers(null,2147483647);
 perform pg_temp.ok60(result->>'receipt_limit'='500' and result->>'job_limit'='20' and result->>'receipts_deleted'='2','NULL receipt default and maximum job clamp');
 perform pg_temp.ok60(public.reconcile_whatsapp_automation_receipts(j2,20)->>'processed'='1','retained native-time receipt is repairable');
 perform pg_temp.ok60((select delivered_at=native and read_at is null from public.notifications_sent where id=(select notification_id from public.whatsapp_automation_jobs where id=j2)),'native provider timestamp wins over observation and repair');
 result:=public.purge_whatsapp_automation_workers(2147483647,20);
 perform pg_temp.ok60(result->>'receipt_limit'='500' and result->>'receipts_deleted'='1' and result->>'jobs_deleted'='1','processed receipt and terminal reconciled job eventually expire');
 perform pg_temp.ok60((select count(*)=1 from public.whatsapp_automation_receipt_events where unit_id in(u,u2) and provider_message_id='fresh60'),'fresh observation remains after every purge');
end $$;
select count(*) as passed60 from checks60;
rollback;

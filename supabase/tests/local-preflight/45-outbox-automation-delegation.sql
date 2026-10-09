\set ON_ERROR_STOP on
-- Real SQL controls after reviewed44 and migration; roles here are not JWT proof (47).
begin;
set local statement_timeout='30s';
create temp table checks45(label text) on commit drop;
create function pg_temp.ok45(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL45 %',label; end if; insert into checks45 values(label); end $$;
create function pg_temp.denied45(statement text,actor text) returns text language plpgsql as $$
declare message text;
begin
 execute format('set local role %I',actor);
 begin execute statement; exception when insufficient_privilege then get stacked diagnostics message=MESSAGE_TEXT; end;
 reset role;
 if message is null then raise exception 'FAIL45 expected 42501'; end if;
 return message;
end $$;
do $$
declare
 org uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); other_u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); r uuid; oid uuid; j uuid; tok uuid; initial uuid;
 s text; role_name text; sig text; got jsonb; before_row jsonb; before_time timestamptz; expected_status text; expected_disposition text;
 o public.notification_outbox%rowtype; n public.notification_outbox%rowtype; old_tuple app_private.notification_outbox_transition_tuple; new_tuple app_private.notification_outbox_transition_tuple;
 finished boolean; msg text; reference_message text; amount integer; tuple_count integer;
begin
 insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
 insert into public.organizations(id,name) values(org,'Task45 synthetic');
 insert into public.units(id,organization_id,name,slug,timezone) values(u,org,'Task45','task45-'||u,'America/Sao_Paulo'),(other_u,org,'Task45 foreign','task45-'||other_u,'America/Sao_Paulo');
 insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values(c,org,'Synthetic','55912345678',false,null);
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,clock_timestamp());
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values(b,u,ch,'zapi',clock_timestamp(),true);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.ok45((select catalog_class.relrowsecurity and catalog_class.relforcerowsecurity from pg_class catalog_class where catalog_class.oid='public.notification_outbox'::regclass)
  and not exists(select from pg_policy catalog_policy where catalog_policy.polrelid='public.notification_outbox'::regclass),'FORCE RLS and no policies');
 foreach role_name in array array['anon','authenticated'] loop
  perform pg_temp.ok45(not has_table_privilege(role_name,'public.notification_outbox','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'table ACL '||role_name);
 end loop;
 perform pg_temp.ok45(has_table_privilege('service_role','public.notification_outbox','SELECT') and has_table_privilege('service_role','public.notification_outbox','INSERT')
  and has_table_privilege('service_role','public.notification_outbox','UPDATE') and has_table_privilege('service_role','public.notification_outbox','DELETE')
  and not has_table_privilege('service_role','public.notification_outbox','TRUNCATE,REFERENCES,TRIGGER'),'service operational minimum');
 foreach sig in array array['claim_notification_outbox_initial(uuid)','delegate_notification_outbox_automation(uuid,uuid)',
  'poll_notification_outbox_automation(uuid)','defer_notification_outbox_automation_dependency(uuid)',
  'finish_notification_outbox_initial(uuid,uuid)','recover_delegated_notification_outbox(integer)'] loop
  perform pg_temp.ok45(has_function_privilege('service_role','public.'||sig,'EXECUTE')
   and not has_function_privilege('anon','public.'||sig,'EXECUTE') and not has_function_privilege('authenticated','public.'||sig,'EXECUTE')
   and (select catalog_proc.prosecdef and catalog_proc.proconfig=array['search_path=""'] from pg_proc catalog_proc where catalog_proc.oid=('public.'||sig)::regprocedure),'RPC ACL/config '||sig);
 end loop;
 foreach role_name in array array['anon','authenticated','service_role'] loop
  perform pg_temp.ok45(not has_type_privilege(role_name,'app_private.notification_outbox_mutation_action','USAGE')
   and not has_type_privilege(role_name,'app_private.notification_outbox_transition_tuple','USAGE')
   and not has_type_privilege(role_name,'app_private.notification_outbox_automation_projection','USAGE')
   and not has_table_privilege(role_name,'app_private.notification_outbox_mutation_permits','SELECT,INSERT,UPDATE,DELETE')
   and not has_function_privilege(role_name,'public.guard_notification_outbox_automation()','EXECUTE')
   and not has_function_privilege(role_name,'public.guard_notification_outbox_insert_scope()','EXECUTE')
   and not has_function_privilege(role_name,'app_private.map_notification_outbox_automation_state(text)','EXECUTE')
   and not has_function_privilege(role_name,'app_private.consume_notification_outbox_mutation(uuid,app_private.notification_outbox_transition_tuple,app_private.notification_outbox_transition_tuple)','EXECUTE'),'private ACL '||role_name);
 end loop;
 -- Source exclusion is the actual028 trigger, and manual notify is a real INSERT.
 r:=gen_random_uuid();
 insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
  values(r,u,c,current_date+1,'23:59','confirmed',null,'whatsapp',4,'TASK45-'||r,null,null);
 perform pg_temp.ok45(not exists(select from public.notification_outbox where reservation_id=r),'actual trigger suppresses WhatsApp');
 insert into public.notification_outbox(reservation_id,unit_id,kind) values(r,u,'confirmation') returning id into oid;
 perform pg_temp.ok45(oid is not null,'manual WhatsApp outbox allowed');
 -- The same table privilege refusal occurs before the definer guard for matching/foreign/missing/markers.
 foreach role_name in array array['anon','authenticated'] loop
  reference_message:=null;
  foreach s in array array[
   format('insert into public.notification_outbox(reservation_id,unit_id,kind) values(%L,%L,''confirmation'')',r,u),
   format('insert into public.notification_outbox(reservation_id,unit_id,kind) values(%L,%L,''confirmation'')',r,other_u),
   format('insert into public.notification_outbox(reservation_id,unit_id,kind) values(%L,%L,''confirmation'')',gen_random_uuid(),u),
   format('insert into public.notification_outbox(reservation_id,unit_id,kind,automation_initial_token) values(%L,%L,''confirmation'',%L)',r,u,gen_random_uuid())] loop
    msg:=pg_temp.denied45(s,role_name);
    if reference_message is null then reference_message:=msg; end if;
    perform pg_temp.ok45(msg=reference_message and msg like '%permission denied for table notification_outbox%','table refusal no oracle '||role_name);
  end loop;
 end loop;
 perform pg_temp.ok45(pg_temp.denied45(format('insert into public.notification_outbox(reservation_id,unit_id,kind) values(%L,%L,''confirmation'')',r,other_u),'service_role')='outbox_insert_refused','service cross-unit guard');
 perform pg_temp.ok45(pg_temp.denied45(format('insert into public.notification_outbox(reservation_id,unit_id,kind,automation_initial_token) values(%L,%L,''confirmation'',%L)',r,u,gen_random_uuid()),'service_role')='outbox_insert_refused','service forged insert marker');
 -- Narrow SDK CAS replaces caller future time, without granting initial ownership.
 before_time:=clock_timestamp();
 set local role service_role;
 update public.notification_outbox set status='processing',updated_at=clock_timestamp()+interval '40 years' where id=oid and status='pending';
 reset role;
 perform pg_temp.ok45((select updated_at between before_time and clock_timestamp() and automation_initial_token is null from public.notification_outbox where id=oid),'managed CAS SQL post-lock clock');
 before_row:=(select to_jsonb(x) from public.notification_outbox x where id=oid);
 perform pg_temp.ok45(pg_temp.denied45(format('update public.notification_outbox set attempts=attempts+1 where id=%L',oid),'service_role')='outbox_mutation_refused','managed SDK attempts refused');
 perform pg_temp.ok45(pg_temp.denied45(format('update public.notification_outbox set kind=''cancellation'' where id=%L',oid),'service_role')='outbox_mutation_refused','scope escape refused');
 perform pg_temp.ok45(pg_temp.denied45(format('update public.notification_outbox set status=''done'' where id=%L',oid),'service_role')='outbox_permit_required','generic outcome refused');
 begin
  perform public.claim_notification_outbox_initial(oid);
  raise exception 'fixture_rollback' using errcode='P0450';
 exception when sqlstate 'P0450' then null; end;
 perform pg_temp.ok45((select to_jsonb(x)=before_row from public.notification_outbox x where id=oid),'initial token rolls back');
 set local role service_role; tok:=public.claim_notification_outbox_initial(oid); initial:=public.claim_notification_outbox_initial(oid); reset role;
 perform pg_temp.ok45(tok is not null and initial is null,'one initial winner');
 perform public.mark_outbox_done(oid); perform public.mark_outbox_failed(oid,'untrusted');
 perform pg_temp.ok45((select status='processing' and attempts=0 and automation_initial_token=tok from public.notification_outbox where id=oid),'legacy helpers cannot mutate token owner');
 -- All13 actual stored states, natural ledger-first, and current proof across terminal finish.
 foreach s in array array['queued','claimed','posting','retry_wait','blocked','paused','needs_review','uncertain','accepted','reconciled','expired','rejected','failed'] loop
  r:=gen_random_uuid(); j:=gen_random_uuid();
  insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
   values(r,u,c,current_date+1,'23:59','confirmed',null,'web',4,'TASK45-'||r,null,null);
  select id into oid from public.notification_outbox where reservation_id=r and kind='confirmation';
  perform pg_temp.ok45(oid is not null,'actual web trigger '||s);
  insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,
    channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,attempts,provider_message_id)
   values(j,u,org,'confirmation',r,c,'task45-'||s,clock_timestamp(),clock_timestamp()+interval '1 day',ch,'zapi',b,1,'text',s,
    case when s in('claimed','posting','uncertain') then gen_random_uuid() end,
    case when s in('claimed','posting','uncertain') then clock_timestamp()+interval '90 seconds' end,0,
    case when s in('accepted','reconciled') then 'task45-native-'||s end);
  update public.notification_outbox set status='processing',updated_at=clock_timestamp() where id=oid and status='pending';
  got:=public.poll_notification_outbox_automation(oid);
  perform pg_temp.ok45(got->>'reason'='automation_initial_unclaimed' and (select status='processing' from public.notification_outbox where id=oid),'poll cannot preempt first email '||s);
  set local role service_role;
  tok:=public.claim_notification_outbox_initial(oid);
  if not public.delegate_notification_outbox_automation(oid,j) then raise exception 'FAIL45 delegate'; end if;
  got:=public.poll_notification_outbox_automation(oid);
  reset role;
  expected_status:=case when s in('accepted','reconciled','expired') then 'done' when s in('rejected','failed') then 'dead' else 'pending' end;
  expected_disposition:=case when s in('accepted','reconciled') then 'accepted' when s='expired' then 'discarded' when s in('rejected','failed') then s else 'pending' end;
  perform pg_temp.ok45(got=jsonb_build_object('ledger_state',s,'outbox_status',expected_status,'disposition',expected_disposition,
   'reason','automation_'||s,'retry_after_seconds',case when expected_status='pending' then 60 else null end),'exact five-key13state '||s);
  perform pg_temp.ok45((select attempts=0 and automation_initial_token=tok and automation_job_id=j
    and (status<>'pending' or next_attempt_at=updated_at+interval '60 seconds') from public.notification_outbox where id=oid),'facts and SQL60 '||s);
  before_row:=(select to_jsonb(x) from public.notification_outbox x where id=oid);
  perform pg_temp.ok45(not public.finish_notification_outbox_initial(oid,gen_random_uuid())
    and (select to_jsonb(x)=before_row from public.notification_outbox x where id=oid),'wrong token zero effect '||s);
  perform pg_temp.ok45(public.finish_notification_outbox_initial(oid,tok),'healthy original owner survives poll '||s);
  if s='failed' then
    perform pg_temp.ok45((select status='dead' from public.notification_outbox where id=oid),'dead current failed stays dead');
    update public.whatsapp_automation_jobs set state='accepted',provider_message_id='late-task45-native' where id=j;
    finished:=public.finish_notification_outbox_initial(oid,tok);
    perform pg_temp.ok45(finished and (select status='done' and last_error is null from public.notification_outbox where id=oid),'dead corrected by current accepted');
    update public.whatsapp_automation_jobs set state='failed' where id=j;
    perform public.poll_notification_outbox_automation(oid);
    delete from public.whatsapp_automation_jobs where id=j;
    finished:=public.finish_notification_outbox_initial(oid,tok);
    perform pg_temp.ok45(finished and (select status='pending' and last_error='automation_job_missing' and automation_job_id=j from public.notification_outbox where id=oid),'dead no proof cannot invent success; pin survives purge');
  end if;
 end loop;
 -- No-job suppression is owner-only, and only positive original facts count.
 r:=gen_random_uuid();
 insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
  values(r,u,c,current_date+1,'23:59','confirmed',null,'whatsapp',4,'TASK45-'||r,null,null);
 insert into public.notification_outbox(reservation_id,unit_id,kind,created_at) values(r,u,'confirmation',clock_timestamp()-interval '30 days') returning id into oid;
 update public.notification_outbox set status='processing',updated_at=clock_timestamp() where id=oid;
 tok:=public.claim_notification_outbox_initial(oid);
 perform pg_temp.ok45(public.poll_notification_outbox_automation(oid)->>'reason'='automation_initial_unfinished','no-job poll preserves first email opportunity');
 finished:=public.finish_notification_outbox_initial(oid,tok);
    perform pg_temp.ok45(finished and public.poll_notification_outbox_automation(oid)->>'reason'='automation_before_adoption','original cutoff suppression');
 perform pg_temp.ok45(public.finish_notification_outbox_initial(oid,tok),'repeat finish no replay');
 -- Failed and email receipts are not proof; a current exact sent receipt is positive.
 r:=gen_random_uuid();
 insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
  values(r,u,c,current_date+1,'23:59','confirmed',null,'whatsapp',4,'TASK45-'||r,null,null);
 insert into public.notification_outbox(reservation_id,unit_id,kind,created_at) values(r,u,'confirmation',clock_timestamp()) returning id into oid;
 update public.notification_outbox set status='processing',updated_at=clock_timestamp() where id=oid;
 tok:=public.claim_notification_outbox_initial(oid);
 insert into public.notifications_sent(unit_id,reservation_id,kind,status) values(u,r,'confirmation','failed'),(u,r,'confirmation_email','sent');
 finished:=public.finish_notification_outbox_initial(oid,tok);
 perform pg_temp.ok45(finished
  and public.poll_notification_outbox_automation(oid)->>'reason'='automation_dependency_unavailable','failed and email are not WhatsApp acceptance');
 update public.notifications_sent set status='sent' where unit_id=u and reservation_id=r and kind='confirmation';
 perform pg_temp.ok45(public.poll_notification_outbox_automation(oid)->>'reason'='automation_initial_unfinished','poll cannot first-settle legacy receipt');
 finished:=public.finish_notification_outbox_initial(oid,tok);
 perform pg_temp.ok45(finished
  and public.poll_notification_outbox_automation(oid)->>'reason'='automation_legacy_accepted','owner exact current sent acceptance');
 -- Exact permit one-use, type/null tuple equality, rollback and no caller minting.
 select * into o from public.notification_outbox where id=oid; n:=o; n.status:='pending'; n.updated_at:=clock_timestamp();
 n.next_attempt_at:=n.updated_at+interval '60 seconds'; n.last_error:='automation_dependency_unavailable';
 old_tuple:=row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token);
 new_tuple:=row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token);
 insert into app_private.notification_outbox_mutation_permits values(txid_current(),oid,'poll',old_tuple,new_tuple);
 update public.notification_outbox set status=n.status,next_attempt_at=n.next_attempt_at,last_error=n.last_error,updated_at=n.updated_at where id=oid;
 perform pg_temp.ok45(not exists(select from app_private.notification_outbox_mutation_permits where outbox_id=oid),'exact permit consumed once');
 perform pg_temp.ok45(pg_temp.denied45(format('update public.notification_outbox set status=''pending'' where id=%L',oid),'service_role')='outbox_permit_required','consumed permit cannot replay');
 perform pg_temp.ok45(pg_temp.denied45(format('insert into app_private.notification_outbox_mutation_permits select txid_current(),id,''poll'',row(id,reservation_id,unit_id,kind,attempts,next_attempt_at,status,last_error,created_at,updated_at,automation_job_id,automation_initial_token)::app_private.notification_outbox_transition_tuple,row(id,reservation_id,unit_id,kind,attempts,next_attempt_at,status,last_error,created_at,updated_at,automation_job_id,automation_initial_token)::app_private.notification_outbox_transition_tuple from public.notification_outbox where id=%L',oid),'service_role') like '%permission denied%','caller cannot forge typed permit');
 -- Wrong transaction and any exact-tuple drift fail; subtransaction rollback removes minted authority.
 foreach s in array array['wrong_transaction','wrong_tuple','extra_scope','bad_action'] loop
  before_row:=(select to_jsonb(x) from public.notification_outbox x where id=oid);
  begin
   select * into o from public.notification_outbox where id=oid; n:=o;
   n.updated_at:=clock_timestamp(); n.next_attempt_at:=n.updated_at+interval '60 seconds';
   old_tuple:=row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token);
   new_tuple:=row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token);
   if s='wrong_tuple' then new_tuple.last_error:=null; end if;
   insert into app_private.notification_outbox_mutation_permits values(case when s='wrong_transaction' then txid_current()+1 else txid_current() end,
    oid,case when s='bad_action' then 'initial_claim'::app_private.notification_outbox_mutation_action else 'poll'::app_private.notification_outbox_mutation_action end,old_tuple,new_tuple);
   update public.notification_outbox set next_attempt_at=n.next_attempt_at,updated_at=n.updated_at,
    unit_id=case when s='extra_scope' then other_u else n.unit_id end where id=oid;
   raise exception 'FAIL45 bad permit admitted';
  exception when insufficient_privilege then null; end;
  perform pg_temp.ok45((select to_jsonb(x)=before_row from public.notification_outbox x where id=oid)
   and not exists(select from app_private.notification_outbox_mutation_permits where outbox_id=oid),'invalid permit rollback '||s);
 end loop;
 -- Never-adopted dependency is a permitted defer, not a new adoption/token/job or legacy send.
 r:=gen_random_uuid();
 insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
  values(r,other_u,c,current_date+1,'23:59','confirmed',null,'web',4,'TASK45-'||r,null,null);
 select id into oid from public.notification_outbox where reservation_id=r;
 update public.notification_outbox set status='processing',updated_at=clock_timestamp()+interval '40 years' where id=oid;
 perform pg_temp.ok45((select updated_at>clock_timestamp()+interval '39 years' from public.notification_outbox where id=oid),'legacy SDK timestamp unchanged');
 before_time:=clock_timestamp();
 set local role service_role; initial:=null;
 if not public.defer_notification_outbox_automation_dependency(oid) then raise exception 'FAIL45 never-adopted defer'; end if;
 reset role;
 perform pg_temp.ok45((select status='pending' and attempts=0 and automation_initial_token is null and automation_job_id is null
   and next_attempt_at=updated_at+interval '60 seconds' and updated_at between before_time and clock_timestamp()
   and last_error='automation_dependency_unavailable' from public.notification_outbox where id=oid)
   and not exists(select from app_private.notification_outbox_mutation_permits where outbox_id=oid),'never-adopted exact defer no orphan');
 perform public.mark_outbox_failed(oid,'legacy-native');
 perform pg_temp.ok45((select attempts=1 and status='pending' and last_error='legacy-native' from public.notification_outbox where id=oid),'legacy failed retains attempts/backoff');
 perform public.mark_outbox_done(oid);
 perform pg_temp.ok45((select status='done' and attempts=1 and last_error is null and automation_initial_token is null and automation_job_id is null from public.notification_outbox where id=oid),'legacy done unchanged');
 perform pg_temp.ok45((select count(*)=0 from public.recover_delegated_notification_outbox(0)),'recovery zero is no-op');
 perform pg_temp.ok45(not exists(select from app_private.notification_outbox_mutation_permits),'no orphan permit');
end $$;
select label from checks45 order by label;
select 'GREEN45 controls='||count(*) from checks45;
rollback;

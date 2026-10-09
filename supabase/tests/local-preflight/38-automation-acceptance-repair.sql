\set ON_ERROR_STOP on
-- Only after the guarded 38 setup and CLI application of the new migration.
-- Fixture posting rows are synthetic; this proves SQL repair, not provider POST.
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
create temp table acceptance_checks(label text);
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin
 if v is distinct from true then raise exception 'FAIL: %',label; end if;
 insert into acceptance_checks values(label);
end $$;
create function pg_temp.posted_job(u uuid,c uuid,ch uuid,b uuid,body text default 'Frozen acceptance [redacted]') returns uuid
language plpgsql as $$
declare r uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); o uuid;
begin
 select organization_id into o from public.units where id=u;
 insert into public.reservations(id,unit_id,customer_id) values(r,u,c);
 insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,
  source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,
  state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
 values(j,u,o,'confirmation',r,c,'task38:'||r::text,clock_timestamp(),clock_timestamp()+interval '1 hour',
  ch,'zapi',b,1,'text','posting',f,clock_timestamp()+interval '90 seconds',clock_timestamp(),1,body);
 return j;
end $$;
create function pg_temp.accepted_job(u uuid,c uuid,ch uuid,b uuid,body text default 'Frozen acceptance [redacted]') returns uuid
language plpgsql as $$
declare j uuid; f uuid;
begin
 j:=pg_temp.posted_job(u,c,ch,b,body);
 select claim_token into f from public.whatsapp_automation_jobs where id=j;
 perform pg_temp.ok(public.finish_whatsapp_automation(j,f,jsonb_build_object('outcome','accepted','reason','provider_accepted',
  'provider_message_id','task38:'||j::text)),'real finish records acceptance evidence before repair');
 return j;
end $$;
-- Reject execution inherited from PUBLIC, including the owner-independent ACL view.
do $$ declare f oid:='public.reconcile_whatsapp_automation_acceptance(uuid)'::regprocedure; begin
 perform pg_temp.ok(not has_function_privilege('anon',f,'execute'),'anon cannot execute repair');
 perform pg_temp.ok(not has_function_privilege('authenticated',f,'execute'),'authenticated cannot execute repair');
 perform pg_temp.ok(has_function_privilege('service_role',f,'execute'),'service can execute repair');
 perform pg_temp.ok(not exists(select from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid=f and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC cannot execute repair');
 perform pg_temp.ok((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid=f),'definer with empty search_path');
end $$;
do $cases$ declare
 o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
 j uuid; j2 uuid; n uuid; r uuid; f uuid; result jsonb; before_row jsonb; accepted_at timestamptz; counter integer;
 conversation_a uuid; conversation_b uuid:=gen_random_uuid(); other_unit uuid:=gen_random_uuid(); other_customer uuid:=gen_random_uuid();
 history_a jsonb; history_b jsonb;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.organizations(id,name) values(o,'Task38 synthetic');
 insert into public.units(id,organization_id,name) values(u,o,'Task38');
 insert into public.customers(id,organization_id,name,phone) values(c,o,'Synthetic','11999993838');
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at)
  values(ch,u,'zapi','connected',true,clock_timestamp());
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values(b,u,ch,'zapi',1);
 j:=pg_temp.accepted_job(u,c,ch,b);
 select notification_id,finished_at,reservation_id into n,accepted_at,r from public.whatsapp_automation_jobs where id=j;
 -- The same event outside the exact unit/customer pair cannot suppress history.
 insert into public.units(id,organization_id,name) values(other_unit,o,'Task38 other unit');
 insert into public.customers(id,organization_id,name,phone) values(other_customer,o,'Other synthetic','11999993839');
 insert into public.conversations(unit_id,customer_id,messages) values
  (other_unit,c,jsonb_build_array(jsonb_build_object('event_id','automation:'||j::text||':accepted','content','foreign unit decoy'))),
  (u,other_customer,jsonb_build_array(jsonb_build_object('event_id','automation:'||j::text||':accepted','content','foreign customer decoy')));
 result:=public.reconcile_whatsapp_automation_acceptance(j);
 perform pg_temp.ok(result='{"state":"reconciled","history":"recorded"}'::jsonb,'accepted local projections reconcile');
 perform pg_temp.ok((select state='reconciled' and not reconcile_required and attempts=1 and finished_at=accepted_at
  from public.whatsapp_automation_jobs where id=j),'repair preserves attempt and original acceptance timeline');
 perform pg_temp.ok((select unit_id=u and reservation_id=r and waitlist_id is null and kind='confirmation' and status='sent'
  and sent_at=accepted_at and whatsapp_provider='zapi' and whatsapp_channel_id=ch and provider_message_id='task38:'||j::text
  from public.notifications_sent where id=n),'notification exact UUID resource and four fields');
 perform pg_temp.ok((select count(*)=1 from public.conversations where customer_id=c and unit_id=u),'real get-or-create called');
 perform pg_temp.ok((select messages->0->>'event_id'='automation:'||j::text||':accepted'
  and messages->0->>'content'='Frozen acceptance [redacted]' and messages->0->>'author'='automation'
  and messages->0->>'role'='assistant' and (messages->0->>'timestamp')::timestamptz=accepted_at
  from public.conversations where customer_id=c and unit_id=u),'real append uses frozen body event author and timeline');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j)=result,'idempotent response');
 perform pg_temp.ok((select jsonb_array_length(messages)=1 from public.conversations where customer_id=c and unit_id=u),'real append dedupe');
 update public.notifications_sent set delivered_at=accepted_at,read_at=accepted_at,failed_at=accepted_at,status='failed',error='synthetic_evidence' where id=n;
 select to_jsonb(x) into before_row from public.notifications_sent x where id=n;
 perform public.reconcile_whatsapp_automation_acceptance(j);
 perform pg_temp.ok((select to_jsonb(x)=before_row from public.notifications_sent x where id=n),'all delivery read failure status and error evidence preserved');

 -- Multiple conversations are legitimate. A newer B must not receive A's event.
 select id,to_jsonb(x) into conversation_a,history_a from public.conversations x where customer_id=c and unit_id=u;
 insert into public.conversations(id,unit_id,customer_id,messages,updated_at)
  values(conversation_b,u,c,'[{"event_id":"task38:human","role":"assistant","author":"human","content":"Keep B unchanged","timestamp":"2026-01-01T00:00:00Z"}]',clock_timestamp()+interval '1 minute');
 select to_jsonb(x) into history_b from public.conversations x where id=conversation_b;
 perform pg_temp.ok((select id=conversation_b from public.conversations where unit_id=u and customer_id=c order by updated_at desc,id limit 1),'B really becomes latest conversation');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j)=result,'direct repeat across newer conversation keeps recorded result');
 perform pg_temp.ok((select count(*)=1 from public.conversations x cross join lateral jsonb_array_elements(x.messages) e
  where x.unit_id=u and x.customer_id=c and e->>'event_id'='automation:'||j::text||':accepted'),'one accepted event across exact pair after direct repeat');
 perform pg_temp.ok((select to_jsonb(x)=history_a from public.conversations x where id=conversation_a)
  and (select to_jsonb(x)=history_b from public.conversations x where id=conversation_b),'repeat changes neither A nor B history/timestamps');
 -- Exercise the real deferred path; never manufacture an accepted state.
 update public.notifications_sent set provider_message_id='task38:mismatch' where id=n;
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j)='{"state":"deferred","reason":"notification_conflict"}'::jsonb,'repaired job genuinely defers on exact notification mismatch');
 perform pg_temp.ok((select state='accepted' and reconcile_required and finished_at=accepted_at and attempts=1
  from public.whatsapp_automation_jobs where id=j),'real deferral preserves accepted evidence');
 update public.notifications_sent set provider_message_id='task38:'||j::text where id=n;
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j)=result,'repeat after real deferral repairs same recorded history');
 perform pg_temp.ok((select count(*)=1 from public.conversations x cross join lateral jsonb_array_elements(x.messages) e
  where x.unit_id=u and x.customer_id=c and e->>'event_id'='automation:'||j::text||':accepted'),'one accepted event across pair after deferral');
 perform pg_temp.ok((select to_jsonb(x)=before_row from public.notifications_sent x where id=n)
  and (select to_jsonb(x)=history_a from public.conversations x where id=conversation_a)
  and (select to_jsonb(x)=history_b from public.conversations x where id=conversation_b),'deferral repeat preserves notification and both conversation snapshots');
 perform pg_temp.ok((select state='reconciled' and not reconcile_required and finished_at=accepted_at and attempts=1
  from public.whatsapp_automation_jobs where id=j),'deferral repeat restores reconciled without changing acceptance timeline');

 j2:=pg_temp.accepted_job(u,c,ch,b);
 select notification_id,reservation_id into n,r from public.whatsapp_automation_jobs where id=j2;
 insert into public.notifications_sent(unit_id,reservation_id,kind,status) values(u,r,'confirmation','sent');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)='{"state":"deferred","reason":"notification_conflict"}'::jsonb,'legacy natural unique conflict defers');
 perform pg_temp.ok(not exists(select from public.notifications_sent where id=n),'legacy UUID never replaced');
 perform pg_temp.ok((select state='accepted' and reconcile_required from public.whatsapp_automation_jobs where id=j2),'conflict retains acceptance and pending repair');
 delete from public.notifications_sent where reservation_id=r;
 insert into public.notifications_sent(id,unit_id,reservation_id,kind,status,whatsapp_provider,whatsapp_channel_id,provider_message_id)
  values(n,u,r,'confirmation','sent','zapi',ch,'different-synthetic-message');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)->>'reason'='notification_conflict','same PK mismatched provider message defers');
 delete from public.notifications_sent where id=n;

 -- The append fault is a harness-only trigger. Existing RPC bodies stay intact.
 execute $ddl$create function pg_temp.reject_acceptance_append() returns trigger language plpgsql as $body$
  begin raise exception 'synthetic_append_failure' using errcode='P0038'; end $body$$ddl$;
 execute 'create trigger task38_append_fault before update of messages on public.conversations for each row execute function pg_temp.reject_acceptance_append()';
 begin
  perform public.reconcile_whatsapp_automation_acceptance(j2);
  raise exception 'FAIL: expected append fault';
 exception when sqlstate 'P0038' then null;
 end;
 perform pg_temp.ok(not exists(select from public.notifications_sent where id=n),'append failure rolls back notification');
 perform pg_temp.ok((select state='accepted' and reconcile_required and provider_message_id is not null from public.whatsapp_automation_jobs where id=j2),'append failure preserves previously accepted evidence');
 execute 'drop trigger task38_append_fault on public.conversations';
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)->>'state'='reconciled','retry repairs without post');

 j2:=pg_temp.posted_job(u,c,ch,b);
 select claim_token,notification_id into f,n from public.whatsapp_automation_jobs where id=j2;
 perform pg_temp.ok(public.finish_whatsapp_automation(j2,f,'{"outcome":"uncertain","reason":"post_ambiguous"}'::jsonb),'real uncertain finish has no invented provider ID');
 select to_jsonb(x) into before_row from public.whatsapp_automation_jobs x where id=j2;
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)='{"state":"not_accepted","reason":"acceptance_not_recorded"}'::jsonb,'uncertain without ID cannot repair acceptance');
 perform pg_temp.ok((select to_jsonb(x)=before_row from public.whatsapp_automation_jobs x where id=j2),'uncertain repair refusal leaves job unchanged');
 perform pg_temp.ok(not exists(select from public.notifications_sent where id=n),'uncertain refusal writes no notification');

 -- Nullable operational entry can project acceptance without resolving by phone.
 r:=gen_random_uuid(); j2:=gen_random_uuid(); f:=gen_random_uuid();
 insert into public.waitlist(id,unit_id,customer_phone,customer_name) values(r,u,'11911113838','Unknown synthetic');
 insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,waitlist_id,customer_id,
  source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,
  state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
 values(j2,u,o,'waitlist_entered',r,null,'task38-null-entry',clock_timestamp(),clock_timestamp()+interval '2 hours',
  ch,'zapi',b,1,'text','posting',f,clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Operational entry');
 perform pg_temp.ok(public.finish_whatsapp_automation(j2,f,jsonb_build_object('outcome','accepted','reason','provider_accepted',
  'provider_message_id','task38:'||j2::text)),'actual finish nullable entry');
 select count(*) into counter from public.conversations where unit_id=u;
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)='{"state":"reconciled","history":"skipped_no_customer"}'::jsonb,'operational unknown customer skips history');
 perform pg_temp.ok((select count(*)=counter from public.conversations where unit_id=u),'operational repair creates no customer conversation');

 j2:=pg_temp.accepted_job(u,c,ch,b);
 select notification_id into n from public.whatsapp_automation_jobs where id=j2;
 select sum(jsonb_array_length(messages)) into counter from public.conversations where customer_id=c and unit_id=u;
 update public.customers set deleted_at=clock_timestamp() where id=c;
 perform pg_temp.ok((select customer_id is null and customer_erased_at is not null and safe_log_body is null from public.whatsapp_automation_jobs where id=j2),'actual erasure trigger removes personal acceptance snapshot');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)='{"state":"reconciled","history":"skipped_erased"}'::jsonb,'erased job repairs technical projection only');
 perform pg_temp.ok((select sum(jsonb_array_length(messages))=counter from public.conversations where customer_id=c and unit_id=u),'erased repair never restores text');
 perform pg_temp.ok(exists(select from public.notifications_sent where id=n),'erased technical notification present');
 delete from public.whatsapp_channels where id=ch;
 perform pg_temp.ok((select whatsapp_channel_id is null from public.notifications_sent where id=n),'actual notification FK sets channel NULL');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(j2)->>'reason'='notification_channel_missing','deleted historical channel defers without substitution');
 perform pg_temp.ok((select state='accepted' and reconcile_required from public.whatsapp_automation_jobs where id=j2),'lost channel after local completion makes pending repair visible');
 perform pg_temp.ok(public.reconcile_whatsapp_automation_acceptance(gen_random_uuid())='{"state":"not_accepted","reason":"job_not_found"}'::jsonb,'missing job has no acceptance');
end $cases$;
select count(*) as acceptance_sql_checks from acceptance_checks;
rollback;

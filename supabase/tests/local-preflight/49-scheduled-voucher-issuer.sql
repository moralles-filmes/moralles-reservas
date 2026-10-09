\set ON_ERROR_STOP on
-- Actual PostgreSQL gates after approved48 + migration via db push --local.
-- Everything rolls back. SET ROLE is ACL evidence, not JWT (gate51).
begin;
set local statement_timeout='30s';
set local lock_timeout='5s';
create temp table checks49(label text) on commit drop;
create function pg_temp.ok49(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL49 %',label; end if; insert into checks49 values(label); end $$;
create function pg_temp.expected49(rid uuid,day date default ((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date)
returns jsonb language sql as $$
 select jsonb_build_object('unit_id',unit_id,'trigger_type',trigger_type,'discount_percent',discount_percent,
  'validity_days',validity_days,'visits_required',visits_required,'days_window',days_window,'selected_brt_day',day)
 from public.voucher_rules where id=rid
$$;
create function pg_temp.error49(statement text,expected_state text,label text) returns void language plpgsql as $$
declare caught text; before_v bigint; before_j bigint;
begin
 select count(*) into before_v from public.vouchers; select count(*) into before_j from public.whatsapp_automation_jobs;
 begin execute statement; exception when others then get stacked diagnostics caught=RETURNED_SQLSTATE; end;
 perform pg_temp.ok49(caught=expected_state,label||' exact SQLSTATE');
 perform pg_temp.ok49((select count(*)=before_v from public.vouchers) and (select count(*)=before_j from public.whatsapp_automation_jobs),label||' no artifact delta');
end $$;
-- Test-only fault AFTER job insertion, never a product clock/issuer replacement.
create function pg_temp.late_failure49() returns trigger language plpgsql as $$
begin
 if current_setting('task49.late_failure',true)='unique' then raise unique_violation using message='task49_late_unique'; end if;
 if current_setting('task49.late_failure',true)='error' then raise exception 'task49_late_error' using errcode='P0001'; end if;
 return new;
end $$;
create trigger task49_late_failure after insert on public.whatsapp_automation_jobs for each row execute function pg_temp.late_failure49();
do $$
declare
 o uuid:=gen_random_uuid(); foreign_o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); other_u uuid:=gen_random_uuid(); missing_u uuid:=gen_random_uuid(); foreign_u uuid:=gen_random_uuid();
 c uuid:=gen_random_uuid(); other_c uuid:=gen_random_uuid(); foreign_c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); frequency uuid:=gen_random_uuid(); foreign_r uuid:=gen_random_uuid();
 actual record; next_issue record; v public.vouchers%rowtype; j public.whatsapp_automation_jobs%rowtype;
 stamp timestamptz:=clock_timestamp(); day date:=((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date;
 expected jsonb; changed jsonb; field text; raw jsonb; sig text:='public.issue_scheduled_whatsapp_voucher(uuid,uuid,text,jsonb)';
 tz text; vector record; calculated timestamptz; actual_deadline timestamptz; expiry_expr text; deadline_expr text;
 w uuid:=gen_random_uuid(); w2 uuid:=gen_random_uuid();
begin
 if ((stamp at time zone 'UTC')-interval '3 hours')::time>='23:50'::time then raise exception 'task49_optional_boundary_requires_separate_method'; end if;
 insert into auth.users(id) values(actor);insert into public.platform_admins values(actor);
 insert into public.organizations(id,name) values(o,'Task49'),(foreign_o,'Task49 foreign');
 insert into public.units(id,organization_id,name,slug,timezone) values
  (u,o,'Task49','task49-'||u,'America/Sao_Paulo'),(other_u,o,'Task49 other','task49-'||other_u,'America/Sao_Paulo'),
  (missing_u,o,'Task49 missing','task49-'||missing_u,'America/Sao_Paulo'),(foreign_u,foreign_o,'Foreign','task49-'||foreign_u,'America/Sao_Paulo');
 insert into public.customers(id,organization_id,name,phone,birthday,do_not_contact,deleted_at) values
  (c,o,'Synthetic','55912345678','1990-01-01',false,null),(other_c,o,'Other','11912345678','1990-01-01',false,null),
  (foreign_c,foreign_o,'Foreign','21912345678','1990-01-01',false,null);
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,stamp);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values(b,u,ch,'zapi',stamp,true);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
 insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at) values
  (r,u,'Birthday','birthday',15,30,null,null,null,true,stamp,stamp),(frequency,u,'Frequency','frequency',20,1,null,2,30,true,stamp,stamp),
  (foreign_r,foreign_u,'Foreign','birthday',15,30,null,null,null,true,stamp,stamp);
 expected:=pg_temp.expected49(r);
 perform pg_temp.ok49(has_function_privilege('service_role',sig,'EXECUTE') and not has_function_privilege('anon',sig,'EXECUTE')
  and not has_function_privilege('authenticated',sig,'EXECUTE') and not exists(select from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=sig::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'full four-role ACL');
 perform pg_temp.ok49((select p.prosecdef and p.proconfig=array['search_path=""'] and p.pronargs=4 and p.proretset
  and pg_get_function_result(p.oid)='TABLE(voucher_id uuid, unit_id uuid, rule_id uuid, customer_id uuid, code text, discount_percent integer, status text, issued_at timestamp with time zone, created_at timestamp with time zone, expires_at timestamp with time zone, job_id uuid)'
  from pg_proc p where p.oid=sig::regprocedure),'exact 4 args 11 outputs and configuration');
 set local role service_role;
 select * into actual from public.issue_scheduled_whatsapp_voucher(r,c,'TASK49-B',expected);
 reset role;
 select * into v from public.vouchers where id=actual.voucher_id;
 select * into j from public.whatsapp_automation_jobs where id=actual.job_id;
 perform pg_temp.ok49(actual.voucher_id is not null and to_jsonb(actual)=jsonb_build_object('voucher_id',v.id,'unit_id',v.unit_id,'rule_id',v.rule_id,
  'customer_id',v.customer_id,'code',v.code,'discount_percent',v.discount_percent,'status',v.status,'issued_at',v.issued_at,'created_at',v.created_at,'expires_at',v.expires_at,'job_id',j.id),'all eleven fields equal persisted winner');
 perform pg_temp.ok49(v.issued_at=v.created_at and v.created_at>=stamp and v.created_at<=clock_timestamp() and date_trunc('milliseconds',v.created_at)=v.created_at,'actual post-read issue clock millisecond precision');
 perform pg_temp.ok49(j.voucher_id=v.id and j.customer_id=c and j.unit_id=u and j.organization_id=o and j.kind='voucher_issued'
  and j.source_event_key=v.id::text and j.fact_at=v.created_at and extract(epoch from (j.expires_at-j.fact_at))*1000=604800000
  and j.reservation_id is null and j.waitlist_id is null and j.pin_phase='bound','same ledger exact identity, pins and 168h');
 perform pg_temp.ok49(v.expires_at=((day+30+time '23:59:59.999')+interval '3 hours') at time zone 'UTC','actual benefit expiry');
 perform pg_temp.ok49((select count(*)=0 from public.issue_scheduled_whatsapp_voucher(r,c,'TASK49-SECOND',expected)),'active natural key zero rows, no old winner');
 perform pg_temp.ok49((select count(*)=0 from public.issue_scheduled_whatsapp_voucher(r,other_c,'TASK49-B',expected)),'global active code zero rows, no regenerated code');
 perform pg_temp.ok49((select count(*)=1 from public.vouchers where unit_id=u) and (select count(*)=1 from public.whatsapp_automation_jobs where unit_id=u),'conflicts never enqueue another job');
 select * into next_issue from public.issue_scheduled_whatsapp_voucher(frequency,c,'TASK49-F',pg_temp.expected49(frequency));
 perform pg_temp.ok49(next_issue.discount_percent=20 and next_issue.expires_at=((day+1+time '23:59:59.999')+interval '3 hours') at time zone 'UTC'
  and (select expires_at>next_issue.expires_at from public.whatsapp_automation_jobs where id=next_issue.job_id),'frequency benefit and TTL independent');
 -- Closed typed JSON and exact tuple equality. Every negative preserves both counts.
 foreach field in array array['unit_id','trigger_type','discount_percent','validity_days','visits_required','days_window','selected_brt_day'] loop
  perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected-field),'22023','missing '||field);
 end loop;
 for changed in select value from jsonb_array_elements(jsonb_build_array(
  expected||'{"extra":true}',expected||'{"discount_percent":"15"}',expected||'{"validity_days":1.5}',expected||'{"visits_required":false}',
  expected||'{"days_window":"30"}',expected||'{"selected_brt_day":"2026-02-30"}',expected||'{"selected_brt_day":"2026-1-01"}',
  expected||jsonb_build_object('unit_id',other_u),expected||'{"trigger_type":"frequency"}',expected||'{"discount_percent":16}')) loop
  -- Invalid calendar date is 22008; all structural/equality assertions are 22023.
  perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',changed),
   case when changed->>'selected_brt_day'='2026-02-30' then '22008' else '22023' end,'typed tuple negative');
 end loop;
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',pg_temp.expected49(r,day-1)),'22023','previous selected day');
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,foreign_c,'NEG',expected),'42501','foreign organization');
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,gen_random_uuid(),'NEG',expected),'42501','missing customer');
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',foreign_r,c,'NEG',pg_temp.expected49(foreign_r)),'42501','foreign actual rule scope');
 update public.customers set deleted_at=stamp where id=other_c;
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'42501','erased customer');
 update public.customers set deleted_at=null where id=other_c;
 update public.voucher_rules set active=false where id=r;
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'42501','inactive rule');
 update public.voucher_rules set active=true,discount_percent=16 where id=r;
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'22023','changed stored benefit');
 update public.voucher_rules set discount_percent=15,unit_id=missing_u where id=r;
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',pg_temp.expected49(r)),'P0A01','no sticky adoption');
 update public.voucher_rules set unit_id=u where id=r;
 -- Real lookup error and AFTER INSERT fault both abort the voucher+job pair.
 update public.platform_flags set value='"invalid"' where key='whatsapp_automation_dispatch';
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'PT503','enqueue malformed dependency');
 update public.platform_flags set value='true' where key='whatsapp_automation_dispatch';
 perform set_config('task49.late_failure','unique',true);
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'23505','late23505 escapes INSERT-only catch');
 perform set_config('task49.late_failure','error',true);
 perform pg_temp.error49(format('select * from public.issue_scheduled_whatsapp_voucher(%L,%L,%L,%L::jsonb)',r,other_c,'NEG',expected),'P0001','after-job failure rolls back both');
 perform set_config('task49.late_failure','',true);
 -- No consent and globalOFF never discard the intended benefit or ledger.
 update public.platform_flags set value='false' where key='whatsapp_automation_dispatch';
 select * into next_issue from public.issue_scheduled_whatsapp_voucher(r,other_c,'TASK49-OFF',expected);
 perform pg_temp.ok49((select state='paused' and customer_id=other_c from public.whatsapp_automation_jobs where id=next_issue.job_id)
  and not exists(select from public.whatsapp_message_consent_events where customer_id=other_c),'OFF/no-consent still commits one pair');
 -- Configuration absence after adoption gives preconfiguration. No old replay.
 update public.whatsapp_channels set is_active=false where id=ch;
 update public.vouchers set status='used' where id=next_issue.voucher_id;
 select * into next_issue from public.issue_scheduled_whatsapp_voucher(r,other_c,'TASK49-UNCONFIG',expected);
 perform pg_temp.ok49((select pin_phase='preconfiguration' and state='blocked' and channel_id is null from public.whatsapp_automation_jobs where id=next_issue.job_id),'plain config absence persists pair');
 -- Execute the arithmetic extracted from the actual installed issuer's body;
 -- this does not replace its clock or function. Real issuance above separately
 -- proves its current stored result. Vitest executes the unchanged TS helper.
 select substring(prosrc from 'v_expiry := ([^;]+);'),substring(prosrc from 'v_deadline := ([^;]+);')
  into expiry_expr,deadline_expr from pg_proc where oid=sig::regprocedure;
 perform pg_temp.ok49(expiry_expr is not null and deadline_expr is not null,'actual installed expressions located');
 foreach tz in array array['UTC','America/New_York','Pacific/Auckland'] loop
  perform set_config('TimeZone',tz,true);
  for vector in select * from (values
   ('2026-01-31T02:59:59.999Z'::timestamptz,1,'2026-02-01T02:59:59.999Z'::timestamptz),
   ('2026-01-31T03:00:00.000Z'::timestamptz,1,'2026-02-02T02:59:59.999Z'::timestamptz),
   ('2024-02-28T12:00:00.000Z'::timestamptz,1,'2024-03-01T02:59:59.999Z'::timestamptz),
   ('2025-02-28T12:00:00.000Z'::timestamptz,1,'2025-03-02T02:59:59.999Z'::timestamptz),
   ('2026-12-31T12:00:00.000Z'::timestamptz,1,'2027-01-02T02:59:59.999Z'::timestamptz),
   ('2026-10-05T12:34:56.789Z'::timestamptz,30,'2026-11-05T02:59:59.999Z'::timestamptz),
   ('2026-03-07T12:00:00Z'::timestamptz,1,'2026-03-09T02:59:59.999Z'::timestamptz)
  ) as vectors(fact,days,expiry) loop
   execute 'select '||replace(replace(expiry_expr,'v_issued','$1'),'r.validity_days','$2') into calculated using vector.fact,vector.days;
   execute 'select '||replace(deadline_expr,'v_issued','$1') into actual_deadline using vector.fact;
   perform pg_temp.ok49(calculated=vector.expiry and extract(epoch from (actual_deadline-vector.fact))*1000=604800000,'BRT expiry/168h vector '||tz||' '||vector.fact);
  end loop;
 end loop;
 -- Genuine unchanged048 feedback selector: seated yesterday, current destination,
 -- no NULL/empty phone or previously sent notification; no new customer required.
 insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at) values
  (w,u,null,'Unknown','55912345678',3,149,'seated',stamp-interval '1 day',(day-1+time '12:00') at time zone 'America/Sao_Paulo'),
  (w2,other_u,c,'Other','11912345678',2,150,'seated',stamp-interval '1 day',(day-1+time '12:00') at time zone 'America/Sao_Paulo');
 perform pg_temp.ok49((select count(*)=1 from public.get_waitlist_for_feedback(day-1,u) where waitlist_id=w and unit_id=u and party_size=3 and code=149),'real048 current selector scoped and nullable customer');
 perform pg_temp.ok49((select count(*)=0 from public.get_waitlist_for_feedback(day,u)),'real048 no replay of other day');
 update public.waitlist set status='waiting' where id=w;
 perform pg_temp.ok49((select count(*)=0 from public.get_waitlist_for_feedback(day-1,u)),'real048 current status');
 update public.waitlist set status='seated',customer_phone='' where id=w;
 perform pg_temp.ok49((select count(*)=0 from public.get_waitlist_for_feedback(day-1,u)),'real048 empty phone');
 update public.waitlist set customer_phone='55912345678' where id=w;
 insert into public.notifications_sent(id,unit_id,waitlist_id,kind,status) values(gen_random_uuid(),u,w,'waitlist_feedback','sent');
 perform pg_temp.ok49((select count(*)=0 from public.get_waitlist_for_feedback(day-1,u)),'real048 accepted suppression by resource FK');
end $$;
select 'GREEN49 '||label from checks49;
select 'GREEN49 checks='||count(*) from checks49;
rollback;

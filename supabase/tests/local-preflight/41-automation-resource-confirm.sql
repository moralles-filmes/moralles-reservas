\set ON_ERROR_STOP on
-- Actual PostgreSQL controls, only after setup41 + reviewed migration + MAIN READY.
-- SQL sessions below are superuser fixtures, NOT genuine JWT evidence (43).
begin;
set local statement_timeout='20s';
create temp table checks41(label text) on commit drop;
create function pg_temp.ok41(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL41 %',label; end if; insert into checks41 values(label); end $$;
-- Projection of real fixture columns ONLY. No SQL authority/eligibility standin.
create function pg_temp.expected41(jid uuid) returns jsonb language plpgsql as $$
declare j public.whatsapp_automation_jobs%rowtype; r jsonb; c jsonb; u jsonb; rule jsonb:='null'; setting jsonb; k text;
begin
 select * into j from public.whatsapp_automation_jobs where id=jid;
 if j.reservation_id is not null then
  select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'date',date,'time',time,'status',status,
   'payment_status',payment_status,'source',source,'party_size',party_size,'reservation_code',reservation_code,
   'applied_discount_percent',applied_discount_percent,'satisfaction_rating',satisfaction_rating) into r from public.reservations where id=j.reservation_id;
 elsif j.waitlist_id is not null then
  select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'customer_name',customer_name,'customer_phone',customer_phone,
   'party_size',party_size,'code',code,'status',status,'created_at',created_at,'seated_at',seated_at) into r from public.waitlist where id=j.waitlist_id;
 else
  select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'rule_id',rule_id,'code',code,'discount_percent',discount_percent,
   'status',status,'issued_at',issued_at,'created_at',created_at,'expires_at',expires_at) into r from public.vouchers where id=j.voucher_id;
  select jsonb_build_object('id',id,'unit_id',unit_id,'trigger_type',trigger_type) into rule from public.voucher_rules where id=(r->>'rule_id')::uuid;
 end if;
 select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'phone',phone,'do_not_contact',do_not_contact,'deleted_at',deleted_at)
  into c from public.customers where id=j.customer_id;
 select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'slug',slug,'timezone',timezone) into u from public.units where id=j.unit_id;
 k:=case j.kind when 'confirmation' then null when 'voucher_issued' then 'giftback_whatsapp_enabled' else j.kind||'_enabled' end;
 select jsonb_build_object('key',k,'present',true,'value',value) into setting from public.settings where unit_id=j.unit_id and key=k;
 if not found then setting:=jsonb_build_object('key',k,'present',false,'value',null); end if;
 return jsonb_build_object('version',1,'kind',j.kind,'resource',r,'customer',c,'unit',u,'rule',rule,'setting',setting);
end $$;
do $$
declare
 o uuid:=gen_random_uuid(); foreign_o uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); foreign_u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
 ch uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); r uuid; rule uuid:=gen_random_uuid(); other_rule uuid:=gen_random_uuid(); other_c uuid:=gen_random_uuid(); j uuid; f uuid; rev bigint; kind text; item record; n integer:=0;
 fact timestamptz; expiry timestamptz; target date; x jsonb; expected jsonb; changed jsonb; answer jsonb; before_row jsonb; slots_before jsonb;
 stamp timestamptz:=clock_timestamp();
begin
 if (stamp at time zone 'America/Sao_Paulo')::time>='23:50'::time then raise exception 'resource41_day_boundary_fixture_refused'; end if;
 insert into auth.users(id) values(actor); insert into public.platform_admins values(actor);
 insert into public.organizations(id,name) values(o,'Task41 synthetic'),(foreign_o,'Task41 foreign');
 insert into public.units(id,organization_id,name,slug,timezone) values(u,o,'Task41','task41-'||u,'America/Sao_Paulo'),(foreign_u,foreign_o,'Foreign','task41-'||foreign_u,'America/Sao_Paulo');
 insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values(c,o,'Synthetic','55912345678',false,null);
 insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values(other_c,foreign_o,'Foreign','11912344141',false,null);
 insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values(ch,u,'zapi','connected',true,stamp);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values(b,u,ch,'zapi',stamp,true);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
 insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at)
  values(rule,u,'Task41','birthday',15,30,null,null,null,true,stamp,stamp);
 insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at)
  values(other_rule,foreign_u,'Foreign','frequency',15,30,null,2,30,true,stamp,stamp);
 for kind in select unnest(array['confirmation','reminder_d1','survey_d1','waitlist_entered','waitlist_feedback','voucher_issued']) loop
  r:=gen_random_uuid(); n:=n+1; rev:=null;
  target:=(stamp at time zone 'America/Sao_Paulo')::date;
  if kind='confirmation' then target:=target+1; elsif kind in('survey_d1','waitlist_feedback') then target:=target-1; end if;
  fact:=(target+time '23:59:00') at time zone 'America/Sao_Paulo'; expiry:=fact;
  if kind='waitlist_entered' then fact:=stamp; expiry:=stamp+interval '2 hours';
  elsif kind='waitlist_feedback' then expiry:=fact+interval '24 hours';
  elsif kind='survey_d1' then expiry:=fact+interval '48 hours';
  elsif kind='voucher_issued' then fact:=stamp; expiry:=stamp+interval '7 days'; end if;
  if kind in('confirmation','reminder_d1','survey_d1') then
   insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
    values(r,u,c,target,'23:59:00','confirmed',null,'web',4,'TASK41-'||r,null,null);
  elsif kind in('waitlist_entered','waitlist_feedback') then
   insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at)
    values(r,u,c,'Synthetic','55912345678',4,n,case when kind='waitlist_entered' then 'waiting' else 'seated' end,stamp-interval '1 day',case when kind='waitlist_feedback' then (target+time '12:00') at time zone 'America/Sao_Paulo' else null end);
  else
   insert into public.vouchers(id,unit_id,customer_id,rule_id,code,discount_percent,issued_at,created_at,expires_at,status)
    values(r,u,c,rule,'TASK41-'||r,15,stamp,stamp,stamp+interval '30 days','active');
  end if;
  if kind in('waitlist_feedback','voucher_issued') then
   insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at)
    values(u,c,'promotional','opt_in','fixture','task41-'||kind,stamp) returning revision into rev;
  end if;
  j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind',kind,
   case when kind in('confirmation','reminder_d1','survey_d1') then 'reservation_id' when kind='voucher_issued' then 'voucher_id' else 'waitlist_id' end,r,
   'source_event_key','task41-'||kind,'fact_at',fact,'expires_at',expiry));
  x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
  update public.whatsapp_automation_jobs set safe_log_body='Task41 frozen redacted' where id=j and claim_token=f;
  perform pg_temp.ok41(public.prepare_whatsapp_automation_post(j,f,1,rev,null),'old prepare positive '||kind);
  expected:=pg_temp.expected41(j);
  select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
  select coalesce(jsonb_agg(to_jsonb(z) order by id),'[]') into slots_before from public.whatsapp_promotion_slots z where unit_id=u;
  answer:=public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,expected);
  perform pg_temp.ok41(answer='{"allowed":true}'::jsonb,'typed current positive '||kind);
  perform pg_temp.ok41(public.confirm_whatsapp_automation_post(j,f,1,rev,null) and app_private.whatsapp_automation_post_core(j,f,1,rev,null,true),'old five/six positive '||kind);
  perform pg_temp.ok41(not public.confirm_whatsapp_automation_post(j,gen_random_uuid(),1,rev,null) and not app_private.whatsapp_automation_post_core(j,null,1,rev,null,true),'old five/six negative '||kind);
  perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,gen_random_uuid(),1,rev,null,expected)='{"allowed":false,"reason":"authority_changed"}','new wrong fence '||kind);
  begin
   update public.platform_flags set value='"invalid"' where key='whatsapp_automation_dispatch';
   perform pg_temp.ok41(not public.confirm_whatsapp_automation_post(j,gen_random_uuid(),1,rev,null)
    and not app_private.whatsapp_automation_post_core(j,gen_random_uuid(),1,rev,null,true),'old wrong-fence precedes malformed flag '||kind);
   begin
    perform public.confirm_whatsapp_automation_post(j,f,1,rev,null);
    raise exception 'FAIL41 live malformed flag did not raise';
   exception when sqlstate 'PT503' then null; end;
   update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()-interval '1 second' where id=j;
   perform pg_temp.ok41(not public.confirm_whatsapp_automation_post(j,f,1,rev,null)
    and not app_private.whatsapp_automation_post_core(j,f,1,rev,null,true),'old expired lease precedes malformed flag '||kind);
   raise sqlstate 'P0041';
  exception when sqlstate 'P0041' then null; end;
  perform pg_temp.ok41(true,'old flag error/false ordering restored '||kind);
  -- Closed input failures may not use the private expected=NULL compatibility.
  for changed in select unnest(array[null::jsonb,'null','{}','[]',expected||'{"extra":1}',expected-'resource',jsonb_set(expected,'{version}','2'),
    jsonb_set(expected,'{unit,slug}','42'),jsonb_set(expected,'{unit,id}',to_jsonb(foreign_u)),jsonb_set(expected,'{kind}','"unsupported"'),
    jsonb_set(expected,'{resource,id}',to_jsonb(gen_random_uuid())),jsonb_set(expected,'{resource,unit_id}',to_jsonb(foreign_u)),
    jsonb_set(expected,'{customer,id}',to_jsonb(gen_random_uuid())),jsonb_set(expected,'{customer,organization_id}',to_jsonb(foreign_o)),
    jsonb_set(expected,'{resource,status}','"cancelled"')]) loop
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":false,"reason":"snapshot_invalid"}','closed shape/domain '||kind);
  end loop;
  if kind in('confirmation','reminder_d1','survey_d1') then
   for changed in select unnest(array[jsonb_set(expected,'{resource,date}','"infinity"'),jsonb_set(expected,'{resource,date}','"2026-02-30"'),
     jsonb_set(expected,'{resource,time}','"25:00:00"'),jsonb_set(expected,'{resource,party_size}','99999999999999999999'),
     jsonb_set(expected,'{resource,party_size}','"4"'),jsonb_set(expected,'{resource,source}','null')]) loop
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":false,"reason":"snapshot_invalid"}','invalid typed date/time/number '||kind);
   end loop;
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,jsonb_set(expected,'{resource,time}','"23:59"'))='{"allowed":true}','SQL time semantic parity '||kind);
  elsif kind='voucher_issued' then
   changed:=jsonb_set(expected,'{resource,issued_at}',to_jsonb((stamp at time zone 'UTC')::text||'+00:00'));
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":true}','timestamp offset parity voucher');
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,jsonb_set(expected,'{resource,expires_at}','"infinity"'))='{"allowed":false,"reason":"snapshot_invalid"}','nonfinite timestamp closed');
  end if;
  if kind='confirmation' then
   for item in select unnest(array['america/sao_paulo','utc']) zone loop
    begin
     update public.units set timezone=item.zone where id=u;
     changed:=pg_temp.expected41(j);
     perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":true}','case-insensitive IANA '||item.zone);
     raise sqlstate 'P0041';
    exception when sqlstate 'P0041' then null; end;
    perform pg_temp.ok41(true,'IANA case positive '||item.zone);
   end loop;
   begin
    update public.units set timezone='not/a-zone' where id=u;
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,pg_temp.expected41(j))='{"allowed":false,"reason":"snapshot_invalid"}','invalid expected IANA');
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,expected)='{"allowed":false,"reason":"resource_changed"}','invalid current IANA');
    raise sqlstate 'P0041';
   exception when sqlstate 'P0041' then null; end;
   perform pg_temp.ok41(true,'invalid IANA controls');
  end if;
  -- The bridge intentionally leaves new production-required columns nullable.
  -- NULL current facts must refuse; capturing that NULL must never widen authority.
  begin
   if kind in('confirmation','reminder_d1','survey_d1') then update public.reservations set party_size=null where id=r;
   elsif kind in('waitlist_entered','waitlist_feedback') then update public.waitlist set party_size=null where id=r;
   else update public.vouchers set expires_at=null where id=r; end if;
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,expected)='{"allowed":false,"reason":"resource_changed"}','current missing mandatory fact '||kind);
   perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,pg_temp.expected41(j))='{"allowed":false,"reason":"snapshot_invalid"}','NULL expected mandatory fact '||kind);
   raise sqlstate 'P0041';
  exception when sqlstate 'P0041' then null; end;
  perform pg_temp.ok41(true,'nullable bridge never authorizes missing facts '||kind);
  if kind in('confirmation','reminder_d1','voucher_issued') then
   begin
    if kind='voucher_issued' then update public.vouchers set expires_at=clock_timestamp()-interval '1 second' where id=r;
    else update public.reservations set date=(clock_timestamp() at time zone 'America/Sao_Paulo')::date,time='00:00' where id=r; end if;
    changed:=pg_temp.expected41(j); -- Equal current facts alone do not authorize a clock-crossed start/benefit.
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":false,"reason":"resource_changed"}','after-clock eligibility with matching facts '||kind);
    raise sqlstate 'P0041';
   exception when sqlstate 'P0041' then null; end;
   perform pg_temp.ok41(true,'matching facts still require final time '||kind);
  end if;
  -- Captured NULL names/slugs are allowed assertions, with exact equality, not invented defaults.
  perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,jsonb_set(expected,'{customer,name}','null'))='{"allowed":false,"reason":"resource_changed"}','real name NULL assertion differs '||kind);
  perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,jsonb_set(expected,'{customer,phone}','"+55 (55) 91234-5678"'))='{"allowed":true}','DDD55 logical phone '||kind);
  -- Every projected/current field has its own mutation, in a rolled-back subtransaction.
  -- Waitlist authority resolves its FK through current customer/row-phone equality;
  -- changing the customer phone breaks that authority before snapshot comparison.
  for item in select * from (values
    ('customers','name',quote_literal('Changed'),'resource_changed'),
    ('customers','phone',quote_literal('11912345678'),case when kind in('waitlist_entered','waitlist_feedback') then 'authority_changed' else 'resource_changed' end),
    ('customers','do_not_contact','true','authority_changed'),('customers','deleted_at','clock_timestamp()','authority_changed'),
    ('customers','organization_id',quote_literal(foreign_o)||'::uuid','authority_changed'),
    ('units','name',quote_literal('Changed'),'resource_changed'),('units','slug',quote_literal('changed-slug'),'resource_changed'),
    ('units','timezone',quote_literal('UTC'),'resource_changed'),
    ('units','organization_id',quote_literal(foreign_o)||'::uuid','authority_changed'),
    ('reservations','unit_id',quote_literal(foreign_u)||'::uuid','authority_changed'),('reservations','customer_id',quote_literal(other_c)||'::uuid','authority_changed'),
    ('reservations','date',quote_literal((target+1)::text)||'::date','resource_changed'),('reservations','time',quote_literal('23:58:00'),'resource_changed'),
    ('reservations','status',quote_literal('cancelled'),'resource_changed'),('reservations','payment_status',quote_literal('refunded'),'resource_changed'),
    ('reservations','source',quote_literal('whatsapp'),'resource_changed'),('reservations','party_size','5','resource_changed'),
    ('reservations','reservation_code',quote_literal('CHANGED-'||r),'resource_changed'),('reservations','applied_discount_percent','15','resource_changed'),
    ('reservations','satisfaction_rating','5','resource_changed'),
    ('waitlist','customer_name',quote_literal('Changed'),'resource_changed'),('waitlist','customer_phone',quote_literal('11912345678'),'authority_changed'),
    ('waitlist','unit_id',quote_literal(foreign_u)||'::uuid','authority_changed'),('waitlist','customer_id',quote_literal(other_c)||'::uuid','authority_changed'),
    ('waitlist','party_size','5','resource_changed'),('waitlist','code','100','resource_changed'),('waitlist','status',quote_literal('cancelled'),'resource_changed'),
    ('waitlist','created_at','clock_timestamp()','resource_changed'),('waitlist','seated_at','clock_timestamp()','resource_changed'),
    ('vouchers','code',quote_literal('CHANGED-'||r),'resource_changed'),('vouchers','discount_percent','20','resource_changed'),
    ('vouchers','unit_id',quote_literal(foreign_u)||'::uuid','authority_changed'),('vouchers','customer_id',quote_literal(other_c)||'::uuid','authority_changed'),
    ('vouchers','rule_id',quote_literal(other_rule)||'::uuid','resource_changed'),
    ('vouchers','issued_at',quote_literal((stamp-interval '1 hour')::text)||'::timestamptz','resource_changed'),
    ('vouchers','created_at',quote_literal((stamp-interval '1 hour')::text)||'::timestamptz','resource_changed'),
    ('vouchers','expires_at','clock_timestamp()-interval ''1 second''','resource_changed'),('vouchers','status',quote_literal('used'),'resource_changed'),
    ('voucher_rules','trigger_type',quote_literal('manual'),'resource_changed'),('voucher_rules','unit_id',quote_literal(foreign_u)||'::uuid','resource_changed')) v(tbl,col,expr,reason)
    where tbl in('customers','units') or (tbl='reservations' and kind in('confirmation','reminder_d1','survey_d1'))
      or (tbl='waitlist' and kind in('waitlist_entered','waitlist_feedback')) or (tbl in('vouchers','voucher_rules') and kind='voucher_issued') loop
   begin
    execute format('update public.%I set %I=%s where id=%L',item.tbl,item.col,item.expr,case item.tbl when 'customers' then c when 'units' then u when 'voucher_rules' then rule else r end);
    answer:=public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,expected);
    perform pg_temp.ok41(answer=jsonb_build_object('allowed',false,'reason',item.reason),'field drift '||kind||' '||item.tbl||'.'||item.col);
    raise sqlstate 'P0041';
   exception when sqlstate 'P0041' then null; end;
   -- Assertions inside the subtransaction roll back too; re-record verified completion.
   perform pg_temp.ok41(true,'rolled-back field drift '||kind||' '||item.tbl||'.'||item.col);
  end loop;
  if kind<>'confirmation' then
   begin
    insert into public.settings(unit_id,key,value) values(u,expected#>>'{setting,key}','null');
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,expected)='{"allowed":false,"reason":"resource_changed"}','row absent vs JSON null');
    changed:=pg_temp.expected41(j);
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":true}','JSON-null row present positive');
    update public.settings set value='false' where unit_id=u and key=expected#>>'{setting,key}';
    perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,rev,null,changed)='{"allowed":false,"reason":"resource_changed"}','current setting disabled');
    raise sqlstate 'P0041';
   exception when sqlstate 'P0041' then null; end;
   perform pg_temp.ok41(true,'setting row/JSON null controls '||kind);
  end if;
  perform pg_temp.ok41((select to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'all confirms byte readonly job '||kind);
  perform pg_temp.ok41((select coalesce(jsonb_agg(to_jsonb(z) order by id),'[]')=slots_before from public.whatsapp_promotion_slots z where unit_id=u),'all confirms byte readonly slots '||kind);
  -- Reset through the ACTUAL fenced finish, so next promotion may reserve normally.
  perform pg_temp.ok41(public.finish_whatsapp_automation(j,f,'{"outcome":"local_preflight_refused","reason":"final_resource_changed"}'),'actual zero-post finish '||kind);
 end loop;
 -- Unknown operational entry retains nullable customer; never manufactures one.
 begin
  r:=gen_random_uuid();
  update public.units set slug=null,timezone=null where id=u;
  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at)
    values(r,u,null,'Unknown synthetic','11912344341',2,41,'waiting',stamp,null);
  j:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','waitlist_entered','waitlist_id',r,
    'source_event_key','task41-unknown','fact_at',stamp,'expires_at',stamp+interval '2 hours'));
  x:=public.claim_whatsapp_automation(j); f:=(x->>'claim_token')::uuid;
  update public.whatsapp_automation_jobs set safe_log_body='Task41 unknown frozen' where id=j and claim_token=f;
  perform pg_temp.ok41(public.prepare_whatsapp_automation_post(j,f,1,null,null),'unknown entry actual prepare');
  expected:=pg_temp.expected41(j);
  perform pg_temp.ok41(expected->'customer'='null'::jsonb and expected#>'{unit,slug}'='null'::jsonb and expected#>'{unit,timezone}'='null'::jsonb,'real NULL customer/slug/timezone projection');
  select to_jsonb(z) into before_row from public.whatsapp_automation_jobs z where id=j;
  perform pg_temp.ok41(public.confirm_whatsapp_automation_resource_post(j,f,1,null,null,expected)='{"allowed":true}','unknown entry effective IANA default');
  perform pg_temp.ok41((select to_jsonb(z)=before_row from public.whatsapp_automation_jobs z where id=j),'unknown confirm readonly');
  raise sqlstate 'P0041';
 exception when sqlstate 'P0041' then null; end;
 perform pg_temp.ok41(true,'unknown operational nullable controls');
 -- ACL/private schema checks here are catalog/superuser evidence; 43 proves real JWT.
 for item in select * from (values
  ('public.confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb)',true),
  ('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean)',false),
  ('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)',false)) v(sig,service_allowed) loop
  perform pg_temp.ok41(not has_function_privilege('anon',item.sig,'EXECUTE') and not has_function_privilege('authenticated',item.sig,'EXECUTE')
   and has_function_privilege('service_role',item.sig,'EXECUTE')=item.service_allowed
   and not exists(select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where p.oid=item.sig::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE')
   and (select provolatile='v' and prosecdef and proconfig=array['search_path=""'] from pg_proc where oid=item.sig::regprocedure),'closed ACL/volatile '||item.sig);
 end loop;
end $$;
select count(*) as actual_sql_checks from checks41;
rollback;

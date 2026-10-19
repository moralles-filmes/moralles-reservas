\set ON_ERROR_STOP on
-- Apply only to a disposable, networkless PostgreSQL 17 bootstrap through
-- 20261019183559_whatsapp_legacy_managed_intent_fence.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- The compact 73 bootstrap omits this historical production column.
alter table public.waitlist add column if not exists notified_at timestamptz;
do $$
declare
  o uuid:=gen_random_uuid(); o_other uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); u_other uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  r uuid:=gen_random_uuid(); r2 uuid:=gen_random_uuid(); r3 uuid:=gen_random_uuid(); r4 uuid:=gen_random_uuid();
  w uuid:=gen_random_uuid(); rule_good uuid:=gen_random_uuid(); rule_bad uuid:=gen_random_uuid();
  voucher_good uuid:=gen_random_uuid(); voucher_bad uuid:=gen_random_uuid();
  ch uuid:=gen_random_uuid(); ch_other uuid:=gen_random_uuid();
  admin_id uuid:=gen_random_uuid(); a jsonb; b jsonb; x jsonb; i uuid; f uuid;
  today_brt date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  denied text; job_id uuid; historical_id uuid; managed_fence uuid; managed_generation bigint;
  expected_snapshot jsonb; confirmation_result jsonb; finish_result boolean;
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then raise exception '76_not_quarantined'; end if;
  if has_table_privilege('service_role','app_private.whatsapp_cutover_intents','SELECT')
    or has_table_privilege('authenticated','app_private.whatsapp_cutover_adoption_permits','INSERT')
    or has_function_privilege('authenticated','public.claim_whatsapp_legacy_automation_post(text,uuid,uuid,bigint,text)','EXECUTE')
    or has_function_privilege('service_role','app_private.whatsapp_automation_post_inner(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_whatsapp_legacy_automation_post(text,uuid,uuid,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.enqueue_whatsapp_automation(jsonb)','EXECUTE')
  then raise exception '76_acl'; end if;
  insert into auth.users(id) values(admin_id);
  insert into public.platform_admins(user_id) values(admin_id);
  insert into public.organizations(id,name) values(o,'Cutover76'),(o_other,'Cutover76 foreign');
  insert into public.units(id,organization_id,name,slug) values(u,o,'Cutover76','cutover76-'||u),
    (u_other,o_other,'Cutover76 foreign','cutover76-'||u_other);
  insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at)
    values(c,o,'Cutover76','11999997601',false,null);
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,webhook_secret)
    values(ch,u,'zapi','connected',true,clock_timestamp(),'local-only'),
      (ch_other,u_other,'zapi','connected',true,clock_timestamp(),'local-only');
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,party_size,reservation_code)
    values(r,u,c,today_brt+1,'20:00','confirmed','web',2,'C76-'||r),
      (r2,u,c,today_brt+1,'20:00','confirmed','web',2,'C76-'||r2),
      (r3,u,c,today_brt+1,'20:00','confirmed','web',2,'C76-'||r3),
      (r4,u,c,today_brt+1,'20:00','confirmed','web',2,'C76-'||r4);
  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status)
    values(w,u,c,'Cutover76','11999997601',2,7601,'waiting');
  insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,
      min_rating,visits_required,days_window,active,created_at,updated_at)
    values(rule_good,u,'Cutover76 birthday','birthday',15,30,null,null,null,true,clock_timestamp(),clock_timestamp()),
      (rule_bad,u,'Cutover76 rating','after_rating',15,30,4,null,null,true,clock_timestamp(),clock_timestamp());
  insert into public.vouchers(id,unit_id,customer_id,rule_id,code,discount_percent,issued_at,created_at,expires_at,status)
    values(voucher_good,u,c,rule_good,'C76-'||voucher_good,15,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '30 days','active'),
      (voucher_bad,u,c,rule_bad,'C76-'||voucher_bad,15,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '30 days','active');
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  denied:=null;
  begin perform public.release_whatsapp_template_channel(ch,'dispatch',true,0,null);
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '42501' then raise exception '76_nonadmin_known_channel_oracle: %',denied; end if;
  denied:=null;
  begin perform public.release_whatsapp_template_channel(gen_random_uuid(),'dispatch',true,0,null);
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '42501' then raise exception '76_nonadmin_unknown_channel_oracle: %',denied; end if;
  if public.claim_whatsapp_legacy_automation_post('confirmation',r,ch_other,0,'send-confirmation')->>'reason' is distinct from 'channel_changed'
    or public.claim_whatsapp_legacy_automation_post('confirmation',gen_random_uuid(),ch,0,'send-confirmation')->>'reason' is distinct from 'resource_refused'
    or public.claim_whatsapp_legacy_automation_post('voucher_issued',voucher_bad,ch,0,'send-whatsapp')->>'reason' is distinct from 'resource_refused'
  then raise exception '76_foreign_fake_or_after_rating_not_refused'; end if;
  a:=public.claim_whatsapp_legacy_automation_post('waitlist_entered',w,ch,0,'send-whatsapp');
  if a->>'allowed' is distinct from 'true'
    or public.claim_whatsapp_legacy_automation_post('waitlist_entered',w,ch,0,'send-whatsapp')->>'reason' is distinct from 'intent_owned'
    or public.release_whatsapp_legacy_automation_claim((a->>'intent_id')::uuid,(a->>'fence')::uuid,'preflight_refused')->>'released' is distinct from 'true'
  then raise exception '76_waitlist_claim_repeat'; end if;
  a:=public.claim_whatsapp_legacy_automation_post('voucher_issued',voucher_good,ch,0,'send-whatsapp');
  if a->>'allowed' is distinct from 'true'
    or public.claim_whatsapp_legacy_automation_post('voucher_issued',voucher_good,ch,0,'send-whatsapp')->>'reason' is distinct from 'intent_owned'
    or public.release_whatsapp_legacy_automation_claim((a->>'intent_id')::uuid,(a->>'fence')::uuid,'preflight_refused')->>'released' is distinct from 'true'
  then raise exception '76_scheduled_voucher_claim_repeat'; end if;
  a:=public.claim_whatsapp_legacy_automation_post('confirmation',r,ch,0,'send-confirmation');
  if a->>'allowed' is distinct from 'true' then raise exception '76_claim: %',a; end if;
  i:=(a->>'intent_id')::uuid; f:=(a->>'fence')::uuid;
  if public.claim_whatsapp_legacy_automation_post('confirmation',r,ch,0,'send-confirmation')->>'reason' is distinct from 'intent_owned'
    or public.claim_whatsapp_legacy_automation_post('confirmation',r,ch,1,'send-confirmation')->>'reason' is distinct from 'channel_changed'
    or public.confirm_whatsapp_legacy_automation_post(i,gen_random_uuid(),ch,0)->>'allowed' is distinct from 'false'
  then raise exception '76_claim_idempotency_or_revision'; end if;
  if public.release_whatsapp_legacy_automation_claim(i,f,'confirmation_refused')->>'released' is distinct from 'true'
    or public.confirm_whatsapp_legacy_automation_post(i,f,ch,0)->>'allowed' is distinct from 'false' then
    raise exception '76_prepost_release'; end if;
  a:=public.claim_whatsapp_legacy_automation_post('confirmation',r,ch,0,'send-confirmation');
  if a->>'allowed' is distinct from 'true' or (a->>'fence')::uuid is not distinct from f
    or a->>'fence' is null then raise exception '76_retry_fence'; end if;
  f:=(a->>'fence')::uuid;
  b:=public.confirm_whatsapp_legacy_automation_post(i,f,ch,0);
  if b->>'allowed' is distinct from 'true'
    or public.confirm_whatsapp_legacy_automation_post(i,f,ch,0)->>'allowed' is distinct from 'false'
    or public.release_whatsapp_legacy_automation_claim(i,f,'confirmation_refused')->>'released' is distinct from 'false'
  then raise exception '76_one_use_confirm: %',b; end if;
  x:=public.finish_whatsapp_legacy_automation_post(i,f,'uncertain',null);
  if x->>'state' is distinct from 'uncertain' or public.claim_whatsapp_legacy_automation_post('confirmation',r,ch,0,'send-confirmation')->>'reason' is distinct from 'intent_owned'
  then raise exception '76_uncertain_no_replay'; end if;
  x:=public.finish_whatsapp_legacy_automation_post(i,f,'accepted','local-76-one');
  if x->>'state' is distinct from 'accepted'
    or public.finish_whatsapp_legacy_automation_post(i,f,'accepted','local-76-two')->>'recorded' is distinct from 'false'
  then raise exception '76_late_accept_or_divergent_id'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  denied:=null;
  begin
    insert into public.whatsapp_automation_adoptions(unit_id,adopted_at)
      values(u,clock_timestamp());
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '42501' then
    raise exception '76_direct_adoption_unexpected: %',denied; end if;
  insert into public.notifications_sent(reservation_id,unit_id,kind,status,error,failed_at)
    values(r3,u,'confirmation','failed','local synthetic',clock_timestamp()) returning id into historical_id;
  if (select sent_at is null from public.notifications_sent where id=historical_id) is not false
    or public.claim_whatsapp_legacy_automation_post('confirmation',r3,ch,0,'send-confirmation')->>'reason' is distinct from 'history_uncertain'
    or public.release_whatsapp_template_channel(ch,'dispatch',true,0,null) is distinct from false
  then raise exception '76_failed_sent_at_not_acceptance'; end if;
  update public.notifications_sent set status='sent',failed_at=null,error=null where id=historical_id;
  insert into public.notifications_sent(reservation_id,unit_id,kind,status,provider_message_id,
      whatsapp_provider,whatsapp_channel_id,failed_at)
    values(r4,u,'confirmation','failed','local-76-failed','zapi',ch,clock_timestamp());
  insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,
      status,provider_timestamp,digest)
    values(u,'zapi',ch,'local-76-other','failed',clock_timestamp(),repeat('a',64));
  if public.claim_whatsapp_legacy_automation_post('confirmation',r4,ch,0,'send-confirmation')->>'reason' is distinct from 'history_uncertain'
    or public.release_whatsapp_template_channel(ch,'dispatch',true,0,null) is distinct from false
  then raise exception '76_wrong_receipt_tuple_not_uncertain'; end if;
  insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,
      status,provider_timestamp,digest)
    values(u,'zapi',ch,'local-76-failed','failed',clock_timestamp(),repeat('b',64));
  if public.claim_whatsapp_legacy_automation_post('confirmation',r4,ch,0,'send-confirmation')->>'reason' is distinct from 'history_accepted' then
    raise exception '76_exact_terminal_receipt_not_accepted'; end if;
  if public.release_whatsapp_template_channel(ch,'dispatch',true,0,null) is distinct from true then
    raise exception '76_adoption_after_accepted'; end if;
  -- Savepoint-style subtransaction: stop remains allowed, direct re-enable
  -- without the one-use operation permit must fail, then restore fixture.
  begin
    update public.whatsapp_template_bindings set dispatch_enabled=false where channel_id=ch;
    denied:=null;
    begin update public.whatsapp_template_bindings set dispatch_enabled=true where channel_id=ch;
    exception when others then get stacked diagnostics denied=returned_sqlstate; end;
    if denied is distinct from '42501' then raise exception '76_direct_binding_enable_unexpected: %',denied; end if;
    raise sqlstate 'P0076';
  exception when sqlstate 'P0076' then null; end;
  if public.claim_whatsapp_legacy_automation_post('confirmation',r2,ch,0,'send-confirmation')->>'reason' is distinct from 'adoption_active' then
    raise exception '76_late_legacy_after_adoption'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true'::jsonb)
    on conflict(key) do update set value=excluded.value;
  job_id:=public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','confirmation','reservation_id',r2,
    'source_event_key','76-confirm-'||r2,'fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
  if job_id is null or public.enqueue_whatsapp_automation(jsonb_build_object('unit_id',u,'kind','confirmation','reservation_id',r2,
    'source_event_key','76-confirm-'||r2,'fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour')) is distinct from job_id
  then raise exception '76_managed_enqueue_idempotence'; end if;
  if (select count(*) from app_private.whatsapp_cutover_intents where unit_id=u and kind='confirmation')<>2
    or (select owner from app_private.whatsapp_cutover_intents where resource_id=r2)<>'managed'
  then raise exception '76_independent_tombstones'; end if;
  x:=public.claim_whatsapp_automation(job_id);
  managed_fence:=(x->>'claim_token')::uuid;
  if managed_fence is null then raise exception '76_managed_claim: %',x; end if;
  update public.whatsapp_automation_jobs set safe_log_body='Local76 synthetic' where id=job_id and claim_token=managed_fence;
  select binding_generation into managed_generation from public.whatsapp_automation_jobs where id=job_id;
  -- Sabotage only inside this rolled-back fixture: the real final SQL guard must
  -- refuse an old managed job when the same fact is legacy-owned.
  update app_private.whatsapp_cutover_intents set owner='legacy',state='claimed',managed_job_id=null,
    fence=gen_random_uuid() where resource_id=r2 and kind='confirmation';
  if public.prepare_whatsapp_automation_post(job_id,managed_fence,managed_generation,null,null) then
    raise exception '76_final_core_allowed_legacy_owned_fact'; end if;
  update app_private.whatsapp_cutover_intents set owner='managed',state='ready',managed_job_id=job_id,
    fence=null where resource_id=r2 and kind='confirmation';
  if not public.prepare_whatsapp_automation_post(job_id,managed_fence,managed_generation,null,null) then
    raise exception '76_final_core_positive_prepare'; end if;
  select jsonb_build_object('version',1,'kind','confirmation',
      'resource',(select jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,'date',date,'time',time,
        'status',status,'payment_status',payment_status,'source',source,'party_size',party_size,
        'reservation_code',reservation_code,'applied_discount_percent',applied_discount_percent,
        'satisfaction_rating',satisfaction_rating) from public.reservations where id=r2),
      'customer',(select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'phone',phone,
        'do_not_contact',do_not_contact,'deleted_at',deleted_at) from public.customers where id=c),
      'unit',(select jsonb_build_object('id',id,'organization_id',organization_id,'name',name,'slug',slug,'timezone',timezone)
        from public.units where id=u),
      'rule',null,'setting',jsonb_build_object('key',null,'present',false,'value',null)) into expected_snapshot;
  update app_private.whatsapp_cutover_intents set owner='legacy',state='claimed',managed_job_id=null,
    fence=gen_random_uuid() where resource_id=r2 and kind='confirmation';
  confirmation_result:=public.confirm_whatsapp_automation_resource_post(job_id,managed_fence,managed_generation,null,null,expected_snapshot);
  if confirmation_result->>'allowed' is distinct from 'false' then raise exception '76_final_confirm_allowed_legacy_owned_fact'; end if;
  update app_private.whatsapp_cutover_intents set owner='managed',state='ready',managed_job_id=job_id,
    fence=null where resource_id=r2 and kind='confirmation';
  confirmation_result:=public.confirm_whatsapp_automation_resource_post(job_id,managed_fence,managed_generation,null,null,expected_snapshot);
  if confirmation_result->>'allowed' is distinct from 'true' then raise exception '76_final_confirm_positive: %',confirmation_result; end if;
  finish_result:=public.finish_whatsapp_automation(job_id,managed_fence,
      jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','local-76-managed'));
  if finish_result is distinct from true or
    (select state from app_private.whatsapp_cutover_intents where resource_id=r2 and kind='confirmation')<>'accepted'
  then raise exception '76_managed_finish_marker_atomic result=% marker=% job=%',finish_result,
    (select state from app_private.whatsapp_cutover_intents where resource_id=r2 and kind='confirmation'),
    (select state from public.whatsapp_automation_jobs where id=job_id); end if;
end $$;
rollback;

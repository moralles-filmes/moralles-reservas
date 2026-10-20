\set ON_ERROR_STOP on
-- Version selection and preconfiguration in a disposable, networkless PG17.
begin;
set local lock_timeout='5s';
set local statement_timeout='45s';
do $$ <<fixture>>
declare
  admin_id uuid:=gen_random_uuid(); owner_id uuid:=gen_random_uuid();
  org_id uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid();
  unit_id uuid:=gen_random_uuid(); manual_unit uuid:=gen_random_uuid();
  other_unit uuid:=gen_random_uuid(); customer_id uuid:=gen_random_uuid();
  reservation_id uuid:=gen_random_uuid(); historical_res uuid:=gen_random_uuid();
  historical_job uuid; v_onboarding_id uuid:=gen_random_uuid();
  manual_onboarding_id uuid:=gen_random_uuid(); v2_res uuid:=gen_random_uuid();
  v2_res2 uuid:=gen_random_uuid(); sibling_unit uuid:=gen_random_uuid();
  voucher_rule uuid:=gen_random_uuid(); voucher_rule_two uuid:=gen_random_uuid();
  voucher_one uuid:=gen_random_uuid();
  voucher_two uuid:=gen_random_uuid(); marketing_job uuid; marketing_job_two uuid;
  marketing_fence uuid; marketing_fence_two uuid; marketing_epoch bigint;
  marketing_revision bigint; changed_count integer;
  sibling_channel uuid:=gen_random_uuid(); foreign_channel uuid:=gen_random_uuid();
  sibling_binding uuid;
  reserved_channel uuid:=gen_random_uuid(); manual_channel uuid:=gen_random_uuid();
  account_id uuid:=gen_random_uuid(); preconfig_account uuid:=gen_random_uuid();
  binding_id uuid; rebound_binding uuid; job_id uuid; next_job uuid;
  grant_unprepared_res uuid:=gen_random_uuid(); grant_unprepared_job uuid;
  grant_unprepared_fence uuid; grant_unprepared_epoch bigint;
  selected jsonb; snapshot jsonb; store_status jsonb; denied text;
  v_ready jsonb; v_claim jsonb; v_fence uuid; v_sync_epoch bigint;
  v_post_allowed boolean; v_confirm_allowed boolean;
  v_released boolean;
  fact timestamptz:=clock_timestamp()+interval '1 minute';
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select 1 from cron.job where jobname in
      ('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select 1 from net.http_request_queue) then
    raise exception '77_not_quarantined'; end if;
  if has_table_privilege('service_role','app_private.whatsapp_automation_version_selections','SELECT')
    or has_function_privilege('anon',
      'public.get_whatsapp_automation_version_selections(uuid)','EXECUTE')
    or has_function_privilege('service_role',
      'public.set_whatsapp_automation_version_selection(uuid,text,integer,bigint,bigint,bigint)','EXECUTE')
    or has_function_privilege('authenticated',
      'app_private.resolve_whatsapp_automation_version(uuid,uuid,text)','EXECUTE') then
    raise exception '77_acl_open'; end if;
  insert into auth.users(id) values(admin_id),(owner_id);
  insert into public.platform_admins(user_id) values(admin_id);
  insert into public.organizations(id,name) values(org_id,'Versioned local'),
    (other_org,'Versioned foreign');
  insert into public.units(id,organization_id,name) values
    (unit_id,org_id,'Auto before channel'),(manual_unit,org_id,'Manual v1'),
    (sibling_unit,org_id,'Shared WABA sibling'),
    (other_unit,other_org,'Foreign');
  insert into public.unit_members(user_id,unit_id,role)
    values(owner_id,manual_unit,'owner');
  insert into public.customers(id,organization_id,name,phone,do_not_contact)
    values(customer_id,org_id,'Local','11999997701',false);
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
      party_size,reservation_code)
    values(reservation_id,unit_id,customer_id,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V77-'||reservation_id);
  -- A legacy account completed onboarding before the v2 auto policy existed.
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id,datafy_channel_id,state,completed_at)
    values(manual_onboarding_id,org_id,manual_unit,manual_channel,
      'local-manual-77','completed',clock_timestamp());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  update public.platform_flags set value='true'::jsonb
    where key='whatsapp_template_catalog';
  selected:=public.configure_whatsapp_template_v2_policy(true,0);
  if selected->>'enabled' is distinct from 'true' then
    raise exception '77_v2_policy_enable_failed: %',selected; end if;
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding_id,org_id,unit_id,reserved_channel);
  if not exists(select 1 from app_private.whatsapp_template_v2_enrollments
      where onboarding_id=v_onboarding_id and origin='auto' and excluded_at is null) then
    raise exception '77_auto_enrollment_missing'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  selected:=app_private.resolve_whatsapp_automation_version(unit_id,null,'confirmation');
  if (selected->>'version',selected->>'source',selected->>'enrollment_id',
      selected->>'channel_id')
    is distinct from ('2','auto',v_onboarding_id::text,reserved_channel::text) then
    raise exception '77_auto_preconfig_selection: %',selected; end if;
  if exists(select 1 from public.whatsapp_automation_adoptions a
      where a.unit_id=fixture.unit_id) then
    raise exception '77_auto_fixture_adopted_early'; end if;
  denied:=null;
  begin
    perform public.enqueue_whatsapp_automation(jsonb_build_object(
      'unit_id',unit_id,'kind','confirmation','reservation_id',reservation_id,
      'source_event_key','local-auto-v2','fact_at',fact,
      'expires_at',fact+interval '1 day','due_at',fact));
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from 'P0A01'
    or exists(select 1 from app_private.whatsapp_cutover_intents i
       where i.unit_id=fixture.unit_id and i.kind='confirmation' and i.resource_id=fixture.reservation_id)
    or exists(select 1 from public.whatsapp_automation_jobs j
       where j.unit_id=fixture.unit_id and j.kind='confirmation' and j.reservation_id=fixture.reservation_id) then
    raise exception '77_preadoption_claimed_managed_fact: %',denied; end if;
  -- Establish adoption through the real admin cutover RPC, which creates and
  -- consumes the adoption permit. Then remove this disposable binding to
  -- model the reconnect gap before the replacement binding is configured.
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials)
    values(reserved_channel,unit_id,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7702"}'::jsonb);
  insert into public.whatsapp_template_accounts
    (id,organization_id,waba_id,verified_at,created_at)
    values(preconfig_account,org_id,'7700000000002',clock_timestamp(),clock_timestamp());
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(unit_id,reserved_channel,preconfig_account,'datafy',clock_timestamp())
    returning id into binding_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  v_released:=public.release_whatsapp_template_channel(reserved_channel,'dispatch',true,0,1);
  if v_released is distinct from true or not exists(select 1 from public.whatsapp_automation_adoptions a
      where a.unit_id=fixture.unit_id) then
    raise exception '77_real_adoption_failed: release=%',v_released; end if;
  delete from public.whatsapp_template_bindings where id=binding_id;
  if exists(select 1 from public.whatsapp_template_bindings b
      where b.channel_id=reserved_channel) then
    raise exception '77_reconnect_gap_missing'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  job_id:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',unit_id,'kind','confirmation','reservation_id',reservation_id,
    'source_event_key','local-auto-v2','fact_at',fact,
    'expires_at',fact+interval '1 day','due_at',fact));
  next_job:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',unit_id,'kind','confirmation','reservation_id',reservation_id,
    'source_event_key','local-auto-v2','fact_at',fact,
    'expires_at',fact+interval '1 day','due_at',fact));
  if job_id is null or next_job is distinct from job_id
    or not exists(select 1 from public.whatsapp_automation_jobs j where j.id=job_id
      and j.initial_template_version=2 and j.initial_selection_source='auto'
      and j.initial_selection_revision=1 and j.initial_enrollment_id=v_onboarding_id
      and j.initial_catalog_key='res_confirmacao_v2'
       and j.channel_id=reserved_channel and j.binding_id is null
      and j.pin_phase='preconfiguration' and j.state='blocked') then
    raise exception '77_auto_preconfig_pin_or_idempotence: %',job_id; end if;
  -- Reconnect the same reserved channel through a new binding generation.
  -- The old generation cannot initialize the preconfigured v2 fact; the
  -- authorized new generation can bind it without changing its version.
  update public.whatsapp_datafy_onboardings
    set state='completed',datafy_channel_id='local-auto-77',
      completed_at=clock_timestamp()
    where id=v_onboarding_id;
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,generation,verified_at)
    values(unit_id,reserved_channel,preconfig_account,'datafy',2,clock_timestamp())
    returning id into rebound_binding;
  if public.authorize_whatsapp_template_v2_channel(
      v_onboarding_id,rebound_binding,2,0) is distinct from true
    or public.mark_whatsapp_template_v2_preparation(
      v_onboarding_id,reserved_channel,'ready',null) is distinct from true then
    raise exception '77_reconnect_v2_grant_or_mark_failed'; end if;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation,remote_id,observed_hash,effective_category,remote_status,
      local_status,sync_required,last_synced_at,quality)
    select preconfig_account,a.logical_id,2,'pt_BR',a.logical_id,
      a.desired_hash,a.requested_category,1,'local-77-rebound-'||a.logical_id,
      a.desired_hash,a.requested_category,'APPROVED','usable',false,
      clock_timestamp(),'GREEN'
    from app_private.whatsapp_template_approved_submissions a
    where a.version=2 and a.logical_id in
      ('res_confirmacao_v2','res_confirmacao_desconto_v2');
  update public.whatsapp_template_accounts set
    sync_capture_id=gen_random_uuid(),sync_binding_id=rebound_binding,
    sync_binding_generation=2,sync_credential_revision=0,
    last_sync_published_at=clock_timestamp()
    where id=preconfig_account;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  if public.release_whatsapp_template_channel(reserved_channel,'dispatch',true,0,2)
      is distinct from true then raise exception '77_reconnect_dispatch_release_failed'; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(
    rebound_binding,'confirmation');
  if v_ready->>'ready' is distinct from 'true' then
    raise exception '77_reconnect_v2_not_ready: %',v_ready; end if;
  denied:=null;
  begin
    perform public.initialize_whatsapp_automation_job(job_id,reserved_channel,1);
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from 'PT409' then
    raise exception '77_reconnect_old_generation_not_rejected: %',denied; end if;
  v_post_allowed:=public.initialize_whatsapp_automation_job(job_id,reserved_channel,2);
  if v_post_allowed is distinct from true
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=job_id and j.initial_template_version=2
        and j.initial_selection_source='auto' and j.binding_id=rebound_binding
        and j.binding_generation=2 and j.pin_phase='bound') then
    raise exception '77_reconnect_v2_pin_failed: result %, job %',
      v_post_allowed,(select row_to_json(j) from public.whatsapp_automation_jobs j
        where j.id=job_id); end if;
  update public.platform_flags set value='true'::jsonb
    where key='whatsapp_automation_dispatch';
  update public.whatsapp_automation_jobs
    set due_at=clock_timestamp()-interval '1 second' where id=job_id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_claim:=public.claim_whatsapp_automation(job_id);
  v_fence:=(v_claim->>'claim_token')::uuid;
  select sync_epoch into v_sync_epoch from public.whatsapp_automation_jobs
    where id=job_id;
  if v_fence is null then raise exception '77_reconnect_claim_missing'; end if;
  update public.whatsapp_automation_jobs
    set safe_log_body='Task77 local reconnect render' where id=job_id;
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
      party_size,reservation_code)
    values(grant_unprepared_res,unit_id,customer_id,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V77-'||grant_unprepared_res);
  grant_unprepared_job:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',unit_id,'kind','confirmation','reservation_id',grant_unprepared_res,
    'source_event_key','local-revoked-grant-prepare','fact_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '1 day',
    'due_at',clock_timestamp()-interval '1 second'));
  v_claim:=public.claim_whatsapp_automation(grant_unprepared_job);
  grant_unprepared_fence:=(v_claim->>'claim_token')::uuid;
  select sync_epoch into grant_unprepared_epoch
    from public.whatsapp_automation_jobs where id=grant_unprepared_job;
  if grant_unprepared_fence is null or grant_unprepared_epoch is null
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=grant_unprepared_job and j.initial_template_version=2
        and j.initial_selection_source='auto' and j.binding_id=rebound_binding)
    then raise exception '77_grant_unprepared_fixture_missing'; end if;
  update public.whatsapp_automation_jobs
    set safe_log_body='Task77 local unprepared render'
    where id=grant_unprepared_job;
  v_post_allowed:=public.prepare_whatsapp_automation_post(
    job_id,v_fence,2,null,v_sync_epoch);
  if v_post_allowed is distinct from true
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=job_id and j.state='posting' and j.attempts=1
        and j.posting_started_at is not null and j.provider_message_id is null) then
    raise exception '77_valid_grant_prepare_failed: result %, job %',
      v_post_allowed,(select jsonb_build_object('state',j.state,'error',j.error_code,
        'attempts',j.attempts,'posting',j.posting_started_at)
        from public.whatsapp_automation_jobs j where j.id=job_id); end if;
  -- v2 grants have no wall-clock expiry: revocation makes this grant stale.
  -- A prepared job must fail confirm, while an unprepared job fails prepare.
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  if public.release_whatsapp_template_v2_channel(rebound_binding,2,0)
      is distinct from true then raise exception '77_reconnect_v2_revoke_failed'; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(
    rebound_binding,'confirmation');
  selected:=public.set_whatsapp_automation_version_selection(
    rebound_binding,'confirmation',2,0,2,0);
  if v_ready->>'reason_code' is distinct from 'grant_unavailable'
    or selected->>'state' is distinct from 'not_ready'
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=job_id and j.initial_template_version=2
        and j.initial_selection_source='auto' and j.binding_id=rebound_binding) then
    raise exception '77_revoked_grant_did_not_close: %, %',v_ready,selected; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_confirm_allowed:=public.confirm_whatsapp_automation_post(
    job_id,v_fence,2,null,v_sync_epoch);
  v_post_allowed:=public.prepare_whatsapp_automation_post(
    grant_unprepared_job,grant_unprepared_fence,2,null,grant_unprepared_epoch);
  if v_confirm_allowed is distinct from false
    or v_post_allowed is distinct from false
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=job_id and j.initial_template_version=2
        and j.state='posting' and j.attempts=1
        and j.posting_started_at is not null and j.provider_message_id is null)
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=grant_unprepared_job and j.initial_template_version=2
        and j.error_code='template_unavailable' and j.state='blocked'
        and j.attempts=0 and j.posting_started_at is null) then
    raise exception '77_revoked_grant_post_gate_failed: confirm %, prepare %, jobs %',
      v_confirm_allowed,v_post_allowed,
      (select jsonb_agg(jsonb_build_object('id',j.id,'state',j.state,
        'error',j.error_code,'attempts',j.attempts,'posting',j.posting_started_at))
        from public.whatsapp_automation_jobs j
        where j.id in(job_id,grant_unprepared_job)); end if;
  -- An existing Datafy/WABA with a v1 remote model is proven legacy until
  -- the admin records an explicit version for each purpose.
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(manual_channel,manual_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7701"}'::jsonb,'local-only');
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(account_id,org_id,'7700000000001',clock_timestamp());
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(manual_unit,manual_channel,account_id,'datafy',clock_timestamp())
    returning id into binding_id;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation)
    select account_id,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      a.desired_hash,a.requested_category,1
    from app_private.whatsapp_template_approved_submissions a
    where a.logical_id='res_confirmacao_v1' and a.version=1;
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),
    sync_binding_id=binding_id,sync_binding_generation=1,sync_credential_revision=0,
    last_sync_published_at=clock_timestamp() where id=account_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  denied:=null;
  begin perform public.get_whatsapp_automation_version_selections(binding_id);
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '42501' then raise exception '77_owner_admin_getter: %',denied; end if;
  denied:=null;
  begin perform public.get_whatsapp_automation_dispatch_status(gen_random_uuid());
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '42501' then raise exception '77_missing_binding_oracle: %',denied; end if;
  store_status:=public.get_whatsapp_automation_dispatch_status(binding_id);
  if jsonb_array_length(store_status->'entries')<>8
    or store_status->>'channel_id' is distinct from manual_channel::text
    or store_status#>>'{entries,0,readiness}' is distinct from 'pending_meta' then
    raise exception '77_store_v1_false_ready: %',store_status; end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  snapshot:=public.get_whatsapp_automation_version_selections(binding_id);
  if jsonb_array_length(snapshot->'entries')<>8
    or snapshot#>>'{entries,0,selected_version}' is distinct from '1'
    or snapshot#>>'{entries,0,selection_source}' is distinct from 'legacy'
    or snapshot#>>'{entries,0,revision}' is distinct from '0' then
    raise exception '77_legacy_not_proven: %',snapshot; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'confirmation',2,0,1,0);
  if selected->>'state' is distinct from 'not_ready' then
    raise exception '77_unapproved_v2_selected: %',selected; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'confirmation',1,0,1,0);
  if selected is distinct from '{"state":"selected","version":1,"revision":1}'::jsonb then
    raise exception '77_manual_v1_not_selected: %',selected; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'confirmation',2,0,1,0);
  if selected->>'state' is distinct from 'stale'
    or selected->>'version' is distinct from '1'
    or selected->>'revision' is distinct from '1' then
    raise exception '77_cas_replay: %',selected; end if;
  snapshot:=public.get_whatsapp_automation_version_selections(binding_id);
  if snapshot#>>'{entries,0,selection_source}' is distinct from 'admin'
    or snapshot#>>'{entries,0,selected_version}' is distinct from '1' then
    raise exception '77_explicit_v1_missing: %',snapshot; end if;
  -- Create a truthful ready v1 fixture, adopt via the same administrative RPC,
  -- then simulate a lost adoption row by bypassing only its immutable-evidence
  -- DELETE guard in this rollback-only, networkless database.
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation)
    select fixture.account_id,'res_confirmacao_desconto_v1',1,'pt_BR',
      'res_confirmacao_desconto_v1',a.desired_hash,a.requested_category,1
    from app_private.whatsapp_template_approved_submissions a
    where a.logical_id='res_confirmacao_desconto_v1' and a.version=1;
  update public.whatsapp_remote_templates t set
    remote_id='local-77-'||logical_id,observed_hash=desired_hash,
    effective_category=requested_category,remote_status='APPROVED',
    local_status='usable',sync_required=false,last_synced_at=clock_timestamp(),
    quality='GREEN'
    where t.account_id=fixture.account_id and t.logical_id in
      ('res_confirmacao_v1','res_confirmacao_desconto_v1');
  -- A pending first variant must not conceal a rejected second variant.
  update public.whatsapp_remote_templates t set remote_status='PENDING'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v1';
  update public.whatsapp_remote_templates t set remote_status='REJECTED'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_desconto_v1';
  v_ready:=app_private.whatsapp_automation_v1_readiness(binding_id,'confirmation');
  if v_ready->>'reason_code' is distinct from 'meta_rejected' then
    raise exception '77_v1_mixed_status_order_a: %',v_ready; end if;
  update public.whatsapp_remote_templates t set remote_status='REJECTED'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v1';
  update public.whatsapp_remote_templates t set remote_status='PENDING'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_desconto_v1';
  v_ready:=app_private.whatsapp_automation_v1_readiness(binding_id,'confirmation');
  if v_ready->>'reason_code' is distinct from 'meta_rejected' then
    raise exception '77_v1_mixed_status_order_b: %',v_ready; end if;
  update public.whatsapp_remote_templates t set remote_status='APPROVED'
    where t.account_id=fixture.account_id and t.logical_id in
      ('res_confirmacao_v1','res_confirmacao_desconto_v1');
  update public.platform_flags set value='true'::jsonb
    where key='whatsapp_automation_dispatch';
  if public.release_whatsapp_template_channel(manual_channel,'dispatch',true,0,1)
    is distinct from true then raise exception '77_manual_adoption_failed'; end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  store_status:=public.get_whatsapp_automation_dispatch_status(binding_id);
  if store_status#>>'{entries,0,readiness}' is distinct from 'ready'
    or not exists(select 1 from public.whatsapp_automation_adoptions adoption
      where adoption.unit_id=manual_unit) then
    raise exception '77_ready_baseline_missing: %',store_status; end if;
  -- Preserve the published v1 quality rule: RED blocks MARKETING, whereas
  -- utility quality is not by itself a v1 dispatch refusal.
  update public.whatsapp_remote_templates t set quality='RED'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v1';
  store_status:=public.get_whatsapp_automation_dispatch_status(binding_id);
  if store_status#>>'{entries,0,readiness}' is distinct from 'ready' then
    raise exception '77_v1_utility_red_regressed: %',store_status; end if;
  update public.whatsapp_remote_templates t set quality='GREEN'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v1';
  -- Simulate the pre-key historical v1 row in this rollback-only fixture.
  -- The original scope trigger remains enabled for the actual regression:
  -- receipt/state updates must work, while version changes remain forbidden.
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
      party_size,reservation_code)
    values(historical_res,manual_unit,customer_id,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V77-'||historical_res);
  historical_job:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',manual_unit,'kind','confirmation','reservation_id',historical_res,
    'source_event_key','local-historical-v1','fact_at',fact,
    'expires_at',fact+interval '1 day','due_at',fact));
  if historical_job is null or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=historical_job and j.remote_template_id is not null
        and j.initial_template_version=1) then
    raise exception '77_historical_v1_fixture_missing'; end if;
  execute 'set constraints all immediate';
  execute 'alter table public.whatsapp_automation_jobs disable trigger whatsapp_template_scope';
  update public.whatsapp_automation_jobs set initial_catalog_key=null
    where id=historical_job;
  execute 'alter table public.whatsapp_automation_jobs enable trigger whatsapp_template_scope';
  update public.whatsapp_automation_jobs set state=state where id=historical_job;
  denied:=null;
  begin update public.whatsapp_automation_jobs set initial_template_version=2
    where id=historical_job;
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '23514' or not exists(select 1
      from public.whatsapp_automation_jobs j where j.id=historical_job
        and j.initial_template_version=1 and j.initial_catalog_key is null) then
    raise exception '77_historical_v1_update_or_immutable: %',denied; end if;
  -- Grant the legacy account through the real audited admin RPC, then
  -- publish both exact approved v2 copies in this rollback-only fixture.
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  if public.select_whatsapp_template_v2_existing_account(binding_id,1,0,
      app_private.whatsapp_template_approved_catalog_digest(2)) is distinct from true then
    raise exception '77_manual_v2_grant_failed'; end if;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation,remote_id,observed_hash,effective_category,remote_status,
      local_status,sync_required,last_synced_at,quality)
    select fixture.account_id,a.logical_id,2,'pt_BR',a.logical_id,
      a.desired_hash,a.requested_category,1,'local-77-'||a.logical_id,
      a.desired_hash,a.requested_category,'APPROVED','usable',false,
      clock_timestamp(),'GREEN'
    from app_private.whatsapp_template_approved_submissions a
    where a.version=2 and a.logical_id in
      ('res_confirmacao_v2','res_confirmacao_desconto_v2');
  update public.whatsapp_remote_templates t set remote_status='PENDING'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v2';
  update public.whatsapp_remote_templates t set remote_status='REJECTED'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_desconto_v2';
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'confirmation');
  if v_ready->>'reason_code' is distinct from 'meta_rejected'
    or v_ready#>>'{variants,0,ready}' is distinct from 'false'
    or v_ready#>>'{variants,1,ready}' is distinct from 'false' then
    raise exception '77_v2_mixed_status_order_a: %',v_ready; end if;
  update public.whatsapp_remote_templates t set remote_status='REJECTED'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_v2';
  update public.whatsapp_remote_templates t set remote_status='PENDING'
    where t.account_id=fixture.account_id and t.logical_id='res_confirmacao_desconto_v2';
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'confirmation');
  if v_ready->>'reason_code' is distinct from 'meta_rejected' then
    raise exception '77_v2_mixed_status_order_b: %',v_ready; end if;
  update public.whatsapp_remote_templates t set remote_status='APPROVED'
    where t.account_id=fixture.account_id and t.logical_id in
      ('res_confirmacao_v2','res_confirmacao_desconto_v2');
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'confirmation');
  if v_ready->>'ready' is distinct from 'true'
    or v_ready#>>'{variants,0,ready}' is distinct from 'true'
    or v_ready#>>'{variants,1,ready}' is distinct from 'true' then
    raise exception '77_manual_v2_not_ready: %',v_ready; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'confirmation',2,1,1,0);
  if selected is distinct from '{"state":"selected","version":2,"revision":2}'::jsonb then
    raise exception '77_manual_v2_selection_failed: %',selected; end if;
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
      party_size,reservation_code)
    values(v2_res,manual_unit,customer_id,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V77-'||v2_res);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  job_id:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',manual_unit,'kind','confirmation','reservation_id',v2_res,
    'source_event_key','local-approved-v2','fact_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '1 day',
    'due_at',clock_timestamp()-interval '1 second'));
  if job_id is null or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=job_id and j.initial_template_version=2
        and j.initial_selection_source='admin' and j.initial_selection_revision=2
        and j.initial_catalog_key='res_confirmacao_v2'
        and j.state='queued' and j.pin_phase='bound') then
    raise exception '77_approved_v2_enqueue_failed: %',job_id; end if;
  v_claim:=public.claim_whatsapp_automation(job_id);
  v_fence:=(v_claim->>'claim_token')::uuid;
  select sync_epoch into v_sync_epoch from public.whatsapp_automation_jobs where id=job_id;
  if v_fence is null then raise exception '77_approved_v2_claim_failed: %',v_claim; end if;
  update public.whatsapp_automation_jobs set safe_log_body='Task77 local render'
    where id=job_id;
  if public.prepare_whatsapp_automation_post(job_id,v_fence,1,null,v_sync_epoch)
      is distinct from true
    or public.confirm_whatsapp_automation_post(job_id,v_fence,1,null,v_sync_epoch)
      is distinct from true then
    raise exception '77_approved_v2_prepare_confirm_failed'; end if;
  if public.confirm_whatsapp_automation_post(job_id,v_fence,1,null,v_sync_epoch)
      is distinct from false then
    raise exception '77_v2_double_confirm_allowed'; end if;
  -- A new fact pinned to v2 loses POST authority when the admin changes
  -- the selection. The durable job keeps its original version and ID.
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
      party_size,reservation_code)
    values(v2_res2,manual_unit,customer_id,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V77-'||v2_res2);
  next_job:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',manual_unit,'kind','confirmation','reservation_id',v2_res2,
    'source_event_key','local-v2-deselect','fact_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '1 day',
    'due_at',clock_timestamp()-interval '1 second'));
  if next_job is null or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=next_job and j.initial_template_version=2) then
    raise exception '77_deselect_fixture_missing'; end if;
  v_claim:=public.claim_whatsapp_automation(next_job);
  v_fence:=(v_claim->>'claim_token')::uuid;
  select sync_epoch into v_sync_epoch from public.whatsapp_automation_jobs where id=next_job;
  if v_fence is null then raise exception '77_deselect_claim_missing'; end if;
  update public.whatsapp_automation_jobs set safe_log_body='Task77 local render'
    where id=next_job;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'confirmation',1,2,1,0);
  if selected is distinct from '{"state":"selected","version":1,"revision":3}'::jsonb then
    raise exception '77_deselect_admin_failed: %',selected; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_post_allowed:=public.prepare_whatsapp_automation_post(next_job,v_fence,1,null,v_sync_epoch);
  if v_post_allowed is distinct from false or not exists(select 1 from public.whatsapp_automation_jobs j
        where j.id=next_job and j.initial_template_version=2
          and j.state='blocked' and j.error_code='template_unavailable') then
    raise exception '77_deselect_did_not_block_v2_post: allowed %, state %, error %',
      v_post_allowed,(select j.state from public.whatsapp_automation_jobs j where j.id=next_job),
      (select j.error_code from public.whatsapp_automation_jobs j where j.id=next_job); end if;
  -- A v1 cost authorization does not silently authorize MARKETING v2.
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation,remote_id,observed_hash,effective_category,remote_status,
      local_status,sync_required,last_synced_at,quality)
    select fixture.account_id,a.logical_id,2,'pt_BR',a.logical_id,
      a.desired_hash,a.requested_category,1,'local-77-'||a.logical_id,
      a.desired_hash,a.requested_category,'APPROVED','usable',false,
      clock_timestamp(),'GREEN'
    from app_private.whatsapp_template_approved_submissions a
    where a.version=2 and a.logical_id='mkt_voucher_programado_v2';
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'voucher_issued');
  if v_ready->>'reason_code' is distinct from 'cost_not_authorized' then
    raise exception '77_marketing_v2_cost_missing_not_blocked: %',v_ready; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  if public.authorize_whatsapp_marketing_cost(manual_channel,1,'MARKETING',
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')
      is null then raise exception '77_marketing_v1_cost_grant_failed'; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'voucher_issued');
  if v_ready->>'reason_code' is distinct from 'cost_not_authorized' then
    raise exception '77_marketing_v1_cost_borrowed_by_v2: %',v_ready; end if;
  if public.authorize_whatsapp_marketing_cost(manual_channel,1,'MARKETING',
      clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '1 hour',2)
      is null then raise exception '77_marketing_v2_future_cost_grant_failed'; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'voucher_issued');
  if v_ready->>'reason_code' is distinct from 'cost_not_authorized' then
    raise exception '77_marketing_v2_future_cost_unlocked_early: %',v_ready; end if;
  if public.authorize_whatsapp_marketing_cost(manual_channel,1,'MARKETING',
      clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',2)
      is null then raise exception '77_marketing_v2_cost_grant_failed'; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'voucher_issued');
  if v_ready->>'ready' is distinct from 'true' then
    raise exception '77_marketing_v2_cost_did_not_unlock: %',v_ready; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    binding_id,'voucher_issued',2,0,1,0);
  if selected->>'state' is distinct from 'selected'
    or selected->>'revision' is distinct from '1' then
    raise exception '77_marketing_v2_selection_missing: %',selected; end if;
  insert into public.voucher_rules
    (id,unit_id,name,trigger_type,discount_percent,validity_days,
      min_rating,visits_required,days_window,active,created_at,updated_at)
    values(voucher_rule,manual_unit,'Task77 local','birthday',15,30,
      null,null,null,true,clock_timestamp(),clock_timestamp()),
      (voucher_rule_two,manual_unit,'Task77 second','frequency',15,30,
      null,2,30,true,clock_timestamp(),clock_timestamp());
  insert into public.vouchers
    (id,unit_id,customer_id,rule_id,code,discount_percent,
      issued_at,created_at,expires_at,status)
    values(voucher_one,manual_unit,customer_id,voucher_rule,
      'V77-'||voucher_one,15,clock_timestamp(),clock_timestamp(),
      clock_timestamp()+interval '30 days','active'),
      (voucher_two,manual_unit,customer_id,voucher_rule_two,
      'V77-'||voucher_two,15,clock_timestamp(),clock_timestamp(),
      clock_timestamp()+interval '30 days','active');
  insert into public.whatsapp_message_consent_events
    (unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at)
    values(manual_unit,customer_id,'promotional','opt_in','fixture',
      'task77-local-voucher',clock_timestamp()) returning revision into marketing_revision;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  marketing_job:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',manual_unit,'kind','voucher_issued','voucher_id',voucher_one,
    'source_event_key','local-cost-confirm','fact_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '1 day',
    'due_at',clock_timestamp()-interval '1 second'));
  marketing_job_two:=public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',manual_unit,'kind','voucher_issued','voucher_id',voucher_two,
    'source_event_key','local-cost-prepare','fact_at',clock_timestamp(),
    'expires_at',clock_timestamp()+interval '1 day',
    'due_at',clock_timestamp()-interval '1 second'));
  v_claim:=public.claim_whatsapp_automation(marketing_job);
  marketing_fence:=(v_claim->>'claim_token')::uuid;
  v_claim:=public.claim_whatsapp_automation(marketing_job_two);
  marketing_fence_two:=(v_claim->>'claim_token')::uuid;
  select sync_epoch into marketing_epoch from public.whatsapp_automation_jobs
    where id=marketing_job;
  if marketing_fence is null or marketing_fence_two is null
    or marketing_epoch is null or marketing_revision is null then
    raise exception '77_marketing_claim_fixture_missing'; end if;
  update public.whatsapp_automation_jobs
    set safe_log_body='Task77 local voucher render'
    where id in(marketing_job,marketing_job_two);
  v_post_allowed:=public.prepare_whatsapp_automation_post(marketing_job,
    marketing_fence,1,marketing_revision,marketing_epoch);
  if v_post_allowed is distinct from true
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=marketing_job and j.state='posting' and j.attempts=1
        and j.cost_authorization_id is not null) then
    raise exception '77_marketing_valid_cost_prepare_failed: prepare %, job %',
      v_post_allowed,(select jsonb_build_object('state',j.state,
        'error',j.error_code,'attempts',j.attempts,'cost',j.cost_authorization_id)
        from public.whatsapp_automation_jobs j where j.id=marketing_job); end if;
  -- Simulate passage of time in this rollback-only fixture. Production cost
  -- evidence is immutable; temporarily bypass only that UPDATE guard while
  -- preserving every scope/CHECK and restoring it before the actual gate.
  execute 'alter table public.whatsapp_template_cost_authorizations disable trigger whatsapp_template_evidence';
  update public.whatsapp_template_cost_authorizations ca
    set valid_until=clock_timestamp()-interval '1 second'
    where ca.account_id=fixture.account_id and ca.binding_id=fixture.binding_id
      and ca.version=2 and ca.valid_from<clock_timestamp();
  get diagnostics changed_count=row_count;
  execute 'alter table public.whatsapp_template_cost_authorizations enable trigger whatsapp_template_evidence';
  if changed_count<>1 or not exists(select 1 from pg_catalog.pg_trigger t
      where t.tgrelid='public.whatsapp_template_cost_authorizations'::regclass
        and t.tgname='whatsapp_template_evidence' and t.tgenabled='O') then
    raise exception '77_expired_v2_cost_fixture_invalid: %',changed_count; end if;
  v_ready:=app_private.whatsapp_automation_v2_readiness(binding_id,'voucher_issued');
  if v_ready->>'reason_code' is distinct from 'cost_not_authorized' then
    raise exception '77_expired_v2_cost_did_not_close: %',v_ready; end if;
  v_confirm_allowed:=public.confirm_whatsapp_automation_post(marketing_job,
    marketing_fence,1,marketing_revision,marketing_epoch);
  v_post_allowed:=public.prepare_whatsapp_automation_post(marketing_job_two,
    marketing_fence_two,1,marketing_revision,marketing_epoch);
  if v_confirm_allowed is distinct from false
    or v_post_allowed is distinct from false
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=marketing_job and j.initial_template_version=2
        and j.state='posting' and j.attempts=1 and j.provider_message_id is null)
    or not exists(select 1 from public.whatsapp_automation_jobs j
      where j.id=marketing_job_two and j.initial_template_version=2
        and j.state='blocked' and j.error_code='cost_not_authorized'
        and j.attempts=0 and j.posting_started_at is null) then
    raise exception '77_expired_v2_cost_post_gates_failed: confirm %, prepare %, jobs %',
      v_confirm_allowed,v_post_allowed,
      (select jsonb_agg(jsonb_build_object('id',j.id,'state',j.state,
        'error',j.error_code,'attempts',j.attempts,'posting',j.posting_started_at))
        from public.whatsapp_automation_jobs j
        where j.id in(marketing_job,marketing_job_two)); end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  -- One WABA can be shared inside an organization, but a sibling binding
  -- cannot borrow the first unit's v2 grant or administrative selection.
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials)
    values(sibling_channel,sibling_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7703"}'::jsonb);
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(sibling_unit,sibling_channel,account_id,'datafy',clock_timestamp())
    returning id into sibling_binding;
  v_ready:=app_private.whatsapp_automation_v2_readiness(sibling_binding,'confirmation');
  if v_ready->>'ready' is distinct from 'false'
    or v_ready->>'reason_code' is distinct from 'grant_unavailable' then
    raise exception '77_shared_waba_borrowed_v2_grant: %',v_ready; end if;
  selected:=public.set_whatsapp_automation_version_selection(
    sibling_binding,'confirmation',2,0,1,0);
  if selected->>'state' is distinct from 'not_ready' then
    raise exception '77_shared_waba_borrowed_selection: %',selected; end if;
  denied:=null;
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials)
    values(foreign_channel,other_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7704"}'::jsonb);
  begin
    insert into public.whatsapp_template_bindings
      (unit_id,channel_id,account_id,provider,verified_at)
      values(other_unit,foreign_channel,account_id,'datafy',clock_timestamp());
  exception when others then get stacked diagnostics denied=returned_sqlstate; end;
  if denied is distinct from '23514' then
    raise exception '77_cross_tenant_binding_wrong_refusal: %',denied; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  execute 'set constraints all immediate';
  execute 'alter table public.whatsapp_automation_adoptions disable trigger whatsapp_template_evidence';
  delete from public.whatsapp_automation_adoptions adoption
    where adoption.unit_id=manual_unit;
  execute 'alter table public.whatsapp_automation_adoptions enable trigger whatsapp_template_evidence';
  store_status:=public.get_whatsapp_automation_dispatch_status(binding_id);
  if store_status#>>'{entries,0,readiness}' is distinct from 'awaiting_dispatch'
    or store_status#>>'{entries,0,reason_code}' is distinct from 'dispatch_paused'
    or not exists(select 1 from public.whatsapp_template_bindings b
      where b.id=fixture.binding_id and b.dispatch_enabled and b.adopted_at is not null) then
    raise exception '77_missing_adoption_false_ready: %',store_status; end if;
  raise notice '77_PASS auto-preconfig/reconnect/generation, revoked v2 grant prepared-confirm/unprepared-prepare, approved v2 enqueue/POST, deselection, v1/v2 Meta variants, expired cost prepare/confirm, shared WABA/tenant, historical v1, CAS, ACL, adoption store';
end $$;
rollback;

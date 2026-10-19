\set ON_ERROR_STOP on
-- Run after 25→72 template bootstrap, the Datafy onboarding migration, and
-- 20261017203000 on an isolated networkless PostgreSQL 17 container.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
declare
  v_org uuid:=gen_random_uuid(); v_other_org uuid:=gen_random_uuid();
  v_unit uuid:=gen_random_uuid(); v_sibling_unit uuid:=gen_random_uuid(); v_other_unit uuid:=gen_random_uuid();
  v_admin uuid:=gen_random_uuid(); v_owner uuid:=gen_random_uuid();
  v_old_onboarding uuid:=gen_random_uuid(); v_onboarding uuid:=gen_random_uuid(); v_onboarding2 uuid:=gen_random_uuid();
  v_onboarding3 uuid:=gen_random_uuid();
  v_old_channel uuid:=gen_random_uuid(); v_channel uuid:=gen_random_uuid(); v_channel2 uuid:=gen_random_uuid();
  v_channel3 uuid:=gen_random_uuid(); v_other_channel uuid:=gen_random_uuid();
  v_account uuid:=gen_random_uuid(); v_other_account uuid:=gen_random_uuid();
  v_binding uuid; v_binding2 uuid; v_binding3 uuid; v_other_binding uuid; v_remote uuid:=gen_random_uuid();
  v_job uuid:=gen_random_uuid(); v_fence uuid:=gen_random_uuid();
  v_payload text:='4ab2cdd4711c9b95b122a23a773088bfa8b6d3d15a6eac04cb234d4f8d0ac114';
  v_desired text:='ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1';
  v_state jsonb; v_denied text; v_count integer; v_stop boolean; v_mark boolean; v_claimed_channel uuid;
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'template_auto_local_quarantine_required';
  end if;
  if (select enabled or revision<>0 from app_private.whatsapp_template_auto_policy where id=1) then
    raise exception 'template_auto_default_not_off';
  end if;
  if app_private.whatsapp_template_approved_catalog_digest() is distinct from
      'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965'
    or (select count(*) from app_private.whatsapp_template_approved_submissions where version=1)<>9 then
    raise exception 'template_auto_catalog_not_nine';
  end if;
  if has_table_privilege('service_role','app_private.whatsapp_template_auto_policy','UPDATE')
    or has_table_privilege('authenticated','app_private.whatsapp_template_auto_enrollments','SELECT')
    or has_function_privilege('anon','public.configure_whatsapp_template_auto_policy(boolean,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.record_whatsapp_template_heartbeat(uuid,uuid,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.record_whatsapp_template_heartbeat(uuid,uuid,bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.authorize_whatsapp_template_auto_channel(uuid,uuid,bigint,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.authorize_whatsapp_template_auto_channel(uuid,uuid,bigint,bigint)','EXECUTE') then
    raise exception 'template_auto_acl_open_or_missing';
  end if;

  insert into auth.users(id) values(v_admin),(v_owner);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'Auto template local'),(v_other_org,'Other local');
  insert into public.units(id,organization_id,name)
    values(v_unit,v_org,'Auto local'),(v_sibling_unit,v_org,'Sibling local'),(v_other_unit,v_other_org,'Other local');
  insert into public.unit_members(user_id,unit_id,role) values(v_owner,v_unit,'owner');
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';

  -- A connection created before global activation never acquires enrollment.
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_old_onboarding,v_org,v_unit,v_old_channel);
  if exists(select from app_private.whatsapp_template_auto_enrollments where onboarding_id=v_old_onboarding) then
    raise exception 'template_auto_old_connection_enrolled';
  end if;
  update public.whatsapp_datafy_onboardings set state='abandoned',abandoned_at=clock_timestamp()
    where id=v_old_onboarding;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_denied:=null;
  begin perform public.configure_whatsapp_template_auto_policy(true,0);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception 'template_auto_owner_set_global_policy'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_denied:=null;
  begin perform public.configure_whatsapp_template_auto_policy(true,0);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception 'template_auto_service_spoofed_admin'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_state:=public.configure_whatsapp_template_auto_policy(true,0);
  if v_state->>'enabled'<>'true' or (v_state->>'revision')::bigint<>1 then
    raise exception 'template_auto_enable_failed';
  end if;
  v_denied:=null;
  begin perform public.configure_whatsapp_template_auto_policy(false,0);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from 'PT409' then raise exception 'template_auto_policy_revision_replay'; end if;

  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding,v_org,v_unit,v_channel);
  if (select count(*) from app_private.whatsapp_template_auto_enrollments where onboarding_id=v_onboarding
      and policy_revision=1 and organization_id=v_org and unit_id=v_unit and channel_id=v_channel
      and state='pending' and excluded_at is null)<>1 then
    raise exception 'template_auto_new_connection_not_enrolled';
  end if;
  -- The service snapshot exists before a channel row exists; it contains no WABA/PII.
  v_state:=public.get_whatsapp_template_preparation(v_unit,v_channel);
  if v_state->>'enrollment'<>'eligible' or v_state->>'state'<>'pending'
    or v_state->>'onboarding_id'<>v_onboarding::text or v_state ? 'waba_id' then
    raise exception 'template_auto_prechannel_snapshot_wrong';
  end if;
  update public.whatsapp_datafy_onboardings set updated_at=clock_timestamp() where id=v_old_onboarding;
  if exists(select from app_private.whatsapp_template_auto_enrollments where onboarding_id=v_old_onboarding) then
    raise exception 'template_auto_old_reuse_enrolled';
  end if;

  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),'{"phone_number_id":"7301"}'::jsonb,'local-only');
  -- A /me result may arrive after a token rotation. Only the row-locked writer
  -- may refresh health, and its revision pin must still match at write time.
  update public.whatsapp_channels set status='provider_error',last_health_check_at='2026-01-01T00:00:00Z'
    where id=v_channel;
  v_denied:=null;
  begin perform public.record_whatsapp_template_heartbeat(v_unit,v_channel,0,'7301');
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception 'template_heartbeat_authenticated_allowed'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.record_whatsapp_template_heartbeat(v_unit,v_channel,0,'7309')
    or public.record_whatsapp_template_heartbeat(v_other_unit,v_channel,0,'7301')
    or exists(select from public.whatsapp_channels where id=v_channel
      and (status<>'provider_error' or last_health_check_at<>'2026-01-01T00:00:00Z'::timestamptz)) then
    raise exception 'template_heartbeat_identity_or_tenant_mismatch_wrote_health';
  end if;
  v_mark:=public.record_whatsapp_template_heartbeat(v_unit,v_channel,0,'7301');
  if v_mark is distinct from true
    or not exists(select from public.whatsapp_channels where id=v_channel
      and status='connected' and last_health_check_at>'2026-01-01T00:00:00Z'::timestamptz) then
    raise exception 'template_heartbeat_matching_identity_not_recorded: result=% state=%',v_mark,
      (select jsonb_build_object('status',status,'health',last_health_check_at,'revision',template_credential_revision,
        'date_ok',last_health_check_at>'2026-01-01T00:00:00Z'::timestamptz)
        from public.whatsapp_channels where id=v_channel);
  end if;
  update public.whatsapp_channels set status='provider_error',last_health_check_at='2026-01-01T00:00:00Z'
    where id=v_channel;
  begin
    update public.whatsapp_channels set credentials='{"phone_number_id":"7301","access_token":"local-rotated"}'::jsonb
      where id=v_channel;
    if (select template_credential_revision from public.whatsapp_channels where id=v_channel)<>1
      or public.record_whatsapp_template_heartbeat(v_unit,v_channel,0,'7301')
      or exists(select from public.whatsapp_channels where id=v_channel
        and (status<>'provider_error' or last_health_check_at<>'2026-01-01T00:00:00Z'::timestamptz)) then
      raise exception 'template_heartbeat_rotation_bypassed_revision';
    end if;
    raise exception using errcode='PT777',message='rollback_local_heartbeat_rotation';
  exception when sqlstate 'PT777' then null;
  end;
  update public.whatsapp_channels set status='connected',last_health_check_at=clock_timestamp()
    where id=v_channel;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7301',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding;
  -- Exhausted work is classified once and cannot starve later due channels.
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding2,v_org,v_unit,v_channel2);
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel2,v_unit,'datafy','provider_error',false,clock_timestamp(),'{"phone_number_id":"7302"}'::jsonb,'local-only');
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7302',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding2;
  update app_private.whatsapp_template_auto_enrollments set attempt_count=20,state='pending',
    next_attempt_at=clock_timestamp()-interval '2 minutes' where onboarding_id=v_onboarding;
  update app_private.whatsapp_template_auto_enrollments set next_attempt_at=clock_timestamp()-interval '1 minute'
    where onboarding_id=v_onboarding2;
  select count(*) into v_count from public.claim_due_whatsapp_template_preparations(1);
  if v_count<>0 or not exists(select from app_private.whatsapp_template_auto_enrollments
      where onboarding_id=v_onboarding and state='needs_review' and reason_code='manual_review'
        and next_attempt_at='infinity'::timestamptz) then
    raise exception 'template_auto_exhaustion_not_classified';
  end if;
  if public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'pending','provider_unavailable') then
    raise exception 'template_auto_exhausted_task_revived';
  end if;
  select due.channel_id into v_claimed_channel from public.claim_due_whatsapp_template_preparations(1) due;
  if v_claimed_channel is distinct from v_channel2 then
    raise exception 'template_auto_exhaustion_starved_provider_error_channel';
  end if;
  update app_private.whatsapp_template_auto_enrollments set attempt_count=0,state='pending',reason_code=null,
    next_attempt_at=clock_timestamp() where onboarding_id=v_onboarding;
  update app_private.whatsapp_template_auto_enrollments set state='needs_review',reason_code='manual_review',
    next_attempt_at='infinity'::timestamptz where onboarding_id=v_onboarding2;
  -- Admin can exclude an enrolled channel before its WABA/binding exists.
  v_stop:=public.release_whatsapp_template_channel(v_channel2,'catalog',false,0,null);
  if v_stop is distinct from true or not exists(
    select from app_private.whatsapp_template_auto_enrollments
    where onboarding_id=v_onboarding2 and excluded_at is not null and excluded_by=v_admin
      and state='needs_review' and next_attempt_at='infinity'::timestamptz)
    or public.get_whatsapp_template_preparation(v_unit,v_channel2)->>'enrollment'<>'excluded' then
    raise exception 'template_auto_stop_before_binding_not_durable';
  end if;
  if public.release_whatsapp_template_channel(v_channel2,'catalog',false,0,null) is distinct from true then
    raise exception 'template_auto_stop_before_binding_not_idempotent';
  end if;
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_account,v_org,'730000000001',clock_timestamp());
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_other_account,v_other_org,'739900000001',clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel2,v_account,'datafy',clock_timestamp()) returning id into v_binding2;
  v_denied:=null;
  begin
    insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
      values(v_unit,v_channel,v_other_account,'datafy',clock_timestamp());
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '23514' then
    raise exception 'template_auto_foreign_waba_binding_accepted: %',v_denied;
  end if;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp()) returning id into v_binding;
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_other_channel,v_other_unit,'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7399"}'::jsonb,'local-only');
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_other_unit,v_other_channel,v_other_account,'datafy',clock_timestamp()) returning id into v_other_binding;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,1) then
    raise exception 'template_auto_bad_revision_allowed';
  end if;
  if public.authorize_whatsapp_template_auto_channel(v_old_onboarding,v_binding,1,0) then
    raise exception 'template_auto_old_onboarding_allowed';
  end if;
  if public.authorize_whatsapp_template_auto_channel(v_onboarding2,v_binding2,1,0) then
    raise exception 'template_auto_stopped_prebinding_channel_authorized';
  end if;
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_other_binding,1,0) then
    raise exception 'template_auto_cross_tenant_waba_authorized';
  end if;
  update app_private.whatsapp_template_auto_enrollments set state='needs_review',reason_code='manual_review'
    where onboarding_id=v_onboarding;
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0) then
    raise exception 'template_auto_manual_review_authorized';
  end if;
  update app_private.whatsapp_template_auto_enrollments set state='pending',reason_code=null
    where onboarding_id=v_onboarding;
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0) is distinct from true then
    raise exception 'template_auto_valid_grant_failed';
  end if;
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0) is distinct from true then
    raise exception 'template_auto_idempotent_grant_failed';
  end if;
  select count(*) into v_count from app_private.whatsapp_template_submission_grants
    where binding_id=v_binding and origin='auto' and policy_revision=1 and actor_id=v_admin and revoked_at is null;
  if v_count<>1 or (select count(*) from app_private.whatsapp_template_auto_permits)<>0
    or (select dispatch_enabled or adopted_at is not null from public.whatsapp_template_bindings where id=v_binding) then
    raise exception 'template_auto_grant_duplicate_permit_or_dispatch';
  end if;
  if public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'ready',null) is distinct from true
    or public.get_whatsapp_template_preparation(v_unit,v_channel)->>'state'<>'ready' then
    raise exception 'template_auto_ready_not_persisted';
  end if;
  if public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'pending','provider_unavailable') then
    raise exception 'template_auto_ready_regressed_to_pending';
  end if;
  -- Ready inactive channels still receive a bounded health heartbeat without regranting.
  update public.whatsapp_channels set is_active=false,
    last_health_check_at=clock_timestamp()-interval '4 minutes' where id=v_channel;
  update app_private.whatsapp_template_auto_enrollments set next_attempt_at=clock_timestamp()-interval '1 second'
    where onboarding_id=v_onboarding;
  select due.channel_id into v_claimed_channel from public.claim_due_whatsapp_template_preparations(1) due;
  if v_claimed_channel is distinct from v_channel or not exists(
    select from app_private.whatsapp_template_auto_enrollments
    where onboarding_id=v_onboarding and state='ready' and attempt_count=0
      and next_attempt_at>clock_timestamp()) then
    raise exception 'template_auto_ready_health_heartbeat_missing';
  end if;
  if (select count(*) from public.claim_due_whatsapp_template_preparations(1))<>0 then
    raise exception 'template_auto_ready_health_lease_missing';
  end if;
  update public.whatsapp_channels set status='provider_error',last_health_check_at=clock_timestamp()
    where id=v_channel;
  if public.get_whatsapp_template_preparation(v_unit,v_channel)->>'state'<>'ready' then
    raise exception 'template_auto_transient_health_misclassified_as_stale_pin';
  end if;
  update app_private.whatsapp_template_auto_enrollments set next_attempt_at=clock_timestamp()-interval '1 second'
    where onboarding_id=v_onboarding;
  select due.channel_id into v_claimed_channel from public.claim_due_whatsapp_template_preparations(1) due;
  if v_claimed_channel is distinct from v_channel then
    raise exception 'template_auto_provider_error_retry_missing';
  end if;
  v_mark:=public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'ready','provider_unavailable');
  if v_mark is distinct from true
    or not exists(select from app_private.whatsapp_template_auto_enrollments
      where onboarding_id=v_onboarding and state='ready' and reason_code='provider_unavailable'
        and next_attempt_at between clock_timestamp()+interval '110 seconds' and clock_timestamp()+interval '125 seconds')
    or (select count(*) from app_private.whatsapp_template_submission_grants
      where binding_id=v_binding and revoked_at is null)<>1 then
    raise exception 'template_auto_ready_health_failure_not_bounded';
  end if;
  update public.whatsapp_channels set status='connected',is_active=true,
    last_health_check_at=clock_timestamp() where id=v_channel;
  if public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'ready',null) is distinct from true then
    raise exception 'template_auto_ready_health_recovery_failed';
  end if;
  -- A credential revision change must never silently reuse the old auto grant.
  begin
    update public.whatsapp_channels set credentials='{"phone_number_id":"7309"}'::jsonb where id=v_channel;
    if public.get_whatsapp_template_preparation(v_unit,v_channel)->>'state'<>'needs_review' then
      raise exception 'template_auto_reconnect_reused_old_grant';
    end if;
    raise exception using errcode='PT777',message='rollback_local_reconnect';
  exception when sqlstate 'PT777' then null;
  end;

  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(v_remote,v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',v_desired,'UTILITY',1);
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),sync_binding_id=v_binding,
    sync_binding_generation=1,sync_credential_revision=0,last_sync_published_at=clock_timestamp() where id=v_account;
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp() where id=v_remote;
  insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,operation,target_key,
    state,attempts,claim_token,claimed_until)
    values(v_job,v_org,v_account,v_binding,1,'provision','res_confirmacao_v1',
      'claimed',0,v_fence,clock_timestamp()+interval '5 minutes');
  if not app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload)
    or app_private.whatsapp_template_submission_gate(v_job,v_fence,1,repeat('0',64)) then
    raise exception 'template_auto_digest_gate_wrong';
  end if;
  if public.prepare_whatsapp_template_provision(v_job,v_fence,1,v_payload) is distinct from true
    or public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload) is distinct from true
    or public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload) is distinct from false
    or public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload) is distinct from true
    or public.check_whatsapp_template_submission(v_job,v_fence,1,repeat('0',64)) is distinct from false then
    raise exception 'template_auto_one_use_post_confirmation_failed';
  end if;
  if (select count(*) from app_private.whatsapp_template_post_confirmations where job_id=v_job)<>1 then
    raise exception 'template_auto_confirmation_not_durable';
  end if;
  -- One verified organization WABA may back two separate eligible channels;
  -- grants remain channel-scoped and are never reused across bindings.
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding3,v_org,v_sibling_unit,v_channel3);
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel3,v_sibling_unit,'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7303"}'::jsonb,'local-only');
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7303',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding3;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_sibling_unit,v_channel3,v_account,'datafy',clock_timestamp()) returning id into v_binding3;
  update app_private.whatsapp_template_auto_enrollments set next_attempt_at='infinity'::timestamptz
    where onboarding_id=v_onboarding;
  select due.channel_id into v_claimed_channel from public.claim_due_whatsapp_template_preparations(1) due;
  v_mark:=public.authorize_whatsapp_template_auto_channel(v_onboarding3,v_binding3,1,0);
  if v_claimed_channel is distinct from v_channel3 or v_mark is distinct from true
    or (select count(*) from app_private.whatsapp_template_submission_grants
      where account_id=v_account and origin='auto' and revoked_at is null)<>2
    or (select count(distinct unit_id) from app_private.whatsapp_template_submission_grants
      where account_id=v_account and origin='auto' and revoked_at is null)<>2 then
    raise exception 'template_auto_shared_waba_channel_grants_not_isolated';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_state:=public.configure_whatsapp_template_auto_policy(false,1);
  if v_state->>'enabled'<>'false' or public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload)
    or app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload) then
    raise exception 'template_auto_policy_revoke_did_not_close';
  end if;
  v_state:=public.configure_whatsapp_template_auto_policy(true,2);
  if app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload)
    or public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0) then
    raise exception 'template_auto_reenable_replayed_old_revision';
  end if;
  -- Manual stop persists exclusion even after a policy toggle/reconnect.
  v_stop:=public.release_whatsapp_template_channel(v_channel,'catalog',false,0,1);
  if v_stop is distinct from true or not exists(select from app_private.whatsapp_template_auto_enrollments
      where onboarding_id=v_onboarding and excluded_at is not null and reason_code='manual_review') then
    raise exception 'template_auto_manual_stop_not_excluded stop=%, auth=%, enrollment=%',
      v_stop,(select submission_authorized_at is null from public.whatsapp_template_bindings where id=v_binding),
      (select jsonb_build_object('excluded',excluded_at is not null,'reason',reason_code)
        from app_private.whatsapp_template_auto_enrollments where onboarding_id=v_onboarding);
  end if;
  if public.release_whatsapp_template_channel(v_channel,'catalog',false,0,1) is distinct from true then
    raise exception 'template_auto_repeated_stop_failed';
  end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0)
    or public.get_whatsapp_template_preparation(v_unit,v_channel)->>'enrollment'<>'excluded' then
    raise exception 'template_auto_exclusion_reauthorized';
  end if;
  -- Disabling is the emergency stop even if the approved catalog has drifted.
  update app_private.whatsapp_template_approved_submissions set payload_hash=repeat('f',64)
    where logical_id='res_confirmacao_v1';
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_state:=public.configure_whatsapp_template_auto_policy(false,3);
  if v_state->>'enabled'<>'false' or (v_state->>'revision')::bigint<>4
    or v_state->>'catalog_digest' is distinct from 'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965'
    or not exists(select from app_private.whatsapp_template_auto_policy_audit where revision=4 and not enabled) then
    raise exception 'template_auto_off_blocked_by_catalog_drift';
  end if;
  v_denied:=null;
  begin perform public.configure_whatsapp_template_auto_policy(true,4);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from 'PT503' then raise exception 'template_auto_on_accepted_catalog_drift'; end if;
end $$;
select 'GREEN73 default OFF, future-only, review/exclusion, tenant/WABA, two units, heartbeat, one-use confirm, ACL' as evidence;
rollback;

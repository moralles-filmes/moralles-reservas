\set ON_ERROR_STOP on
-- Manual v2 selection for an existing v1 account. Entire fixture rolls back.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$
declare v_admin uuid:=gen_random_uuid(); v_admin2 uuid:=gen_random_uuid();
  v_member uuid:=gen_random_uuid(); v_org uuid:=gen_random_uuid();
  v_unit uuid:=gen_random_uuid(); v_unit2 uuid:=gen_random_uuid();
  v_onboarding uuid:=gen_random_uuid(); v_onboarding2 uuid:=gen_random_uuid();
  v_channel uuid:=gen_random_uuid(); v_channel2 uuid:=gen_random_uuid();
  v_account uuid:=gen_random_uuid(); v_binding uuid; v_binding2 uuid;
  v_v1_job uuid:=gen_random_uuid();
  v_job uuid; v_fence uuid; v_desired text; v_payload text; v_digest text;
  v_phone_id text; v_phone_id2 text; v_waba_id text;
  v_state jsonb; v_denied text; v_selected boolean; v_replayed boolean; v_unsafe_state text;
  v_claims integer; v_claimed uuid; v_recovered boolean;
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'template_v2_manual_quarantine_required'; end if;
  v_digest:=app_private.whatsapp_template_approved_catalog_digest(2);
  v_phone_id:='9'||floor(random()*1000000000000000)::bigint::text;
  v_phone_id2:='7'||floor(random()*1000000000000000)::bigint::text;
  v_waba_id:='8'||floor(random()*1000000000000000)::bigint::text;
  -- Keep this rollback fixture independent from a prior committed auto-policy race.
  update app_private.whatsapp_template_v2_policy
    set enabled=false,revision=0,catalog_digest=v_digest,actor_id=null,enabled_at=null
    where id=1;
  if (select enabled or revision<>0 from app_private.whatsapp_template_v2_policy where id=1)
    or v_digest is null then raise exception 'manual_fixture_requires_v2_off'; end if;
  if has_function_privilege('anon',
      'public.select_whatsapp_template_v2_existing_account(uuid,bigint,bigint,text)','EXECUTE')
    or has_function_privilege('service_role',
      'public.select_whatsapp_template_v2_existing_account(uuid,bigint,bigint,text)','EXECUTE')
    or not has_function_privilege('authenticated',
      'public.select_whatsapp_template_v2_existing_account(uuid,bigint,bigint,text)','EXECUTE')
    or has_table_privilege('authenticated','app_private.whatsapp_template_v2_grants','SELECT')
    or has_table_privilege('service_role','app_private.whatsapp_template_v2_grants','INSERT') then
    raise exception 'manual_acl_drift'; end if;
  insert into auth.users(id) values(v_admin),(v_member);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'V2 manual local');
  insert into public.units(id,organization_id,name) values(v_unit,v_org,'Existing v1 unit');
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding,v_org,v_unit,v_channel);
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel,v_unit,'datafy','connected',false,clock_timestamp(),
      jsonb_build_object('phone_number_id',v_phone_id),'local-only');
  update public.whatsapp_datafy_onboardings set state='completed',completed_at=clock_timestamp(),
    datafy_channel_id='local-manual' where id=v_onboarding;
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_account,v_org,v_waba_id,clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp()) returning id into v_binding;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1',
      'UTILITY',1);
  insert into public.whatsapp_template_jobs
    (id,organization_id,account_id,binding_id,binding_generation,operation,target_key,revision,state)
    values(v_v1_job,v_org,v_account,v_binding,1,'provision','res_confirmacao_v1',1,'done');

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_member::text,true);
  v_denied:=null;
  begin perform public.select_whatsapp_template_v2_existing_account(v_binding,1,0,v_digest);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception 'manual_member_selected_v2: %',v_denied; end if;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.select_whatsapp_template_v2_existing_account(v_binding,1,0,repeat('0',64))
    or public.select_whatsapp_template_v2_existing_account(v_binding,2,0,v_digest)
    or public.select_whatsapp_template_v2_existing_account(v_binding,1,1,v_digest) then
    raise exception 'manual_wrong_digest_or_pin_selected'; end if;
  foreach v_unsafe_state in array array['posting','uncertain'] loop
    begin
      insert into public.whatsapp_template_jobs
        (organization_id,account_id,binding_id,binding_generation,operation,target_key,
          revision,state,claim_token,claimed_until,posting_started_at,attempts,provider_outcome)
      values(v_org,v_account,v_binding,1,'provision','fila_entrada_v1',1,
        v_unsafe_state,gen_random_uuid(),clock_timestamp()+interval '5 minutes',
        clock_timestamp(),1,case when v_unsafe_state='uncertain' then 'uncertain' else null end);
      if public.select_whatsapp_template_v2_existing_account(v_binding,1,0,v_digest) then
        raise exception 'manual_selected_with_unresolved_v1_%',v_unsafe_state; end if;
      raise exception 'rollback_unsafe_probe' using errcode='PT777';
    exception when sqlstate 'PT777' then null; end;
  end loop;
  v_selected:=public.select_whatsapp_template_v2_existing_account(v_binding,1,0,v_digest);
  v_replayed:=public.select_whatsapp_template_v2_existing_account(v_binding,1,0,v_digest);
  if v_selected is distinct from true or v_replayed
    or (select enabled from app_private.whatsapp_template_v2_policy where id=1)
    or (select count(*) from app_private.whatsapp_template_account_cohorts
      where account_id=v_account and origin='manual' and policy_revision=0)<>1
    or (select count(*) from app_private.whatsapp_template_v2_grants
      where binding_id=v_binding and origin='manual' and revoked_at is null)<>1
    or (select count(*) from public.audit_log
      where table_name='whatsapp_template_bindings' and record_id=v_binding::text
        and new_values->>'scope'='catalog_v2' and new_values->>'enabled'='true')<>1 then
    raise exception 'manual_selection_or_audit_failed %',
      (select jsonb_build_object('selected',v_selected,'replayed',v_replayed,'cohorts',
        (select count(*) from app_private.whatsapp_template_account_cohorts where account_id=v_account),
        'grants',(select count(*) from app_private.whatsapp_template_v2_grants where binding_id=v_binding),
        'audit',(select count(*) from public.audit_log where record_id=v_binding::text),
        'audit_data',(select new_values from public.audit_log where record_id=v_binding::text limit 1),
        'policy',(select enabled from app_private.whatsapp_template_v2_policy where id=1))); end if;
  if (select count(*) from public.whatsapp_remote_templates
      where account_id=v_account and version=1)<>1
    or (select state from public.whatsapp_template_jobs where id=v_v1_job)<>'done' then
    raise exception 'manual_mutated_v1_history'; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if (select next_attempt_at not between clock_timestamp()+interval '2 minutes'
        and clock_timestamp()+interval '4 minutes'
      from app_private.whatsapp_template_v2_enrollments where onboarding_id=v_onboarding)
    or (select enabled from app_private.whatsapp_template_v2_policy where id=1) then
    raise exception 'manual_ready_heartbeat_not_scheduled_with_policy_off'; end if;
  update public.whatsapp_channels set last_health_check_at=clock_timestamp()-interval '6 minutes'
    where id=v_channel;
  update app_private.whatsapp_template_v2_enrollments
    set next_attempt_at=clock_timestamp()-interval '1 second' where onboarding_id=v_onboarding;
  select count(*),min(q.onboarding_id::text)::uuid into v_claims,v_claimed
    from public.claim_due_whatsapp_template_v2_preparations(1) q;
  if v_claims<>1 or v_claimed is distinct from v_onboarding
    or public.mark_whatsapp_template_v2_preparation(
      v_onboarding,v_channel,'ready','provider_unavailable') is distinct from true
    or (select state<>'ready' or reason_code<>'provider_unavailable'
      from app_private.whatsapp_template_v2_enrollments where onboarding_id=v_onboarding) then
    raise exception 'manual_inactive_heartbeat_failure_not_durable'; end if;
  if public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'pending',null)
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'discovering',null)
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null)
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready','policy_changed')
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'needs_review','policy_changed') then
    raise exception 'manual_heartbeat_escaped_into_discovery'; end if;
  begin
    update app_private.whatsapp_template_v2_enrollments
      set next_attempt_at=clock_timestamp()-interval '1 second' where onboarding_id=v_onboarding;
    update app_private.whatsapp_template_v2_grants set revoked_at=clock_timestamp()
      where binding_id=v_binding;
    if (select count(*) from public.claim_due_whatsapp_template_v2_preparations(1))<>0
      or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null) then
      raise exception 'manual_revoked_heartbeat_allowed'; end if;
    raise exception 'rollback_manual_revoke_probe' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  begin
    update app_private.whatsapp_template_v2_enrollments
      set next_attempt_at=clock_timestamp()-interval '1 second' where onboarding_id=v_onboarding;
    update public.whatsapp_template_bindings set generation=2 where id=v_binding;
    if (select count(*) from public.claim_due_whatsapp_template_v2_preparations(1))<>0
      or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null) then
      raise exception 'manual_drifted_heartbeat_allowed'; end if;
    raise exception 'rollback_manual_drift_probe' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  update public.whatsapp_channels set last_health_check_at=clock_timestamp()
    where id=v_channel;
  v_recovered:=public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null);
  if v_recovered is distinct from true
    or (select state<>'ready' or reason_code is not null or next_attempt_at='infinity'::timestamptz
      from app_private.whatsapp_template_v2_enrollments where onboarding_id=v_onboarding) then
    raise exception 'manual_inactive_heartbeat_recovery_failed: %',
      (select jsonb_build_object('mark',v_recovered,'state',state,'reason',reason_code,
        'next_attempt_at',next_attempt_at,'generation',binding_generation)
      from app_private.whatsapp_template_v2_enrollments where onboarding_id=v_onboarding); end if;
  begin
    if public.mark_whatsapp_template_v2_preparation(
        v_onboarding,v_channel,'needs_review','manual_review') is distinct from true
      or public.mark_whatsapp_template_v2_preparation(
        v_onboarding,v_channel,'ready',null) then
      raise exception 'manual_review_state_not_terminal'; end if;
    raise exception 'rollback_manual_review_probe' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;

  -- One WABA can serve two units. The second platform admin owns only the
  -- second grant; the cohort actor remains the first admin.
  insert into auth.users(id) values(v_admin2);
  insert into public.platform_admins(user_id) values(v_admin2);
  insert into public.units(id,organization_id,name) values(v_unit2,v_org,'Shared WABA unit');
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding2,v_org,v_unit2,v_channel2);
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel2,v_unit2,'datafy','connected',false,clock_timestamp(),
      jsonb_build_object('phone_number_id',v_phone_id2),'local-only');
  update public.whatsapp_datafy_onboardings set state='completed',completed_at=clock_timestamp(),
    datafy_channel_id='local-manual-shared' where id=v_onboarding2;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit2,v_channel2,v_account,'datafy',clock_timestamp()) returning id into v_binding2;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin2::text,true);
  if public.select_whatsapp_template_v2_existing_account(v_binding2,1,0,v_digest)
      is distinct from true then raise exception 'manual_second_admin_selection_failed'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if (select actor_id is distinct from v_admin
      from app_private.whatsapp_template_account_cohorts where account_id=v_account)
    or (select actor_id is distinct from v_admin2
      from app_private.whatsapp_template_v2_grants where binding_id=v_binding2)
    or (select count(*) from app_private.whatsapp_template_v2_grants
      where account_id=v_account and revoked_at is null)<>2
    or (select count(*) from public.whatsapp_template_jobs
      where account_id=v_account and revision=2)<>0
    or (select sync_capture_id is not null from public.whatsapp_template_accounts
      where id=v_account) then raise exception 'manual_shared_waba_implicit_work'; end if;
  update public.whatsapp_channels set last_health_check_at=clock_timestamp()-interval '6 minutes'
    where id=v_channel2;
  update app_private.whatsapp_template_v2_enrollments
    set next_attempt_at=clock_timestamp()-interval '1 second' where onboarding_id=v_onboarding2;
  select count(*),min(q.onboarding_id::text)::uuid into v_claims,v_claimed
    from public.claim_due_whatsapp_template_v2_preparations(1) q;
  if v_claims<>1 or v_claimed is distinct from v_onboarding2
    or public.mark_whatsapp_template_v2_preparation(
      v_onboarding2,v_channel2,'ready','provider_unavailable') is distinct from true then
    raise exception 'manual_shared_waba_second_heartbeat_failed'; end if;
  update public.whatsapp_channels set last_health_check_at=clock_timestamp()
    where id=v_channel2;
  if public.mark_whatsapp_template_v2_preparation(
      v_onboarding2,v_channel2,'ready',null) is distinct from true
    or (select count(*) from public.whatsapp_template_jobs
      where account_id=v_account and revision=2)<>0 then
    raise exception 'manual_shared_waba_recovery_or_implicit_sync'; end if;
  begin
    update app_private.whatsapp_template_v2_policy
      set enabled=true,revision=1,actor_id=v_admin,enabled_at=clock_timestamp()
      where id=1;
    update app_private.whatsapp_template_account_cohorts
      set origin='auto',policy_revision=1 where account_id=v_account;
    update app_private.whatsapp_template_v2_enrollments
      set origin='auto',policy_revision=1,next_attempt_at=clock_timestamp()-interval '1 second'
      where onboarding_id=v_onboarding2;
    update app_private.whatsapp_template_v2_grants
      set origin='auto',policy_revision=1 where binding_id=v_binding2;
    update public.whatsapp_channels set last_health_check_at=clock_timestamp()-interval '6 minutes'
      where id=v_channel2;
    if (select count(*) from public.claim_due_whatsapp_template_v2_preparations(20) q
        where q.onboarding_id=v_onboarding2)<>0
      or public.mark_whatsapp_template_v2_preparation(
        v_onboarding2,v_channel2,'ready','provider_unavailable') then
      raise exception 'auto_divergent_policy_actor_allowed'; end if;
    raise exception 'rollback_auto_actor_probe' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  v_state:=public.get_whatsapp_template_catalog_selection(v_binding);
  if v_state->>'state'<>'ready' or (v_state->>'version')::integer<>2
    or public.get_whatsapp_template_v2_preparation(v_unit,v_channel)->>'origin'<>'manual'
    or public.get_whatsapp_template_v2_preparation(v_unit,v_channel)->>'state'<>'ready'
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'pending',null) then
    raise exception 'manual_selection_not_service_ready'; end if;
  select desired_hash,payload_hash into v_desired,v_payload
    from app_private.whatsapp_template_approved_submissions
    where logical_id='res_confirmacao_v2' and version=2;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation,
      sync_required,last_synced_at)
    values(v_account,'res_confirmacao_v2',2,'pt_BR','res_confirmacao_v2',v_desired,'UTILITY',1,
      false,clock_timestamp());
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),
    sync_binding_id=v_binding,sync_binding_generation=1,sync_credential_revision=0,
    last_sync_published_at=clock_timestamp() where id=v_account;
  v_job:=public.enqueue_whatsapp_template_job(v_binding,'provision','res_confirmacao_v2',2,2);
  if v_job is null then raise exception 'manual_v2_enqueue_failed'; end if;
  v_state:=public.claim_whatsapp_template_job(v_job);
  v_fence:=(v_state->>'claim_token')::uuid;
  if v_fence is null or not app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload,2)
    or public.prepare_whatsapp_template_provision(v_job,v_fence,1,v_payload,2) is distinct from true
    or public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload,2) is distinct from true
    or public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload,2) is distinct from true then
    raise exception 'manual_v2_post_fence_failed'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.release_whatsapp_template_v2_channel(v_binding,1,0) is distinct from true then
    raise exception 'manual_stop_failed'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload,2)
    or public.get_whatsapp_template_catalog_selection(v_binding)->>'state'<>'paused'
    or public.get_whatsapp_template_catalog_selection(v_binding2)->>'state'<>'ready'
    or (select count(*) from app_private.whatsapp_template_v2_grants
      where binding_id=v_binding and revoked_at is null)<>0
    or (select count(*) from public.whatsapp_remote_templates
      where account_id=v_account and version=1)<>1
    or (select state from public.whatsapp_template_jobs where id=v_v1_job)<>'done' then
    raise exception 'manual_stop_or_v1_history_failed'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.select_whatsapp_template_v2_existing_account(v_binding,1,0,v_digest) then
    raise exception 'manual_stop_silently_regranted'; end if;
  raise notice 'GREEN74C manual policy-independent, two admins/shared WABA heartbeat, auto actor fence, inactive recovery, revoked/drift fences, v1 history, real enqueue/post fence, stop';
end $$;
rollback;

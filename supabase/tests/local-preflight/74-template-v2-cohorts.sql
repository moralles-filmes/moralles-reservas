\set ON_ERROR_STOP on
-- Apply the real 20261019133502 migration after bootstrap 73, on a disposable
-- PostgreSQL 17 container with --network none and no published ports.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
declare
  v_org uuid:=gen_random_uuid(); v_other_org uuid:=gen_random_uuid();
  v_unit uuid:=gen_random_uuid(); v_sibling uuid:=gen_random_uuid(); v_other_unit uuid:=gen_random_uuid();
  v_admin uuid:=gen_random_uuid(); v_owner uuid:=gen_random_uuid();
  v_gerente uuid:=gen_random_uuid(); v_operator uuid:=gen_random_uuid();
  v_old_onboarding uuid:=gen_random_uuid(); v_onboarding uuid:=gen_random_uuid();
  v_onboarding2 uuid:=gen_random_uuid(); v_other_onboarding uuid:=gen_random_uuid();
  v_old_channel uuid:=gen_random_uuid(); v_channel uuid:=gen_random_uuid();
  v_channel2 uuid:=gen_random_uuid(); v_other_channel uuid:=gen_random_uuid();
  v_old_account uuid:=gen_random_uuid(); v_account uuid:=gen_random_uuid();
  v_other_account uuid:=gen_random_uuid(); v_old_binding uuid; v_binding uuid;
  v_binding2 uuid; v_other_binding uuid; v_remote uuid:=gen_random_uuid();
  v_job uuid:=gen_random_uuid(); v_bad_job uuid:=gen_random_uuid(); v_fence uuid:=gen_random_uuid();
  v_v1_digest text:='a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965';
  v_v2_digest text:='74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55';
  v_payload text:='d8dd3a0de8cf5c1994f801a621a2927cdbe0e95a8b683bc84a3a1edbfbd961b2';
  v_desired text:='2c6c958fea3540a686082cfcfcdb97c07d50f14eda492110998326582681a8cf';
  v_denied text; v_state jsonb;
begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'template_v2_local_quarantine_required';
  end if;
  if app_private.whatsapp_template_approved_catalog_digest() is distinct from v_v1_digest
    or app_private.whatsapp_template_approved_catalog_digest(1) is distinct from v_v1_digest
    or app_private.whatsapp_template_approved_catalog_digest(2) is distinct from v_v2_digest
    or (select count(*) from app_private.whatsapp_template_approved_submissions where version=1)<>9
    or (select count(*) from app_private.whatsapp_template_approved_submissions where version=2)<>9
    or (select enabled or revision<>0 from app_private.whatsapp_template_v2_policy where id=1) then
    raise exception 'template_v2_catalog_or_default_policy_drift';
  end if;
  begin
    delete from app_private.whatsapp_template_approved_submissions where logical_id='res_cancelada_v1';
    if app_private.whatsapp_template_approved_catalog_digest() is not null then
      raise exception 'v1_incomplete_catalog_open'; end if;
    raise exception 'rollback_v1_digest_control' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  begin
    delete from app_private.whatsapp_template_approved_submissions where logical_id='res_cancelada_v2';
    if app_private.whatsapp_template_approved_catalog_digest(2) is not null then
      raise exception 'v2_incomplete_catalog_open'; end if;
    raise exception 'rollback_v2_digest_control' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  if exists(select from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='app_private' and c.relname in(
      'whatsapp_template_v2_policy','whatsapp_template_v2_policy_audit',
      'whatsapp_template_v2_enrollments','whatsapp_template_account_cohorts',
      'whatsapp_template_v2_grants') and (not c.relrowsecurity or not c.relforcerowsecurity))
    or has_table_privilege('anon','app_private.whatsapp_template_v2_grants','SELECT')
    or has_table_privilege('authenticated','app_private.whatsapp_template_account_cohorts','SELECT')
    or has_table_privilege('service_role','app_private.whatsapp_template_v2_policy','UPDATE')
    or has_function_privilege('anon','public.get_whatsapp_template_v2_policy()','EXECUTE')
    or has_function_privilege('service_role','public.configure_whatsapp_template_v2_policy(boolean,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.authorize_whatsapp_template_v2_channel(uuid,uuid,bigint,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.get_whatsapp_template_v2_preparation(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.claim_due_whatsapp_template_v2_preparations(integer)','EXECUTE')
    or has_function_privilege('authenticated','public.mark_whatsapp_template_v2_preparation(uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.enqueue_whatsapp_template_job(uuid,text,text,bigint,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.get_whatsapp_template_v2_preparation(uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_due_whatsapp_template_v2_preparations(integer)','EXECUTE')
    or not has_function_privilege('service_role','public.mark_whatsapp_template_v2_preparation(uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.enqueue_whatsapp_template_job(uuid,text,text,bigint,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.prepare_whatsapp_template_provision(uuid,uuid,bigint,text,integer)','EXECUTE')
    or not has_function_privilege('authenticated','public.configure_whatsapp_template_v2_policy(boolean,bigint)','EXECUTE') then
    raise exception 'template_v2_acl_or_rls_drift';
  end if;

  insert into auth.users(id) values(v_admin),(v_owner),(v_gerente),(v_operator);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'V2 local'),(v_other_org,'Other V2 local');
  insert into public.units(id,organization_id,name)
    values(v_unit,v_org,'V2 local'),(v_sibling,v_org,'V2 sibling'),(v_other_unit,v_other_org,'Other local');
  insert into public.unit_members(user_id,unit_id,role)
    values(v_owner,v_unit,'owner'),(v_gerente,v_unit,'gerente'),(v_operator,v_unit,'operador');
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_denied:=null;
  begin perform public.configure_whatsapp_template_v2_policy(true,0);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception 'v2_service_spoofed_admin'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  foreach v_denied in array array[v_owner::text,v_gerente::text,v_operator::text] loop
    perform set_config('request.jwt.claim.sub',v_denied,true);
    begin perform public.configure_whatsapp_template_v2_policy(true,0);
      raise exception 'v2_member_set_global_policy';
    exception when insufficient_privilege then null; end;
  end loop;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.get_whatsapp_template_v2_policy()->>'enabled'<>'false' then
    raise exception 'v2_policy_default_not_off'; end if;
  v_state:=public.configure_whatsapp_template_auto_policy(true,0);
  if v_state->>'enabled'<>'true' then raise exception 'v1_policy_enable_failed'; end if;
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_old_onboarding,v_org,v_unit,v_old_channel);
  if not exists(select from app_private.whatsapp_template_auto_enrollments
      where onboarding_id=v_old_onboarding)
    or exists(select from app_private.whatsapp_template_v2_enrollments
      where onboarding_id=v_old_onboarding) then raise exception 'v1_onboarding_changed_before_v2'; end if;
  update public.whatsapp_datafy_onboardings set state='abandoned',abandoned_at=clock_timestamp()
    where id=v_old_onboarding;
  v_state:=public.configure_whatsapp_template_v2_policy(true,0);
  if (v_state->>'version')::integer<>2 or (v_state->>'revision')::bigint<>1
    or v_state->>'catalog_digest'<>v_v2_digest then raise exception 'v2_policy_enable_failed'; end if;
  v_denied:=null;
  begin perform public.configure_whatsapp_template_v2_policy(false,0);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from 'PT409' then raise exception 'v2_policy_cas_replay'; end if;
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding,v_org,v_unit,v_channel),
      (v_onboarding2,v_org,v_sibling,v_channel2),
      (v_other_onboarding,v_other_org,v_other_unit,v_other_channel);
  if (select count(*) from app_private.whatsapp_template_v2_enrollments
      where onboarding_id in(v_onboarding,v_onboarding2,v_other_onboarding))<>3
    or exists(select from app_private.whatsapp_template_auto_enrollments
      where onboarding_id in(v_onboarding,v_onboarding2,v_other_onboarding)) then
    raise exception 'v1_v2_enrollment_overlap'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_state:=public.get_whatsapp_template_v2_enrollment(v_unit,v_channel);
  if v_state->>'state'<>'pending' or (v_state->>'version')::integer<>2
    or public.get_whatsapp_template_v2_enrollment(v_other_unit,v_channel) is not null then
    raise exception 'v2_enrollment_tenant_or_version'; end if;

  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),' {"phone_number_id":"7401"}'::jsonb,'local-only'),
      (v_channel2,v_sibling,'datafy','connected',false,clock_timestamp(),' {"phone_number_id":"7402"}'::jsonb,'local-only'),
      (v_other_channel,v_other_unit,'datafy','connected',false,clock_timestamp(),' {"phone_number_id":"7499"}'::jsonb,'local-only'),
      (v_old_channel,v_unit,'datafy','connected',false,clock_timestamp(),' {"phone_number_id":"7400"}'::jsonb,'local-only');
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7401',state='completed',
    completed_at=clock_timestamp() where id=v_onboarding;
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7402',state='completed',
    completed_at=clock_timestamp() where id=v_onboarding2;
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7499',state='completed',
    completed_at=clock_timestamp() where id=v_other_onboarding;
  if (select count(*) from public.claim_due_whatsapp_template_v2_preparations(3))<>3
    or public.get_whatsapp_template_v2_preparation(v_unit,v_channel)->>'state'<>'discovering'
    or public.get_whatsapp_template_v2_preparation(v_other_unit,v_channel) is not null then
    raise exception 'v2_claim_or_read_failed'; end if;
  if public.mark_whatsapp_template_v2_preparation(
      v_other_onboarding,v_other_channel,'pending','binding_pending') is distinct from true
    or public.get_whatsapp_template_v2_preparation(v_other_unit,v_other_channel)->>'state'<>'pending'
    or (select next_attempt_at<=clock_timestamp()
      from app_private.whatsapp_template_v2_enrollments
      where onboarding_id=v_other_onboarding)
    or public.record_whatsapp_template_heartbeat(v_other_unit,v_other_channel,1,'7499')
    or public.record_whatsapp_template_heartbeat(v_other_unit,v_other_channel,0,'7499') is distinct from true then
    raise exception 'v2_bindingless_retry_or_heartbeat_failed'; end if;
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at,created_at)
    values(v_old_account,v_org,'7400000000000',clock_timestamp(),
      (select enabled_at-interval '1 minute' from app_private.whatsapp_template_v2_policy where id=1)),
      (v_account,v_org,'7400000000001',clock_timestamp(),clock_timestamp()),
      (v_other_account,v_other_org,'7499000000001',clock_timestamp(),clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_old_channel,v_old_account,'datafy',clock_timestamp()) returning id into v_old_binding;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp()) returning id into v_binding;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_sibling,v_channel2,v_account,'datafy',clock_timestamp()) returning id into v_binding2;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_other_unit,v_other_channel,v_other_account,'datafy',clock_timestamp()) returning id into v_other_binding;

  v_denied:=null;
  begin
    insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,
      desired_hash,requested_category,binding_generation)
    values(v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1','UTILITY',1);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '23514' then raise exception 'v1_seed_entered_pending_v2_account: %',v_denied; end if;

  if public.authorize_whatsapp_template_v2_channel(v_old_onboarding,v_old_binding,1,0)
    or public.authorize_whatsapp_template_v2_channel(v_onboarding,v_other_binding,1,0)
    or public.authorize_whatsapp_template_v2_channel(v_onboarding,v_binding,1,1) then
    raise exception 'v2_old_cross_tenant_or_rotation_authorized'; end if;
  if public.get_whatsapp_template_catalog_selection(v_binding)->>'state'<>'pending' then
    raise exception 'v2_unselected_account_not_pending'; end if;
  if public.authorize_whatsapp_template_v2_channel(v_onboarding,v_binding,1,0) is distinct from true
    or public.authorize_whatsapp_template_v2_channel(v_onboarding2,v_binding2,1,0) is distinct from true
    or public.authorize_whatsapp_template_v2_channel(v_onboarding,v_binding,1,0) is distinct from true then
    raise exception 'v2_shared_waba_grant_or_replay_failed'; end if;
  if public.mark_whatsapp_template_v2_preparation(v_onboarding,v_other_channel,'ready',null)
    or public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null) is distinct from true
    or public.mark_whatsapp_template_v2_preparation(v_onboarding2,v_channel2,'ready',null) is distinct from true
    or public.get_whatsapp_template_v2_preparation(v_unit,v_channel)->>'state'<>'ready' then
    raise exception 'v2_mark_ready_or_tenant_failed'; end if;
  if (select count(*) from app_private.whatsapp_template_account_cohorts where account_id=v_account)<>1
    or (select count(*) from app_private.whatsapp_template_v2_grants where account_id=v_account and revoked_at is null)<>2
    or public.get_whatsapp_template_catalog_selection(v_binding)->>'state'<>'ready'
    or (public.get_whatsapp_template_catalog_selection(v_binding2)->>'version')::integer<>2
    or (public.get_whatsapp_template_catalog_selection(v_old_binding)->>'version')::integer<>1 then
    raise exception 'v2_selection_or_shared_waba_wrong'; end if;
  v_denied:=null;
  begin
    insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,
      desired_hash,requested_category,binding_generation)
    values(v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1','UTILITY',1);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '23514' then raise exception 'v1_seed_entered_selected_v2_account: %',v_denied; end if;

  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,
    desired_hash,requested_category,binding_generation)
    values(v_remote,v_account,'res_confirmacao_v2',2,'pt_BR','res_confirmacao_v2',v_desired,'UTILITY',1);
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),sync_binding_id=v_binding,
    sync_binding_generation=1,sync_credential_revision=0,last_sync_published_at=clock_timestamp()
    where id=v_account;
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp()
    where id=v_remote;
  v_denied:=null;
  begin perform public.enqueue_whatsapp_template_job(v_binding,'provision','res_confirmacao_v2',2);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from 'P0A03' then raise exception 'v1_enqueue_admitted_v2: %',v_denied; end if;
  v_denied:=null;
  begin perform public.enqueue_whatsapp_template_job(v_binding,'provision','res_confirmacao_v2',1,2);
  exception when others then get stacked diagnostics v_denied=returned_sqlstate; end;
  if v_denied is distinct from '22023' then raise exception 'v2_enqueue_wrong_revision: %',v_denied; end if;
  v_job:=public.enqueue_whatsapp_template_job(v_binding,'provision','res_confirmacao_v2',2,2);
  if v_job is null or public.enqueue_whatsapp_template_job(
      v_binding,'provision','res_confirmacao_v2',2,2) is distinct from v_job then
    raise exception 'v2_real_enqueue_or_replay_failed'; end if;
  v_state:=public.claim_whatsapp_template_job(v_job);
  v_fence:=(v_state->>'claim_token')::uuid;
  if v_state->>'state'<>'claimed' or v_fence is null then
    raise exception 'v2_real_claim_failed'; end if;
  insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,
    operation,target_key,revision,state,attempts,claim_token,claimed_until)
    values(v_bad_job,v_org,v_account,v_binding,1,'provision','res_confirmacao_v2',1,'claimed',0,
      v_fence,clock_timestamp()+interval '5 minutes');
  if app_private.whatsapp_template_submission_gate(v_bad_job,v_fence,1,v_payload,2)
    or public.prepare_whatsapp_template_provision(v_bad_job,v_fence,1,v_payload,2)
    or public.confirm_whatsapp_template_post(v_bad_job,v_fence,1,v_payload,2)
    or public.check_whatsapp_template_submission(v_bad_job,v_fence,1,v_payload,2) then
    raise exception 'v2_job_revision_one_authorized'; end if;
  if app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload)
    or app_private.whatsapp_template_submission_gate(v_job,v_fence,1,repeat('0',64),2)
    or public.prepare_whatsapp_template_provision(v_job,v_fence,1,repeat('0',64),2) then
    raise exception 'v1_or_changed_v2_payload_authorized'; end if;
  -- The v1 bundle may classify an unknown v2 job as needs_review. Roll that
  -- deliberately denied attempt back before proving the v2 happy path.
  begin
    if public.prepare_whatsapp_template_provision(v_job,v_fence,1,v_payload) then
      raise exception 'v1_worker_posted_v2_job';
    end if;
    raise exception 'rollback_v1_probe' using errcode='PT777';
  exception when sqlstate 'PT777' then null; end;
  if not app_private.whatsapp_template_submission_gate(v_job,v_fence,1,v_payload,2) then
    raise exception 'v2_gate_failed'; end if;
  if public.prepare_whatsapp_template_provision(v_job,v_fence,1,v_payload,1) then
    raise exception 'v2_wrong_version_prepared'; end if;
  if public.prepare_whatsapp_template_provision(v_job,v_fence,1,v_payload,2) is distinct from true then
    raise exception 'v2_prepare_fence_failed: %', (select jsonb_build_object(
      'job_state',j.state,'attempts',j.attempts,'posted',j.posting_started_at,
      'sync_capture',a.sync_capture_id,'sync_published',a.last_sync_published_at,
      'remote_status',t.remote_status,'remote_sync',t.sync_required,'remote_last',t.last_synced_at,
      'remote_attempt',t.submission_attempted_at)
      from public.whatsapp_template_jobs j join public.whatsapp_template_accounts a on a.id=j.account_id
      join public.whatsapp_remote_templates t on t.account_id=a.id and t.logical_id=j.target_key
      where j.id=v_job); end if;
  if public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload,1)
    or public.confirm_whatsapp_template_post(v_job,v_fence,1,repeat('0',64),2)
    or public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload,2) is distinct from true
    or public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload,2) is distinct from true
    or public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload,1) then
    raise exception 'v2_confirmation_or_version_fence_failed'; end if;
  if public.confirm_whatsapp_template_post(v_job,v_fence,1,v_payload,2)
    or (select catalog_version from app_private.whatsapp_template_post_confirmations where job_id=v_job)<>2 then
    raise exception 'v2_post_replayed'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.release_whatsapp_template_v2_channel(v_binding,1,0) is distinct from true then
    raise exception 'v2_release_failed'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.check_whatsapp_template_submission(v_job,v_fence,1,v_payload,2)
    or public.get_whatsapp_template_catalog_selection(v_binding)->>'state'<>'paused' then
    raise exception 'v2_revoked_grant_still_postable'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_state:=public.configure_whatsapp_template_v2_policy(false,1);
  if v_state->>'enabled'<>'false'
    or exists(select from app_private.whatsapp_template_v2_grants where revoked_at is null)
    or app_private.whatsapp_template_approved_catalog_digest() is distinct from v_v1_digest then
    raise exception 'v2_logical_rollback_damaged_v1_or_left_grants'; end if;
end $$;

select 'GREEN74 digest v1/v2, OFF, exclusive enrollment, tenant/roles, WABA, payload/version fences, one-use, stop, ACL' as evidence;
rollback;

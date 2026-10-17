\set ON_ERROR_STOP on
-- Run only on the isolated local harness after migration 20261017200000.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  v_org uuid := gen_random_uuid();
  v_foreign_org uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_foreign_unit uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_channel uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_foreign_account uuid := gen_random_uuid();
  v_binding uuid;
  v_remote uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_claim uuid := gen_random_uuid();
  v_payload text := '4ab2cdd4711c9b95b122a23a773088bfa8b6d3d15a6eac04cb234d4f8d0ac114';
  v_desired text := 'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1';
  v_count integer;
  v_denied text;
begin
  if current_database() <> 'postgres' or current_setting('server_version_num')::integer < 170000
    or exists(select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'template_pilot_local_quarantine_required';
  end if;
  if app_private.whatsapp_template_approved_catalog_digest() is distinct from
    'a0fb939e3b2023c8f7c49a7f6fe77049fb312f6d274cf67f23e15f3906298965' then
    raise exception 'template_pilot_catalog_drift';
  end if;
  if has_table_privilege('authenticated','app_private.whatsapp_template_submission_grants','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','app_private.whatsapp_template_submission_grants','SELECT,INSERT,UPDATE,DELETE')
    or has_function_privilege('authenticated','public.check_whatsapp_template_submission(uuid,uuid,bigint,text)','EXECUTE')
    or has_function_privilege('anon','public.check_whatsapp_template_submission(uuid,uuid,bigint,text)','EXECUTE') then
    raise exception 'template_pilot_acl_open';
  end if;

  insert into auth.users(id) values(v_admin),(v_owner);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'Template pilot synthetic'),(v_foreign_org,'Template pilot foreign');
  insert into public.units(id,organization_id,name) values(v_unit,v_org,'Template pilot synthetic'),
    (v_foreign_unit,v_foreign_org,'Template pilot foreign');
  insert into public.unit_members(user_id,unit_id,role) values(v_owner,v_unit,'owner');
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),' {"phone_number_id":"7201"}'::jsonb,'synthetic-template-pilot');
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_account,v_org,'7200000000001',clock_timestamp());
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_foreign_account,v_foreign_org,'7200000000002',clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp()) returning id into v_binding;
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  begin
    perform public.release_whatsapp_template_channel(v_channel,'catalog',true,0,1);
  exception when others then
    get stacked diagnostics v_denied=returned_sqlstate;
  end;
  if v_denied is distinct from '42501' then raise exception 'owner_received_catalog_authority'; end if;

  -- A forged admin sub under service_role must not become an authenticated admin.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_denied := null;
  begin
    perform public.release_whatsapp_template_channel(v_channel,'catalog',true,0,1);
  exception when others then
    get stacked diagnostics v_denied=returned_sqlstate;
  end;
  if v_denied is distinct from '42501' then raise exception 'service_role_spoofed_admin'; end if;

  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_denied := null;
  begin
    update public.whatsapp_template_bindings set account_id=v_foreign_account where id=v_binding;
  exception when others then
    get stacked diagnostics v_denied=returned_sqlstate;
  end;
  if v_denied is distinct from '23514' then raise exception 'foreign_account_binding_allowed'; end if;
  if public.release_whatsapp_template_channel(v_channel,'catalog',true,0,1) is distinct from true then
    raise exception 'admin_catalog_grant_failed';
  end if;
  if public.release_whatsapp_template_channel(v_channel,'catalog',true,0,1) is distinct from true then
    raise exception 'idempotent_catalog_grant_failed';
  end if;
  select count(*) into v_count from app_private.whatsapp_template_submission_grants
    where binding_id=v_binding and revoked_at is null and catalog_digest=app_private.whatsapp_template_approved_catalog_digest()
      and actor_id=v_admin and origin='manual';
  if v_count <> 1 or (select count(*) from app_private.whatsapp_template_submission_grants where binding_id=v_binding) <> 1 then
    raise exception 'manual_grant_not_pinned_or_duplicate';
  end if;

  insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(v_remote,v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',v_desired,'UTILITY',1);
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),sync_binding_id=v_binding,
    sync_binding_generation=1,sync_credential_revision=0,last_sync_published_at=clock_timestamp() where id=v_account;
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp() where id=v_remote;
  insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,operation,target_key,
    state,attempts,claim_token,claimed_until)
    values(v_job,v_org,v_account,v_binding,1,'provision','res_confirmacao_v1',
      'claimed',0,v_claim,clock_timestamp()+interval '5 minutes');
  if not app_private.whatsapp_template_submission_gate(v_job,v_claim,1,v_payload) then
    raise exception 'approved_payload_gate_failed';
  end if;
  if app_private.whatsapp_template_submission_gate(v_job,v_claim,1,repeat('0',64)) then
    raise exception 'changed_examples_payload_allowed';
  end if;
  if public.prepare_whatsapp_template_provision(v_job,v_claim,1) then
    raise exception 'legacy_worker_allowed';
  end if;
  if public.prepare_whatsapp_template_provision(v_job,v_claim,1,repeat('0',64)) then
    raise exception 'changed_examples_prepared';
  end if;
  if public.prepare_whatsapp_template_provision(v_job,v_claim,1,v_payload) is distinct from true then
    raise exception 'approved_payload_prepare_failed';
  end if;
  if public.confirm_whatsapp_template_post(v_job,v_claim,1) then
    raise exception 'legacy_worker_confirmed';
  end if;
  if public.confirm_whatsapp_template_post(v_job,v_claim,1,repeat('0',64))
    or public.check_whatsapp_template_submission(v_job,v_claim,1,repeat('0',64)) then
    raise exception 'changed_examples_confirmed';
  end if;
  if public.confirm_whatsapp_template_post(v_job,v_claim,1,v_payload) is distinct from true
    or public.check_whatsapp_template_submission(v_job,v_claim,1,v_payload) is distinct from true then
    raise exception 'approved_payload_final_fence_failed';
  end if;

  if public.release_whatsapp_template_channel(v_channel,'catalog',false,0,1) is distinct from true then
    raise exception 'catalog_stop_failed';
  end if;
  if public.release_whatsapp_template_channel(v_channel,'catalog',false,0,1) is distinct from true then
    raise exception 'idempotent_catalog_stop_failed';
  end if;
  if app_private.whatsapp_template_submission_gate(v_job,v_claim,1,v_payload)
    or exists(select from app_private.whatsapp_template_submission_grants where binding_id=v_binding and revoked_at is null) then
    raise exception 'revoked_grant_still_authorizes';
  end if;
  if (select dispatch_enabled or adopted_at is not null from public.whatsapp_template_bindings where id=v_binding) then
    raise exception 'catalog_altered_dispatch';
  end if;
  if public.release_whatsapp_template_channel(v_channel,'catalog',true,0,1) is distinct from true then
    raise exception 'catalog_regrant_failed';
  end if;
  if (select count(*) from app_private.whatsapp_template_submission_grants where binding_id=v_binding) <> 2
    or (select count(*) from app_private.whatsapp_template_submission_grants where binding_id=v_binding and revoked_at is null) <> 1 then
    raise exception 'catalog_regrant_lost_history_or_duplicated';
  end if;
end $$;

select 'GREEN72 grant, tenant/spoof, payload fences, legacy stop, revoke/regrant, ACL' as evidence;
rollback;

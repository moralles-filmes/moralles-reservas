\set ON_ERROR_STOP on
-- Run only in the disposable, networkless PG17 bootstrap through 20261021190000.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';
-- The compact 25 fixture omits historical columns present in production.
alter table public.reservations add column if not exists created_at timestamptz not null default now();
alter table public.waitlist add column if not exists created_at timestamptz not null default now();
alter table public.waitlist add column if not exists notified_at timestamptz;
alter table public.whatsapp_channels add column if not exists manual_echo_verified_at timestamptz;
do $$
declare
  v_org uuid := gen_random_uuid(); v_other_org uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid(); v_other_unit uuid := gen_random_uuid();
  v_sibling_unit uuid := gen_random_uuid(); v_sibling_res uuid := gen_random_uuid();
  v_dual_unit uuid := gen_random_uuid(); v_dual_res uuid := gen_random_uuid();
  v_stale_unit uuid := gen_random_uuid(); v_stale_res uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid(); v_owner uuid := gen_random_uuid();
  v_operator uuid := gen_random_uuid(); v_outsider uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid(); v_old_res uuid := gen_random_uuid();
  v_new_res uuid := gen_random_uuid(); v_wait uuid := gen_random_uuid();
  v_onboarding uuid := gen_random_uuid();
  v_channel uuid := gen_random_uuid(); v_account uuid := gen_random_uuid();
  v_sibling_channel uuid := gen_random_uuid(); v_sibling_onboarding uuid := gen_random_uuid();
  v_dual_datafy uuid := gen_random_uuid(); v_dual_uazapi uuid := gen_random_uuid();
  v_dual_onboarding uuid := gen_random_uuid(); v_connection_grant uuid := gen_random_uuid();
  v_stale_channel uuid := gen_random_uuid(); v_current_channel uuid := gen_random_uuid();
  v_stale_onboarding uuid := gen_random_uuid(); v_current_onboarding uuid := gen_random_uuid();
  v_binding uuid; v_sibling_binding uuid; v_dual_binding uuid;
  v_dual_credrev bigint;
  v_snapshot jsonb; v_result jsonb; v_route jsonb;
  v_denied text; v_job uuid; v_at timestamptz; v_grant boolean; v_mark boolean;
  v_fence uuid; v_generation bigint; v_credrev bigint; v_epoch bigint; v_expected jsonb;
begin
  if current_database() <> 'postgres' or current_setting('server_version_num')::integer < 170000
    or exists(select 1 from cron.job where jobname in
      ('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select 1 from net.http_request_queue) then
    raise exception '78_not_quarantined';
  end if;
  if has_table_privilege('authenticated','app_private.whatsapp_v2_service_preferences','SELECT')
    or has_table_privilege('service_role','app_private.whatsapp_v2_service_binding_permits','INSERT')
    or has_function_privilege('anon','public.get_whatsapp_v2_service_preferences(uuid)','EXECUTE')
    or has_function_privilege('service_role',
      'public.set_whatsapp_v2_service_preference(uuid,text,boolean,bigint,bigint,bigint)','EXECUTE')
    or has_function_privilege('authenticated',
      'public.get_whatsapp_v2_service_route(text,uuid)','EXECUTE')
    or not has_function_privilege('authenticated',
      'public.get_whatsapp_v2_service_preferences(uuid)','EXECUTE') then
    raise exception '78_acl_open';
  end if;
  insert into auth.users(id) values(v_admin),(v_owner),(v_operator),(v_outsider);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'V2 service local'),
    (v_other_org,'V2 other local');
  insert into public.units(id,organization_id,name) values(v_unit,v_org,'Store'),
    (v_sibling_unit,v_org,'Sibling store'),(v_dual_unit,v_org,'Dual-channel store'),
    (v_stale_unit,v_org,'Stale-auto store'),(v_other_unit,v_other_org,'Other store');
  insert into public.unit_members(user_id,unit_id,role)
    values(v_owner,v_unit,'owner'),(v_operator,v_unit,'operador');
  insert into public.customers(id,organization_id,name,phone,do_not_contact)
    values(v_customer,v_org,'Synthetic','11999997778',false);
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
    party_size,reservation_code,created_at)
    values(v_old_res,v_unit,v_customer,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00',
      'confirmed','web',2,'V78-'||v_old_res,clock_timestamp()-interval '1 hour');
  -- This onboarding predates the v2 policy and must remain outside its auto
  -- cohort even when an unrelated old auto enrollment exists on the unit.
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id)
    values(v_current_onboarding,v_org,v_stale_unit,v_current_channel);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  update public.platform_flags set value='true'::jsonb
    where key in ('whatsapp_template_catalog','whatsapp_automation_dispatch');
  v_result := public.configure_whatsapp_template_v2_policy(true,0);
  if v_result->>'enabled' is distinct from 'true' then raise exception '78_policy'; end if;
  update public.whatsapp_datafy_onboardings set state='completed',
    datafy_channel_id='local-stale-current-78',completed_at=clock_timestamp()
    where id=v_current_onboarding;
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id)
    values(v_dual_onboarding,v_org,v_dual_unit,v_dual_datafy),
      (v_stale_onboarding,v_org,v_stale_unit,v_stale_channel);
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials)
    values(v_dual_uazapi,v_dual_unit,'uazapi','connected',true,clock_timestamp(),'{}'::jsonb),
      (v_dual_datafy,v_dual_unit,'datafy','connected',true,clock_timestamp(),'{}'::jsonb),
      (v_stale_channel,v_stale_unit,'datafy','disconnected',false,clock_timestamp(),'{}'::jsonb),
      (v_current_channel,v_stale_unit,'datafy','connected',true,clock_timestamp(),'{}'::jsonb);
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
    party_size,reservation_code,created_at)
    values(v_dual_res,v_dual_unit,v_customer,
        (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'18:00',
        'confirmed','web',2,'V78-'||v_dual_res,clock_timestamp()),
      (v_stale_res,v_stale_unit,v_customer,
        (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'18:30',
        'confirmed','web',2,'V78-'||v_stale_res,clock_timestamp());
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id,created_at)
    values(v_onboarding,v_org,v_unit,v_channel,clock_timestamp());
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
  if v_snapshot->>'eligible' <> 'false' or v_snapshot->>'rollout_ready' <> 'false'
    or jsonb_array_length(v_snapshot->'kinds') <> 6
    or exists(select 1 from jsonb_array_elements(v_snapshot->'kinds') x
      where x->>'enabled' <> 'false' or (x->>'revision')::integer <> 0) then
    raise exception '78_default_off: %',v_snapshot;
  end if;
  v_denied := null;
  begin perform public.get_whatsapp_v2_service_preferences(v_other_unit);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception '78_cross_tenant_read: %',v_denied; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_dual_res);
  if v_route->>'auto_cohort' <> 'false' or v_route->>'allowed' <> 'true' then
    raise exception '78_dual_active_uazapi_preserved: %',v_route; end if;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_stale_res);
  if v_route->>'auto_cohort' <> 'false' or v_route->>'allowed' <> 'true' then
    raise exception '78_stale_auto_does_not_spill: %',v_route; end if;
  update public.whatsapp_channels set is_active=false where id=v_dual_uazapi;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_dual_res);
  if v_route->>'auto_cohort' <> 'true' or v_route->>'allowed' <> 'false' then
    raise exception '78_auto_after_uazapi_cut: %',v_route; end if;
  insert into public.whatsapp_official_connection_grants
    (id,organization_id,unit_id,granted_by,replaces_channel_id)
    values(v_connection_grant,v_org,v_dual_unit,v_admin,v_dual_uazapi);
  update public.whatsapp_datafy_onboardings set grant_id=v_connection_grant
    where id=v_dual_onboarding;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_dual_res);
  if v_route->>'auto_cohort' <> 'false' or v_route->>'allowed' <> 'true' then
    raise exception '78_uazapi_migration_grant_excluded: %',v_route; end if;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
  if v_route->>'auto_cohort' <> 'false' or v_route->>'allowed' <> 'true' then
    raise exception '78_uazapi_migration_preserved: %',v_route; end if;
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,
      provider_subscribed_at,manual_echo_verified_at)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7801"}'::jsonb,clock_timestamp(),clock_timestamp());
  update public.whatsapp_datafy_onboardings set state='completed',
    datafy_channel_id='local-7801',completed_at=clock_timestamp()
    where id=v_onboarding;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
  if v_route->>'auto_cohort' <> 'true' or v_route->>'allowed' <> 'false'
    or v_route->>'reason_code' <> 'service_not_enabled' then
    raise exception '78_active_datafy_prebinding_default_off: %',v_route; end if;
  begin
    delete from app_private.whatsapp_template_v2_enrollments
      where onboarding_id=v_onboarding;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'auto_cohort' is distinct from 'true'
      or v_route->>'allowed' is distinct from 'false'
      or v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_active_datafy_pre_enrollment_default_off: %',v_route; end if;
    insert into public.whatsapp_template_accounts
      (id,organization_id,waba_id,verified_at,created_at)
      values(v_account,v_org,'7800000000001',clock_timestamp(),clock_timestamp());
    insert into public.whatsapp_template_bindings
      (unit_id,channel_id,account_id,provider,verified_at)
      values(v_unit,v_channel,v_account,'datafy',clock_timestamp())
      returning id into v_binding;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'auto_cohort' is distinct from 'true'
      or v_route->>'allowed' is distinct from 'false'
      or v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_binding_before_enrollment_default_off: %',v_route; end if;
    update app_private.whatsapp_template_v2_policy set enabled=false where id=1;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'auto_cohort' is distinct from 'true'
      or v_route->>'allowed' is distinct from 'false'
      or v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_pre_enrollment_policy_pause_still_off: %',v_route; end if;
    raise exception 'rollback temporary missing enrollment' using errcode='P0B00';
  exception when sqlstate 'P0B00' then null; end;
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at,created_at)
    values(v_account,v_org,'7800000000001',clock_timestamp(),clock_timestamp());
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp())
    returning id into v_binding;
  v_grant := public.authorize_whatsapp_template_v2_channel(v_onboarding,v_binding,1,0);
  v_mark := public.mark_whatsapp_template_v2_preparation(v_onboarding,v_channel,'ready',null);
  if v_grant is distinct from true or v_mark is distinct from true then
    raise exception '78_auto_grant: grant=%, mark=%',v_grant,v_mark; end if;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation,remote_id,observed_hash,effective_category,remote_status,
      local_status,sync_required,last_synced_at,quality)
    select v_account,a.logical_id,2,'pt_BR',a.logical_id,a.desired_hash,
      a.requested_category,1,'local-78-'||a.logical_id,a.desired_hash,
      a.requested_category,'APPROVED','usable',false,clock_timestamp(),'GREEN'
    from app_private.whatsapp_template_approved_submissions a
    where a.version=2 and a.logical_id in
      ('res_confirmacao_v2','res_confirmacao_desconto_v2','res_lembrete_dia_v2',
        'fila_mesa_pronta_v2');
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),
    sync_binding_id=v_binding,sync_binding_generation=1,sync_credential_revision=0,
    last_sync_published_at=clock_timestamp() where id=v_account;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
  if v_snapshot->>'eligible' <> 'true' or v_snapshot->>'rollout_ready' <> 'false'
    or v_snapshot->>'global_dispatch_enabled' is distinct from 'true'
    or v_snapshot->>'binding_id' is distinct from v_binding::text then
    raise exception '78_snapshot_scope: %',v_snapshot; end if;
  begin
    update public.platform_flags set value='false'::jsonb
      where key='whatsapp_automation_dispatch';
    v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
    if v_snapshot->>'global_dispatch_enabled' is distinct from 'false' then
      raise exception '78_global_dispatch_paused_snapshot: %',v_snapshot; end if;
    delete from public.platform_flags where key='whatsapp_automation_dispatch';
    v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
    if v_snapshot->>'global_dispatch_enabled' is distinct from 'false' then
      raise exception '78_global_dispatch_missing_snapshot: %',v_snapshot; end if;
    raise exception 'rollback temporary global flag changes' using errcode='P0B00';
  exception when sqlstate 'P0B00' then null; end;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,0,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from 'P0A01' then raise exception '78_rollout_gate: %',v_denied; end if;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.set_whatsapp_v2_service_rollout_ready(true,0) <> 1 then
    raise exception '78_rollout_cas'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
  if v_route->>'allowed' <> 'false' or v_route->>'reason_code' <> 'service_not_enabled' then
    raise exception '78_verified_default_off: %',v_route; end if;
  -- Meta PENDING and a stale sync cannot turn a proven store default OFF into
  -- an unknown route; the caller must be free to continue its email path.
  update public.whatsapp_remote_templates set remote_status='PENDING',
    last_synced_at=clock_timestamp()-interval '5 minutes'
    where account_id=v_account and logical_id='res_confirmacao_v2' and version=2;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
  if v_route->>'allowed' is distinct from 'false'
    or v_route->>'reason_code' is distinct from 'service_not_enabled' then
    raise exception '78_off_survives_meta_pending_sync_stale: %',v_route; end if;
  update public.whatsapp_remote_templates set remote_status='APPROVED',
    last_synced_at=clock_timestamp()
    where account_id=v_account and logical_id='res_confirmacao_v2' and version=2;
  -- Each temporary dependency loss is rolled back inside its own
  -- subtransaction; the outer fixture keeps its valid grant for opt-in.
  begin
    update app_private.whatsapp_template_v2_policy set enabled=false where id=1;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_off_survives_policy_pause: %',v_route; end if;
    raise exception 'rollback temporary policy pause' using errcode='P0B00';
  exception when sqlstate 'P0B00' then null; end;
  begin
    update app_private.whatsapp_template_v2_grants set revoked_at=clock_timestamp()
      where binding_id=v_binding;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_off_survives_grant_revocation: %',v_route; end if;
    raise exception 'rollback temporary grant revocation' using errcode='P0B00';
  exception when sqlstate 'P0B00' then null; end;
  begin
    update app_private.whatsapp_template_v2_enrollments set state='pending'
      where onboarding_id=v_onboarding;
    update public.whatsapp_channels set provider_subscribed_at=null,
      manual_echo_verified_at=null where id=v_channel;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
    if v_route->>'reason_code' is distinct from 'service_not_enabled' then
      raise exception '78_off_survives_pending_unsubscribed: %',v_route; end if;
    raise exception 'rollback temporary readiness loss' using errcode='P0B00';
  exception when sqlstate 'P0B00' then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_operator::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
  if v_snapshot->>'can_manage' <> 'false' then raise exception '78_operator_read'; end if;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,0,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception '78_operator_write: %',v_denied; end if;
  v_denied := null;
  begin update public.whatsapp_template_bindings set dispatch_enabled=true,adopted_at=now()
      where id=v_binding;
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from '42501' then raise exception '78_direct_binding_write: %',v_denied; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  update public.whatsapp_remote_templates set effective_category='MARKETING'
    where account_id=v_account and logical_id='res_confirmacao_v2' and version=2;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
  if (v_snapshot->'kinds'->0->>'ready') is distinct from 'false'
    or (v_snapshot->'kinds'->0->>'reason_code') is distinct from 'catalog_drift' then
    raise exception '78_category_drift_snapshot: %',v_snapshot->'kinds'->0; end if;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,0,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from 'P0A01' then raise exception '78_category_drift_enable: %',v_denied; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  update public.whatsapp_remote_templates set effective_category='UTILITY'
    where account_id=v_account and logical_id='res_confirmacao_v2' and version=2;
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  v_result := public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,0,1,0);
  if v_result->>'enabled' <> 'true' or (v_result->>'revision')::integer <> 1
    or not exists(select 1 from public.whatsapp_automation_adoptions where unit_id=v_unit)
    or not exists(select 1 from public.whatsapp_template_bindings
      where id=v_binding and dispatch_enabled and adopted_at is not null)
    or exists(select 1 from app_private.whatsapp_v2_service_binding_permits
      where tx_id=txid_current() and binding_id=v_binding) then
    raise exception '78_first_optin_atomic: %',v_result; end if;
  v_at := (v_result->>'enabled_at')::timestamptz;
  v_result := public.set_whatsapp_v2_service_preference(v_binding,'waitlist_table_ready',true,0,1,0);
  if v_result->>'enabled' <> 'true' then raise exception '78_table_ready_optin'; end if;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,0,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from 'PT409' then raise exception '78_cas: %',v_denied; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_old_res);
  if v_route->>'allowed' <> 'false' then raise exception '78_old_fact_replay: %',v_route; end if;
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
    party_size,reservation_code,created_at)
    values(v_new_res,v_unit,v_customer,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'21:00',
      'confirmed','web',2,'V78-'||v_new_res,v_at+interval '1 second');
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_new_res);
  if v_route->>'allowed' <> 'true' then raise exception '78_new_fact_route: %',v_route; end if;
  v_route := public.get_whatsapp_v2_service_route('reminder_d1',v_new_res);
  if v_route->>'allowed' <> 'false' or v_route->>'reason_code' <> 'service_not_enabled' then
    raise exception '78_other_kind_off: %',v_route; end if;
  -- The same WABA may serve two units; the first unit's preference never
  -- authorizes the second binding, even with the shared approved catalog.
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id)
    values(v_sibling_onboarding,v_org,v_sibling_unit,v_sibling_channel);
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,
      provider_subscribed_at,manual_echo_verified_at)
    values(v_sibling_channel,v_sibling_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7802"}'::jsonb,clock_timestamp(),clock_timestamp());
  update public.whatsapp_datafy_onboardings set state='completed',
    datafy_channel_id='local-7802',completed_at=clock_timestamp()
    where id=v_sibling_onboarding;
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(v_sibling_unit,v_sibling_channel,v_account,'datafy',clock_timestamp())
    returning id into v_sibling_binding;
  if public.authorize_whatsapp_template_v2_channel(v_sibling_onboarding,v_sibling_binding,1,0)
      is distinct from true or public.mark_whatsapp_template_v2_preparation(
        v_sibling_onboarding,v_sibling_channel,'ready',null) is distinct from true then
    raise exception '78_sibling_grant'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(
      v_sibling_binding,'confirmation',true,0,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from '42501' then
    raise exception '78_same_org_other_unit_write: %',v_denied; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  insert into public.reservations(id,unit_id,customer_id,date,time,status,source,
    party_size,reservation_code,created_at)
    values(v_sibling_res,v_sibling_unit,v_customer,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'21:30',
      'confirmed','web',2,'V78-'||v_sibling_res,clock_timestamp());
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_sibling_res);
  if v_route->>'auto_cohort' <> 'true' or v_route->>'allowed' <> 'false' then
    raise exception '78_same_waba_sibling_off: %',v_route; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.release_whatsapp_template_v2_channel(v_sibling_binding,1,0)
      is distinct from true then raise exception '78_sibling_revocation'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_sibling_res);
  if v_route->>'auto_cohort' <> 'true' or v_route->>'allowed' <> 'false'
    or v_route->>'reason_code' <> 'dependency_unavailable' then
    raise exception '78_revoked_grant_stays_closed: %',v_route; end if;
  insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone,
    status,party_size,created_at)
    values(v_wait,v_unit,v_customer,'Synthetic','11999997778','waiting',2,clock_timestamp());
  v_route := public.get_whatsapp_v2_service_route('waitlist_table_ready',v_wait);
  if v_route->>'allowed' <> 'true' then raise exception '78_table_ready_prefact: %',v_route; end if;
  v_result := public.claim_whatsapp_legacy_automation_post(
    'confirmation',v_new_res,v_channel,0,'send-confirmation');
  if v_result->>'allowed' <> 'false' or v_result->>'reason' <> 'adoption_active' then
    raise exception '78_legacy_refused: %',v_result; end if;
  v_job := public.enqueue_whatsapp_automation(jsonb_build_object(
    'unit_id',v_unit,'kind','confirmation','reservation_id',v_new_res,
    'source_event_key','local-78-post-guard','fact_at',v_at+interval '1 second',
    'expires_at',clock_timestamp()+interval '1 day','due_at',clock_timestamp()));
  if v_job is null then raise exception '78_managed_job_missing'; end if;
  -- A reconnect changes the credential pin. Both route and final SQL guard
  -- must refuse a new POST until the binding/grant are refreshed. Roll back
  -- just this fixture so the following opt-out tests keep the original pin.
  begin
    select template_credential_revision into v_credrev
      from public.whatsapp_channels where id=v_channel;
    update public.whatsapp_channels
      set credentials='{"phone_number_id":"7801-reconnected"}'::jsonb where id=v_channel;
    if (select template_credential_revision from public.whatsapp_channels where id=v_channel)
        <= v_credrev then raise exception '78_reconnect_revision_not_advanced'; end if;
    v_route := public.get_whatsapp_v2_service_route('confirmation',v_new_res);
    if v_route->>'allowed' is distinct from 'false' then
      raise exception '78_reconnect_route_open: %',v_route; end if;
    v_result := app_private.whatsapp_automation_post_core(
      v_job,gen_random_uuid(),1,null,null,false,'{}'::jsonb);
    if v_result->>'allowed' is distinct from 'false'
      or v_result->>'reason' is distinct from 'service_not_enabled' then
      raise exception '78_reconnect_prepare_open: %',v_result; end if;
    v_result := app_private.whatsapp_automation_post_core(
      v_job,gen_random_uuid(),1,null,null,true,'{}'::jsonb);
    if v_result->>'allowed' is distinct from 'false'
      or v_result->>'reason' is distinct from 'service_not_enabled' then
      raise exception '78_reconnect_confirm_open: %',v_result; end if;
    raise exception 'fixture_rollback' using errcode='P0780';
  exception when sqlstate 'P0780' then null; end;

  -- Operational consent revoked before prepare must be rejected by the
  -- existing inner guard, even though the store enabled this v2 purpose.
  begin
    v_result := public.claim_whatsapp_automation(v_job);
    v_fence := (v_result->>'claim_token')::uuid;
    if v_fence is null then raise exception '78_consent_prepare_claim: %',v_result; end if;
    if v_result->>'state' is distinct from 'claimed' then
      raise exception '78_consent_prepare_not_claimed: %',v_result; end if;
    update public.whatsapp_automation_jobs set safe_log_body='Local78 synthetic'
      where id=v_job and claim_token=v_fence;
    if (select state from public.whatsapp_automation_jobs where id=v_job) is distinct from 'claimed' then
      raise exception '78_consent_prepare_not_claimed_after_render'; end if;
    select binding_generation into v_generation from public.whatsapp_automation_jobs where id=v_job;
    select sync_epoch into v_epoch from public.whatsapp_automation_jobs where id=v_job;
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',v_owner::text,true);
    perform public.record_whatsapp_message_consent(v_unit,v_customer,'operational',
      'opt_out','in_person',clock_timestamp(),'local-78-before-prepare');
    perform set_config('request.jwt.claim.role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    v_result := app_private.whatsapp_automation_post_core(
      v_job,v_fence,v_generation,1,v_epoch,false,null);
    if v_result->>'allowed' is distinct from 'false'
      or v_result->>'reason' is distinct from 'authority_changed'
      or not exists(select from public.whatsapp_automation_jobs where id=v_job
        and state='blocked' and error_code='consent_changed' and posting_started_at is null
        and provider_message_id is null)
      or exists(select from app_private.whatsapp_cutover_intents
        where managed_job_id=v_job and state='posting') then
      raise exception '78_consent_prepare_open: %',v_result; end if;
    raise exception 'fixture_rollback' using errcode='P0780';
  exception when sqlstate 'P0780' then null; end;

  -- A later opt-out must also stop the final confirm-only gate after prepare.
  begin
    v_result := public.claim_whatsapp_automation(v_job);
    v_fence := (v_result->>'claim_token')::uuid;
    if v_fence is null then raise exception '78_consent_confirm_claim: %',v_result; end if;
    update public.whatsapp_automation_jobs set safe_log_body='Local78 synthetic'
      where id=v_job and claim_token=v_fence;
    select binding_generation into v_generation from public.whatsapp_automation_jobs where id=v_job;
    select sync_epoch into v_epoch from public.whatsapp_automation_jobs where id=v_job;
    v_result := app_private.whatsapp_automation_post_core(
      v_job,v_fence,v_generation,null,v_epoch,false,null);
    if v_result->>'allowed' is distinct from 'true' then
      raise exception '78_consent_confirm_prepare: % job=%',v_result,
        (select jsonb_build_object('state',state,'error_code',error_code,
          'posting_started_at',posting_started_at,'initial_version',initial_template_version,
          'sync_epoch',sync_epoch) from public.whatsapp_automation_jobs where id=v_job); end if;
    select jsonb_build_object('version',1,'kind','confirmation',
      'resource',jsonb_build_object('id',id,'unit_id',unit_id,'customer_id',customer_id,
        'date',date,'time',time,'status',status,'payment_status',payment_status,
        'source',source,'party_size',party_size,'reservation_code',reservation_code,
        'applied_discount_percent',applied_discount_percent,
        'satisfaction_rating',satisfaction_rating)) into v_expected
      from public.reservations where id=v_new_res;
    v_expected := v_expected || jsonb_build_object(
      'customer',(select jsonb_build_object('id',id,'organization_id',organization_id,
        'name',name,'phone',phone,'do_not_contact',do_not_contact,'deleted_at',deleted_at)
        from public.customers where id=v_customer),
      'unit',(select jsonb_build_object('id',id,'organization_id',organization_id,
        'name',name,'slug',slug,'timezone',timezone) from public.units where id=v_unit),
      'rule',null,'setting',jsonb_build_object('key',null,'present',false,'value',null));
    -- The same final gate is positive before opt-out; the subtransaction
    -- restores its posting marker so the subsequent call tests only consent.
    begin
      v_result := public.confirm_whatsapp_automation_resource_post(
        v_job,v_fence,v_generation,null,v_epoch,v_expected);
      if v_result->>'allowed' is distinct from 'true' then
        raise exception '78_consent_confirm_control: %',v_result; end if;
      raise exception 'fixture_rollback' using errcode='P0781';
    exception when sqlstate 'P0781' then null; end;
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',v_owner::text,true);
    perform public.record_whatsapp_message_consent(v_unit,v_customer,'operational',
      'opt_out','in_person',clock_timestamp(),'local-78-before-confirm');
    perform set_config('request.jwt.claim.role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    v_result := public.confirm_whatsapp_automation_resource_post(
      v_job,v_fence,v_generation,1,v_epoch,v_expected);
    if v_result->>'allowed' is distinct from 'false'
      or v_result->>'reason' is distinct from 'authority_changed'
      or exists(select from public.whatsapp_automation_jobs
        where id=v_job and provider_message_id is not null)
      or exists(select from app_private.whatsapp_cutover_intents
        where managed_job_id=v_job and state='posting') then
      raise exception '78_consent_confirm_open: %',v_result; end if;
    raise exception 'fixture_rollback' using errcode='P0780';
  exception when sqlstate 'P0780' then null; end;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_result := public.set_whatsapp_v2_service_preference(v_binding,'confirmation',false,1,1,0);
  if v_result->>'enabled' <> 'false' then raise exception '78_optout'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  v_result := app_private.whatsapp_automation_post_core(v_job,gen_random_uuid(),1,null,null,false,'{}'::jsonb);
  if v_result->>'reason' is distinct from 'service_not_enabled' then
    raise exception '78_prepare_after_optout: %',v_result; end if;
  v_result := app_private.whatsapp_automation_post_core(v_job,gen_random_uuid(),1,null,null,true,'{}'::jsonb);
  if v_result->>'reason' is distinct from 'service_not_enabled' then
    raise exception '78_confirm_after_optout: %',v_result; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.release_whatsapp_template_channel(v_channel,'dispatch',false,0,1)
      is distinct from true then raise exception '78_admin_stop'; end if;
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_unit);
  if v_snapshot->>'admin_paused' is distinct from 'true'
    or (v_snapshot->'kinds'->5->>'enabled') is distinct from 'true' then
    raise exception '78_admin_pause_snapshot: %',v_snapshot; end if;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(v_binding,'confirmation',true,2,1,0);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from 'P0A01' then raise exception '78_admin_pause_sovereign: %',v_denied; end if;

  -- A migration grant remains disqualified after its replaced UazAPI row is
  -- removed. Exercise a complete v2 binding and fresh catalog so readiness
  -- cannot accidentally mask an authorization gap in the setter.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  update public.whatsapp_channels set credentials='{"phone_number_id":"7803"}'::jsonb,
    provider_subscribed_at=clock_timestamp(),manual_echo_verified_at=clock_timestamp()
    where id=v_dual_datafy;
  select template_credential_revision into v_dual_credrev
    from public.whatsapp_channels where id=v_dual_datafy;
  update public.whatsapp_datafy_onboardings set state='completed',
    datafy_channel_id='local-7803',completed_at=clock_timestamp()
    where id=v_dual_onboarding;
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at,channel_credential_revision)
    values(v_dual_unit,v_dual_datafy,v_account,'datafy',clock_timestamp(),v_dual_credrev)
    returning id into v_dual_binding;
  v_grant := public.authorize_whatsapp_template_v2_channel(
    v_dual_onboarding,v_dual_binding,1,v_dual_credrev);
  v_mark := public.mark_whatsapp_template_v2_preparation(
    v_dual_onboarding,v_dual_datafy,'ready',null);
  if v_grant is distinct from true or v_mark is distinct from true then
    raise exception '78_migration_binding_setup grant=% mark=%',v_grant,v_mark; end if;
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),
    sync_binding_id=v_dual_binding,sync_binding_generation=1,
    sync_credential_revision=v_dual_credrev,
    last_sync_published_at=clock_timestamp() where id=v_account;
  update public.whatsapp_remote_templates set last_synced_at=clock_timestamp()
    where account_id=v_account and version=2;
  delete from public.whatsapp_channels where id=v_dual_uazapi;
  v_route := public.get_whatsapp_v2_service_route('confirmation',v_dual_res);
  if v_route->>'auto_cohort' is distinct from 'false'
    or v_route->>'allowed' is distinct from 'true' then
    raise exception '78_migration_after_old_row_removed_route: %',v_route; end if;
  insert into public.unit_members(user_id,unit_id,role)
    values(v_owner,v_dual_unit,'owner');
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_owner::text,true);
  v_snapshot := public.get_whatsapp_v2_service_preferences(v_dual_unit);
  if v_snapshot->>'auto_cohort' is distinct from 'false'
    or v_snapshot->>'eligible' is distinct from 'false' then
    raise exception '78_migration_after_old_row_removed_snapshot: %',v_snapshot; end if;
  v_denied := null;
  begin perform public.set_whatsapp_v2_service_preference(
      v_dual_binding,'confirmation',true,0,1,v_dual_credrev);
    exception when others then get stacked diagnostics v_denied = returned_sqlstate; end;
  if v_denied is distinct from 'P0A01' then
    raise exception '78_migration_after_old_row_removed_setter: %',v_denied; end if;
  raise notice 'GREEN78 default OFF, UazAPI dual/migration after old row removal, stale auto, role/tenant, rollout, CAS, category drift, typed adoption, old fact, table-ready pre-fact, same-WABA/revocation, prepare/confirm opt-out, admin pause';
end $$;
rollback;

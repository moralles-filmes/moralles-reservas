\set ON_ERROR_STOP on
-- Disposable, networkless PG17 only. Commit so two independent psql sessions
-- can race the same store opt-in; the container is deleted after the run.
-- The compact 25 fixture omits this existing production column.
alter table public.whatsapp_channels add column if not exists manual_echo_verified_at timestamptz;
begin;
do $$
declare
  v_org uuid := '79000000-0000-4000-8000-000000000001';
  v_unit uuid := '79000000-0000-4000-8000-000000000002';
  v_owner uuid := '79000000-0000-4000-8000-000000000003';
  v_admin uuid := '79000000-0000-4000-8000-000000000004';
  v_channel uuid := '79000000-0000-4000-8000-000000000005';
  v_onboarding uuid := '79000000-0000-4000-8000-000000000006';
  v_account uuid := '79000000-0000-4000-8000-000000000007';
  v_binding uuid;
begin
  if current_database() <> 'postgres'
    or current_setting('server_version_num')::integer < 170000
    or exists(select 1 from cron.job where jobname in
      ('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select 1 from net.http_request_queue)
    or exists(select 1 from public.units where id=v_unit) then
    raise exception '79_not_fresh_quarantined';
  end if;
  insert into auth.users(id) values(v_owner),(v_admin);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'V2 CAS local');
  insert into public.units(id,organization_id,name) values(v_unit,v_org,'CAS store');
  insert into public.unit_members(user_id,unit_id,role) values(v_owner,v_unit,'owner');
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  update public.platform_flags set value='true'::jsonb
    where key in ('whatsapp_template_catalog','whatsapp_automation_dispatch');
  if public.configure_whatsapp_template_v2_policy(true,0)->>'enabled' is distinct from 'true' then
    raise exception '79_policy'; end if;
  insert into public.whatsapp_datafy_onboardings
    (id,organization_id,unit_id,reserved_channel_id,created_at)
    values(v_onboarding,v_org,v_unit,v_channel,clock_timestamp());
  insert into public.whatsapp_channels
    (id,unit_id,provider,status,is_active,last_health_check_at,credentials,
      provider_subscribed_at,manual_echo_verified_at)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),
      '{"phone_number_id":"7901"}'::jsonb,clock_timestamp(),clock_timestamp());
  update public.whatsapp_datafy_onboardings set state='completed',
    datafy_channel_id='local-7901',completed_at=clock_timestamp()
    where id=v_onboarding;
  insert into public.whatsapp_template_accounts
    (id,organization_id,waba_id,verified_at,created_at)
    values(v_account,v_org,'7900000000001',clock_timestamp(),clock_timestamp());
  insert into public.whatsapp_template_bindings
    (unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp())
    returning id into v_binding;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.authorize_whatsapp_template_v2_channel(v_onboarding,v_binding,1,0)
      is distinct from true or public.mark_whatsapp_template_v2_preparation(
        v_onboarding,v_channel,'ready',null) is distinct from true then
    raise exception '79_grant'; end if;
  insert into public.whatsapp_remote_templates
    (account_id,logical_id,version,language,name,desired_hash,requested_category,
      binding_generation,remote_id,observed_hash,effective_category,remote_status,
      local_status,sync_required,last_synced_at,quality)
    select v_account,a.logical_id,2,'pt_BR',a.logical_id,a.desired_hash,
      a.requested_category,1,'local-79-'||a.logical_id,a.desired_hash,
      a.requested_category,'APPROVED','usable',false,clock_timestamp(),'GREEN'
    from app_private.whatsapp_template_approved_submissions a
    where a.version=2 and a.logical_id in
      ('res_confirmacao_v2','res_confirmacao_desconto_v2','fila_mesa_pronta_v2');
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),
    sync_binding_id=v_binding,sync_binding_generation=1,sync_credential_revision=0,
    last_sync_published_at=clock_timestamp() where id=v_account;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.set_whatsapp_v2_service_rollout_ready(true,0) <> 1 then
    raise exception '79_rollout'; end if;
end $$;
commit;

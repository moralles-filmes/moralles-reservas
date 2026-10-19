\set ON_ERROR_STOP on
-- One committed, synthetic posting job. Clone this isolated database twice;
-- the two sessions in 73b exercise each possible winner independently.
begin;
do $$
declare
  v_org uuid:='73000000-0000-4000-8000-000000000001';
  v_unit uuid:='73000000-0000-4000-8000-000000000011';
  v_unit2 uuid:='73000000-0000-4000-8000-000000000012';
  v_admin uuid:='73000000-0000-4000-8000-000000000021';
  v_onboarding uuid:='73000000-0000-4000-8000-000000000031';
  v_onboarding2 uuid:='73000000-0000-4000-8000-000000000032';
  v_onboarding3 uuid:='73000000-0000-4000-8000-000000000033';
  v_channel uuid:='73000000-0000-4000-8000-000000000041';
  v_channel2 uuid:='73000000-0000-4000-8000-000000000042';
  v_channel3 uuid:='73000000-0000-4000-8000-000000000043';
  v_account uuid:='73000000-0000-4000-8000-000000000051';
  v_job uuid:='73000000-0000-4000-8000-000000000061';
  v_fence uuid:='73000000-0000-4000-8000-000000000071';
  v_binding uuid;
begin
  if current_database()<>'postgres'
    or exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'auto73_concurrency_quarantine_required';
  end if;
  insert into auth.users(id) values(v_admin);
  insert into public.platform_admins(user_id) values(v_admin);
  insert into public.organizations(id,name) values(v_org,'Concurrency fixture');
  insert into public.units(id,organization_id,name)
    values(v_unit,v_org,'Concurrency fixture'),(v_unit2,v_org,'Sibling fixture');
  update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  if public.configure_whatsapp_template_auto_policy(true,0)->>'enabled'<>'true' then
    raise exception 'auto73_policy_not_enabled';
  end if;
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding,v_org,v_unit,v_channel);
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel,v_unit,'datafy','connected',true,clock_timestamp(),'{"phone_number_id":"7391"}'::jsonb,'local-only');
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7391',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding;
  insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
    values(v_account,v_org,'739000000001',clock_timestamp());
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel,v_account,'datafy',clock_timestamp()) returning id into v_binding;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claim.sub','',true);
  if public.authorize_whatsapp_template_auto_channel(v_onboarding,v_binding,1,0) is distinct from true then
    raise exception 'auto73_grant_failed';
  end if;
  if public.mark_whatsapp_template_preparation(v_onboarding,v_channel,'ready',null) is distinct from true then
    raise exception 'auto73_initial_ready_failed';
  end if;
  -- Two fresh eligible channels in separate units share one verified WABA.
  -- They have bindings but no grant or permit before the race starts.
  insert into public.whatsapp_datafy_onboardings(id,organization_id,unit_id,reserved_channel_id)
    values(v_onboarding2,v_org,v_unit,v_channel2),(v_onboarding3,v_org,v_unit2,v_channel3);
  insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
    values(v_channel2,v_unit,'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7392"}'::jsonb,'local-only'),
      (v_channel3,v_unit2,'datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7393"}'::jsonb,'local-only');
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7392',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding2;
  update public.whatsapp_datafy_onboardings set datafy_channel_id='local-7393',state='completed',completed_at=clock_timestamp()
    where id=v_onboarding3;
  insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
    values(v_unit,v_channel2,v_account,'datafy',clock_timestamp()),
      (v_unit2,v_channel3,v_account,'datafy',clock_timestamp());
  insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values(v_account,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1','UTILITY',1);
  update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),sync_binding_id=v_binding,
    sync_binding_generation=1,sync_credential_revision=0,last_sync_published_at=clock_timestamp() where id=v_account;
  update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp() where account_id=v_account;
  insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,operation,target_key,
    state,attempts,claim_token,claimed_until)
    values(v_job,v_org,v_account,v_binding,1,'provision','res_confirmacao_v1',
      'claimed',0,v_fence,clock_timestamp()+interval '15 minutes');
  if public.prepare_whatsapp_template_provision(v_job,v_fence,1,
      '4ab2cdd4711c9b95b122a23a773088bfa8b6d3d15a6eac04cb234d4f8d0ac114') is distinct from true then
    raise exception 'auto73_prepare_failed';
  end if;
end $$;
commit;

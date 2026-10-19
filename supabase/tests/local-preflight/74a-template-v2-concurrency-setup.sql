\set ON_ERROR_STOP on
-- Permanent fixtures ONLY inside the isolated disposable 74 container.
begin;
set local lock_timeout='5s';
do $$ begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000
    or exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then
    raise exception 'template_v2_concurrency_quarantine_required'; end if;
end $$;
insert into auth.users(id) values('74000000-0000-4000-8000-000000000001');
insert into public.platform_admins(user_id) values('74000000-0000-4000-8000-000000000001');
insert into public.organizations(id,name)
values('74000000-0000-4000-8000-000000000011','V2 concurrency local');
insert into public.units(id,organization_id,name) values
('74000000-0000-4000-8000-000000000021','74000000-0000-4000-8000-000000000011','V2 race A'),
('74000000-0000-4000-8000-000000000022','74000000-0000-4000-8000-000000000011','V2 race B'),
('74000000-0000-4000-8000-000000000023','74000000-0000-4000-8000-000000000011','V2 race C1'),
('74000000-0000-4000-8000-000000000024','74000000-0000-4000-8000-000000000011','V2 race C2'),
('74000000-0000-4000-8000-000000000025','74000000-0000-4000-8000-000000000011','V2 manual race');
update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';
-- This older onboarding is intentionally outside the future-only v2 policy.
insert into public.whatsapp_datafy_onboardings
  (id,organization_id,unit_id,reserved_channel_id)
values('74000000-0000-4000-8000-000000000035',
  '74000000-0000-4000-8000-000000000011',
  '74000000-0000-4000-8000-000000000025',
  '74000000-0000-4000-8000-000000000045');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000001',true);
select public.configure_whatsapp_template_v2_policy(true,0);
insert into public.whatsapp_datafy_onboardings
  (id,organization_id,unit_id,reserved_channel_id) values
('74000000-0000-4000-8000-000000000031','74000000-0000-4000-8000-000000000011','74000000-0000-4000-8000-000000000021','74000000-0000-4000-8000-000000000041'),
('74000000-0000-4000-8000-000000000032','74000000-0000-4000-8000-000000000011','74000000-0000-4000-8000-000000000022','74000000-0000-4000-8000-000000000042'),
('74000000-0000-4000-8000-000000000033','74000000-0000-4000-8000-000000000011','74000000-0000-4000-8000-000000000023','74000000-0000-4000-8000-000000000043'),
('74000000-0000-4000-8000-000000000034','74000000-0000-4000-8000-000000000011','74000000-0000-4000-8000-000000000024','74000000-0000-4000-8000-000000000044');
insert into public.whatsapp_channels
  (id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values
('74000000-0000-4000-8000-000000000041','74000000-0000-4000-8000-000000000021','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7411"}'::jsonb,'local-only'),
('74000000-0000-4000-8000-000000000042','74000000-0000-4000-8000-000000000022','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7422"}'::jsonb,'local-only'),
('74000000-0000-4000-8000-000000000043','74000000-0000-4000-8000-000000000023','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7433"}'::jsonb,'local-only'),
('74000000-0000-4000-8000-000000000044','74000000-0000-4000-8000-000000000024','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7444"}'::jsonb,'local-only'),
('74000000-0000-4000-8000-000000000045','74000000-0000-4000-8000-000000000025','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"7455"}'::jsonb,'local-only');
update public.whatsapp_datafy_onboardings set state='completed',completed_at=clock_timestamp(),
  datafy_channel_id='local-'||right(id::text,4)
where id in('74000000-0000-4000-8000-000000000031','74000000-0000-4000-8000-000000000032',
  '74000000-0000-4000-8000-000000000033','74000000-0000-4000-8000-000000000034');
update public.whatsapp_datafy_onboardings set state='completed',completed_at=clock_timestamp(),
  datafy_channel_id='local-manual-7455'
where id='74000000-0000-4000-8000-000000000035';
insert into public.whatsapp_template_accounts
  (id,organization_id,waba_id,verified_at,created_at) values
('74000000-0000-4000-8000-000000000051','74000000-0000-4000-8000-000000000011','741000000001',clock_timestamp(),clock_timestamp()),
('74000000-0000-4000-8000-000000000052','74000000-0000-4000-8000-000000000011','742000000001',clock_timestamp(),clock_timestamp()),
('74000000-0000-4000-8000-000000000053','74000000-0000-4000-8000-000000000011','743000000001',clock_timestamp(),clock_timestamp()),
('74000000-0000-4000-8000-000000000054','74000000-0000-4000-8000-000000000011','745000000001',clock_timestamp(),
  (select enabled_at-interval '1 minute' from app_private.whatsapp_template_v2_policy where id=1));
insert into public.whatsapp_template_bindings
  (id,unit_id,channel_id,account_id,provider,verified_at) values
('74000000-0000-4000-8000-000000000061','74000000-0000-4000-8000-000000000021','74000000-0000-4000-8000-000000000041','74000000-0000-4000-8000-000000000051','datafy',clock_timestamp()),
('74000000-0000-4000-8000-000000000062','74000000-0000-4000-8000-000000000022','74000000-0000-4000-8000-000000000042','74000000-0000-4000-8000-000000000052','datafy',clock_timestamp()),
('74000000-0000-4000-8000-000000000063','74000000-0000-4000-8000-000000000023','74000000-0000-4000-8000-000000000043','74000000-0000-4000-8000-000000000053','datafy',clock_timestamp()),
('74000000-0000-4000-8000-000000000064','74000000-0000-4000-8000-000000000024','74000000-0000-4000-8000-000000000044','74000000-0000-4000-8000-000000000053','datafy',clock_timestamp()),
('74000000-0000-4000-8000-000000000065','74000000-0000-4000-8000-000000000025','74000000-0000-4000-8000-000000000045','74000000-0000-4000-8000-000000000054','datafy',clock_timestamp());
insert into public.whatsapp_remote_templates
  (account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
values('74000000-0000-4000-8000-000000000054','res_confirmacao_v1',1,'pt_BR',
  'res_confirmacao_v1','ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1',
  'UTILITY',1);
insert into public.whatsapp_template_jobs
  (id,organization_id,account_id,binding_id,binding_generation,operation,target_key,revision,state)
values('74000000-0000-4000-8000-000000000075',
  '74000000-0000-4000-8000-000000000011',
  '74000000-0000-4000-8000-000000000054',
  '74000000-0000-4000-8000-000000000065',1,'provision','res_confirmacao_v1',1,'queued');
commit;

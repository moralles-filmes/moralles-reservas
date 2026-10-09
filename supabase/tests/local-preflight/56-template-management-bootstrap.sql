\set ON_ERROR_STOP on
-- ROOT only. This bridge asserts installed predecessors; it creates no schema.
begin;
do $$ declare sig text; begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000 then raise exception 'task56_runtime_mismatch'; end if;
  if exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    or exists(select from net.http_request_queue) then raise exception 'task56_quarantine_required'; end if;
  foreach sig in array array['auth.uid()','auth.role()',
    'app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)',
    'public.confirm_whatsapp_automation_resource_post(uuid,uuid,bigint,bigint,bigint,jsonb)',
    'public.reconcile_whatsapp_automation_acceptance(uuid)',
    'public.prepare_whatsapp_template_provision(uuid,uuid,bigint)',
    'public.finish_whatsapp_template_job(uuid,uuid,jsonb)',
    'public.get_whatsapp_automation_delivery_state(uuid,integer,integer)'] loop
    if to_regprocedure(sig) is null then raise exception 'task56_missing_predecessor %',sig; end if;
  end loop;
  if to_regtype('app_private.whatsapp_automation_pin_tuple') is null
    or to_regclass('app_private.whatsapp_automation_pin_initialization_permits') is null
    or to_regclass('app_private.whatsapp_promotion_slot_release_permits') is null
    or to_regclass('public.audit_log') is null then raise exception 'task56_authority_prerequisite'; end if;
  if not exists(select from pg_attribute where attrelid='public.whatsapp_automation_jobs'::regclass and attname='next_eligibility_check_at' and atttypid='timestamptz'::regtype)
    or not exists(select from pg_trigger where tgrelid='public.whatsapp_channels'::regclass and not tgisinternal and tgenabled<>'D' and tgfoid='public.guard_whatsapp_template_credential_revision()'::regprocedure)
    or has_table_privilege('service_role','public.whatsapp_automation_receipt_events','INSERT')
    or has_table_privilege('authenticated','public.whatsapp_template_bindings','UPDATE') then raise exception 'task56_predecessor_shape_or_acl'; end if;
end $$;
select 'GREEN56 installed genuine authority, current expiry schema and closed ACL prerequisites' as evidence;
rollback;

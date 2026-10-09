\set ON_ERROR_STOP on
-- ROOT-only prerequisite bridge on the already-owned 25/38/41/48 runtime.
-- MAIN133 permits only the historical nullable-text external_instance_id column.
-- No legacy replay, Auth replacement, cron invocation or secret read.
begin;
do $$ begin
  if current_database()<>'postgres' or current_setting('server_version_num')::integer<170000 then raise exception 'task52_runtime_mismatch'; end if;
  if to_regprocedure('public.reconcile_whatsapp_automation_acceptance(uuid)') is null
    or to_regprocedure('app_private.whatsapp_automation_post_core(uuid,uuid,bigint,bigint,bigint,boolean,jsonb)') is null
    or to_regprocedure('public.append_conversation_message(uuid,jsonb)') is null
    or to_regprocedure('auth.uid()') is null or to_regprocedure('auth.role()') is null then raise exception 'task52_predecessors_required'; end if;
  if not exists(select from pg_attribute where attrelid='public.notifications_sent'::regclass and attname='delivered_at' and atttypid='timestamptz'::regtype)
    or not exists(select from pg_attribute where attrelid='public.whatsapp_channels'::regclass and attname='template_credential_revision')
    then raise exception 'task52_bridge_shape_required'; end if;
  if exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) then raise exception 'task52_quarantine_required'; end if;
  if exists(select from net.http_request_queue) then raise exception 'task52_net_queue_not_empty'; end if;
  if exists(select from pg_stat_activity where pid<>pg_backend_pid() and state='active' and query~'trigger_whatsapp_(automation_worker|template_workers)') then raise exception 'task52_worker_inflight'; end if;
  -- Real same-pointer writer dependencies: bridge25:49–79 and workers:14–44,
  -- 191–288. Assert only; never substitute a Vault writer or revision trigger.
  if to_regprocedure('public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text)') is null
    or to_regclass('vault.secrets') is null or to_regclass('app_private.whatsapp_template_revision_permits') is null
    or to_regclass('public.whatsapp_channel_lifecycle_events') is null
    or not exists(select from pg_attribute where attrelid='public.whatsapp_channels'::regclass and attname='instance_token_secret_id' and atttypid='uuid'::regtype)
    or not exists(select from pg_attribute where attrelid='public.whatsapp_channels'::regclass and attname='provisioning_claim_id' and atttypid='uuid'::regtype)
    or not exists(select from pg_trigger where tgrelid='public.whatsapp_channels'::regclass and not tgisinternal and tgenabled<>'D'
      and tgfoid=to_regprocedure('public.guard_whatsapp_template_credential_revision()')) then raise exception 'task52_real_vault_writer_required'; end if;
  if not has_function_privilege('service_role','public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.store_whatsapp_channel_instance_token(uuid,uuid,text,uuid,text)','EXECUTE') then raise exception 'task52_vault_writer_acl_mismatch'; end if;
end $$;
-- Exact source: 20260817170753_whatsapp_multiprovider_uazapi.sql:46.
-- Persistent and idempotent; all other dependencies above remain assertions.
alter table public.whatsapp_channels add column if not exists external_instance_id text;
do $$ begin
  if not exists(
    select from pg_attribute a join pg_class c on c.oid=a.attrelid
    where a.attrelid='public.whatsapp_channels'::regclass
      and a.attname='external_instance_id' and not a.attisdropped
      and a.atttypid='text'::regtype and not a.attnotnull and not a.atthasdef
      and c.relrowsecurity and c.relforcerowsecurity
  ) then raise exception 'task52_external_instance_bridge_mismatch'; end if;
end $$;
select 'GREEN52 exact nullable-text external-instance bridge, real dependencies and schedule quarantine' as evidence;
commit;

-- Worker pg_cron: process-billing-notifications (Fase 4b).
-- Mesmo padrão de 20260716140000_064_process_asaas_reconcile_cron.sql:
-- pg_cron -> wrapper SECURITY DEFINER -> pg_net.http_post com internal_api_key
-- do Vault -> Edge Function. A EF é no-op se a flag billing_notifications_dispatch
-- estiver OFF, então agendar antes do go-live é inofensivo.
-- Schedule: */5 (junto com billing-unblock — jobs de minuto não colidem).

create extension if not exists pg_cron;

create or replace function trigger_billing_notifications()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text := 'https://gbabxcrntkwgblgqsiit.supabase.co';
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets
  where name = 'internal_api_key'
  limit 1;

  if api_key is null or api_key = '' then
    raise notice '[billing-notifications] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

do $$
begin
  perform cron.unschedule('billing-notifications');
exception when others then null;
end $$;

select cron.schedule(
  'billing-notifications',
  '*/5 * * * *',
  'select trigger_billing_notifications();'
);

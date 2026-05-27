-- Worker pg_cron: cancela reservas com pagamento pendente expirado.
--
-- Schedule: a cada 2 minutos.
-- Padrão: pg_cron → wrapper SECURITY DEFINER → pg_net.http_post com
-- internal_api_key do Vault → Edge Function expire-pending-payments.

create extension if not exists pg_cron;

create or replace function trigger_expire_pending_payments()
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
    raise notice '[expire-pending-payments] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/expire-pending-payments',
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
  perform cron.unschedule('expire-pending-payments');
exception when others then
  null;
end $$;

select cron.schedule(
  'expire-pending-payments',
  '*/2 * * * *',
  'select trigger_expire_pending_payments();'
);

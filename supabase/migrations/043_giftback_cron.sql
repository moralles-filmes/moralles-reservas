-- Agendamento diário do processador de gatilhos de Giftback.
--
-- Padrão: igual o cron do notification-outbox (mig 029) — wrapper SECURITY
-- DEFINER lê INTERNAL_API_KEY do Vault e dispara via pg_net.
--
-- Pré-requisito: secret 'internal_api_key' já cadastrado no Vault (foi feito
-- pra mig 029). Sem isso, a função loga warning e ignora.

create or replace function trigger_voucher_processor()
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
    raise notice '[voucher-triggers] internal_api_key ausente no Vault — cadastre via vault.create_secret()';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-voucher-triggers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

-- Diário às 12:00 UTC = 09:00 BRT. cron.schedule é idempotente por jobname.
do $$
begin
  perform cron.unschedule('process-voucher-triggers');
exception when others then
  null;
end $$;

select cron.schedule(
  'process-voucher-triggers',
  '0 12 * * *',
  'select trigger_voucher_processor();'
);

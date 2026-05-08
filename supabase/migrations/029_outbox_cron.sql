-- Agendamento do processador do outbox via pg_cron + pg_net.
--
-- Como o pg_cron roda no Postgres (não tem acesso aos Edge Function secrets),
-- o INTERNAL_API_KEY precisa ser cadastrado UMA vez no Vault do Supabase:
--
--   select vault.create_secret('SEU_INTERNAL_API_KEY_AQUI', 'internal_api_key');
--
-- Sem isso o cron loga 'internal_api_key não encontrado no Vault' e ignora
-- a chamada (não quebra nada).

create extension if not exists pg_cron;

-- Wrapper SECURITY DEFINER: lê o secret do Vault e dispara a Edge Function
-- via pg_net. O cron não precisa saber a URL nem a key.
create or replace function trigger_outbox_processor()
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
    raise notice '[outbox] internal_api_key ausente no Vault — cadastre via vault.create_secret()';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-notification-outbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Agendamento — a cada 1 minuto. cron.schedule é idempotente por jobname.
do $$
begin
  -- Remove agendamento prévio se existir (safe re-run da migration)
  perform cron.unschedule('process-notification-outbox');
exception when others then
  null;
end $$;

select cron.schedule(
  'process-notification-outbox',
  '* * * * *',
  'select trigger_outbox_processor();'
);

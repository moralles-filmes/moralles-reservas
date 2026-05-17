-- Agendamento diário do lembrete D-1 (10:00 BRT) e da pesquisa D+1 (14:00 BRT).
--
-- Substitui os 2 workflows N8N (docs/n8n/workflow-reminder-d1.json e
-- workflow-survey-d1.json). Padrão idêntico ao cron do giftback (mig 043) e do
-- outbox de confirmação (mig 029): wrapper SECURITY DEFINER lê INTERNAL_API_KEY
-- do Vault e dispara via pg_net.
--
-- Pré-requisito: secret 'internal_api_key' já cadastrado no Vault (foi feito
-- pra mig 029). Sem isso, as funções logam warning e ignoram (não quebram).

create or replace function trigger_reminder_processor()
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
    raise notice '[reminder-d1] internal_api_key ausente no Vault — cadastre via vault.create_secret()';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-reservation-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function trigger_survey_processor()
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
    raise notice '[survey-d1] internal_api_key ausente no Vault — cadastre via vault.create_secret()';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-satisfaction-surveys',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

-- Lembrete D-1: 13:00 UTC = 10:00 BRT.
do $$
begin
  perform cron.unschedule('process-reservation-reminders');
exception when others then
  null;
end $$;

select cron.schedule(
  'process-reservation-reminders',
  '0 13 * * *',
  'select trigger_reminder_processor();'
);

-- Pesquisa D+1: 17:00 UTC = 14:00 BRT.
do $$
begin
  perform cron.unschedule('process-satisfaction-surveys');
exception when others then
  null;
end $$;

select cron.schedule(
  'process-satisfaction-surveys',
  '0 17 * * *',
  'select trigger_survey_processor();'
);

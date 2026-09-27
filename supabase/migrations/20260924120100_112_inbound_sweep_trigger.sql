-- Wrapper da varredura de eventos inbound (Fase C).
--
-- ESTA MIGRATION SÓ CRIA A FUNÇÃO. O agendamento é a 114.
--
-- Lê `project_url` E `internal_api_key` do Vault, fail-closed: faltando
-- qualquer um, avisa e retorna sem POST. NÃO há URL de projeto embutida —
-- um banco reconstruído por este histórico não pode agendar cron apontando
-- para PRODUÇÃO. O header se monta por concatenação, nunca literal.
-- Guardrail: scripts/migration-static-guard.test.ts.

create or replace function public.trigger_whatsapp_inbound_sweep()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  api_key text;
  project_url text;
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'internal_api_key' limit 1;

  select decrypted_secret into project_url
  from vault.decrypted_secrets where name = 'project_url' limit 1;

  if api_key is null or api_key = '' then
    raise notice '[whatsapp-inbound-sweep] internal_api_key ausente no Vault — skip';
    return;
  end if;

  if project_url is null or project_url = '' then
    raise notice '[whatsapp-inbound-sweep] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/webhook-whatsapp?sweep=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão e o schema public é
-- exposto ao PostgREST com a anon key.
revoke all on function public.trigger_whatsapp_inbound_sweep() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'trigger_whatsapp_inbound_sweep';
--
-- 2. Nenhum job agendado ainda (esperado: 0 linhas — o agendamento é a 114):
--   select jobname from cron.job where jobname = 'whatsapp-inbound-sweep';
--
-- 3. Segredos presentes (esperado: 2 linhas):
--   select name from vault.decrypted_secrets
--    where name in ('internal_api_key', 'project_url');

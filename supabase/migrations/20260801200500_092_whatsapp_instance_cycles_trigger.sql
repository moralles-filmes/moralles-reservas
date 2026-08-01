-- Wrapper pg_cron do worker de ciclos da instância (Fase 6b).
--
-- ESTA MIGRATION NÃO AGENDA NADA. O agendamento é a 093, aplicada só no passo
-- 12 do rollout, depois da execução manual sob observação humana. `db push`
-- aplica tudo que está pendente — se o `cron.schedule` estivesse aqui, o cron
-- nasceria no passo 1. A função existir sem estar agendada é inofensiva:
-- ninguém a chama.
--
-- URL DO PROJETO VEM DO VAULT, NÃO EMBUTIDA. As treze migrations legadas
-- embutem 'https://<ref>.supabase.co' e, por isso, um banco reconstruído a
-- partir desse histórico com pg_cron ativo agenda jobs que fazem POST em
-- PRODUÇÃO. Consertar as treze é a frente
-- BASELINE_REPRODUCIBLE_DATABASE_ENVIRONMENT (junto do replay, que hoje
-- estoura em 42P13); o que se garante aqui é que nenhuma migration NOVA repete
-- o padrão. O guardrail scripts/migration-static-guard.test.ts falha o CI se
-- alguém regredir.
--
-- FAIL-CLOSED: sem project_url ou sem internal_api_key no Vault, a função
-- avisa e RETORNA sem fazer POST. Num banco reconstruído sem segredos ela
-- simplesmente não dispara — que é exatamente o comportamento desejado.
--
-- PRÉ-REQUISITO OPERACIONAL (não é migration — é semeadura de segredo, como o
-- internal_api_key já é hoje):
--   select vault.create_secret('<URL do projeto>', 'project_url');

create extension if not exists pg_cron;

create or replace function public.trigger_whatsapp_instance_cycles()
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
    raise notice '[whatsapp-instance-cycles] internal_api_key ausente no Vault — skip';
    return;
  end if;

  if project_url is null or project_url = '' then
    raise notice '[whatsapp-instance-cycles] project_url ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-whatsapp-instance-cycles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Toda função trigger_* precisa disto: CREATE FUNCTION concede EXECUTE a
-- PUBLIC por padrão e o schema public é exposto ao PostgREST com a anon key
-- (a migration 084 fez a limpeza retroativa das antigas).
revoke all on function public.trigger_whatsapp_instance_cycles() from public, anon, authenticated;

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. ACL (esperado: sem anon= e sem authenticated=):
--   select proacl from pg_proc where proname = 'trigger_whatsapp_instance_cycles';
--
-- 2. Nenhum job agendado ainda (esperado: 0 linhas — o agendamento é a 093):
--   select jobname from cron.job where jobname = 'whatsapp-instance-cycles';
--
-- 3. Segredos presentes no Vault (esperado: 2 linhas):
--   select name from vault.decrypted_secrets
--    where name in ('internal_api_key', 'project_url');
--
-- 4. Disparo manual controlado (só quando autorizado no rollout):
--   select trigger_whatsapp_instance_cycles();
--   select * from net._http_response order by created desc limit 1;
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   drop function if exists public.trigger_whatsapp_instance_cycles();

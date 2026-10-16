-- Agenda a retenção de 30 dias do `webhook_executions`.
--
-- `cleanup_webhook_executions()` existe desde a 026 (e teve a ACL endurecida na
-- 085), mas NENHUMA migration a agendou: a tabela cresceu sem limite desde maio.
-- Além do custo, o volume acumulado por canal fazia o `on delete set null` da FK
-- estourar o statement_timeout do PostgREST ao remover um canal — ver a
-- migration anterior (20261016140000), que resolve a remoção por lotes.
--
-- ESTA MIGRATION SÓ AGENDA, separada da anterior pela mesma razão da 113/114:
-- o harness local de pré-voo roda sem pg_cron, e a RPC precisa ser exercitada
-- lá sem depender do agendamento.
--
-- O job é SQL puro, sem HTTP: não usa pg_net, Vault nem URL de projeto. Roda
-- como o dono do job (postgres), fora do PostgREST, então o statement_timeout
-- de 8 s do `authenticator` não se aplica. 06:40 UTC (03:40 BRT) evita os
-- horários cheios dos outros workers.

create extension if not exists pg_cron;

-- Idempotência pelo idioma da 114: desagenda por jobid, sem engolir erro.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'cleanup-webhook-executions';
end;
$$;

select cron.schedule(
  'cleanup-webhook-executions',
  '40 6 * * *',
  $$select public.cleanup_webhook_executions();$$
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, '40 6 * * *', active = true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'cleanup-webhook-executions';
--
-- 2. Depois da primeira execução (esperado: succeeded e 0 linhas antigas):
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'cleanup-webhook-executions')
--    order by start_time desc limit 3;
--   select count(*) from webhook_executions where created_at < now() - interval '30 days';
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   select cron.unschedule('cleanup-webhook-executions');

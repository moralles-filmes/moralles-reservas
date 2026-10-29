-- Instagram, Fase 1 (Task 1.5): agendamento dos três jobs do módulo.
--
-- Spec:  docs/superpowers/specs/2026-10-19-instagram-modulo-design.md
-- Plano: docs/superpowers/plans/2026-10-20-instagram-fase-1-direct-conversas.md
--        (Task 1.5)
-- Gêmeo: src/lib/instagram-queue-migration-twin.test.ts confere, como texto,
--        nomes, expressões, comandos e o desagendamento defensivo; a varredura
--        é presa a `INBOUND_SWEEP_INTERVAL_MS` (60_000 → a cada minuto).
--        O pré-voo 79 não roda este arquivo: o harness não tem pg_cron.
--
-- ESTA MIGRATION SÓ AGENDA. Os wrappers `trigger_instagram_inbound_sweep()` e
-- `trigger_instagram_token_refresh()` e as purgas
-- `purge_instagram_inbound_events()` / `purge_instagram_processed_messages()`
-- foram criados na 20261029200200 (Task 1.3). Os wrappers leem `project_url` E
-- `internal_api_key` do Vault, fail-closed: faltando qualquer um, avisam e
-- voltam sem POST. Por isso NÃO há URL de projeto nem segredo aqui; o
-- guardrail scripts/migration-static-guard.test.ts reprova quem regredir.
--
-- ORDEM DO BLOCO 6: `db push` -> segredos -> deploy das Edge Functions
-- (`process-instagram-inbound`, `process-instagram-token-refresh`). Entre o
-- push e o deploy, o POST da varredura (a cada minuto) e o do refresh (uma vez
-- ao dia) recebem 404, todo ciclo. É inofensivo — nenhuma unidade tem o grant
-- do módulo e a fila está vazia, então não há o que processar nem token a
-- renovar —, mas é ruído em `net._http_response`: as EFs devem ser publicadas
-- logo depois do push. A purga é SQL puro e não depende das EFs.
--
-- `pg_cron` NÃO PULA EXECUÇÕES SOBREPOSTAS. Uma varredura que passe de um
-- minuto convive com a seguinte; quem torna isso seguro é o claim POR LINHA da
-- 20261029200200 (`claim_instagram_inbound_event`, `claim_instagram_message`),
-- não o agendamento. `timeout_milliseconds` do `pg_net` (30 s, nos wrappers)
-- encerra a ESPERA pelo POST, não a execução da Edge Function.
--
-- Os três jobs:
--   instagram-inbound-sweep  a cada minuto  -> trigger_instagram_inbound_sweep()
--   instagram-token-refresh  09:40 UTC      -> trigger_instagram_token_refresh()
--   instagram-inbound-purge  04:17 UTC      -> as duas purgas, em SQL (fila:
--                                              done 7d/dead 30d; ledger: 30d)
--
-- A purga chama as duas funções num ÚNICO statement: se a primeira levantar
-- erro, a segunda não roda naquele dia (aceito; é o que o plano pede). A
-- próxima execução tenta de novo no dia seguinte, e as janelas são de dias.
--
-- Idempotência: cada job é desagendado por `jobid` antes de ser agendado
-- (padrão da 114): `perform ... from cron.job` age sobre 0..N linhas e não
-- levanta exceção quando o job não existe, então não há `exception when
-- others` engolindo um erro de permissão real. O `do $$ ... $$` é obrigatório:
-- `perform` é plpgsql.

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'instagram-inbound-sweep';
  perform cron.unschedule(jobid) from cron.job where jobname = 'instagram-token-refresh';
  perform cron.unschedule(jobid) from cron.job where jobname = 'instagram-inbound-purge';
end;
$$;

select cron.schedule(
  'instagram-inbound-sweep',
  '*/1 * * * *',
  $$select public.trigger_instagram_inbound_sweep();$$
);

select cron.schedule(
  'instagram-token-refresh',
  '40 9 * * *',
  $$select public.trigger_instagram_token_refresh();$$
);

select cron.schedule(
  'instagram-inbound-purge',
  '17 4 * * *',
  $$select public.purge_instagram_inbound_events(), public.purge_instagram_processed_messages();$$
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Três jobs, um de cada (esperado: 3 linhas, active = true):
--   select jobname, schedule, command, active from cron.job
--    where jobname like 'instagram-%' order by jobname;
--
-- 2. A conferência dos wrappers é `net._http_response`, NÃO
--    `cron.job_run_details` (`succeeded` ali só diz que o `pg_net` aceitou o
--    POST). Antes do deploy das EFs: 404; depois: 200.
--   select status_code, content, created
--     from net._http_response order by created desc limit 5;
--
-- 3. A purga (SQL puro) aparece em `cron.job_run_details` com `succeeded`.
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Desagendar é seguro e reversível a qualquer momento:
--   select cron.unschedule('instagram-inbound-sweep');
--   select cron.unschedule('instagram-token-refresh');
--   select cron.unschedule('instagram-inbound-purge');
-- Desagende ANTES de remover os wrappers ou as purgas, senão o cron dispara
-- contra função inexistente.

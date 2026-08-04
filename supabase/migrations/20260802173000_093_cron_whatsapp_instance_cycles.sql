-- Agendamento do worker de ciclos da instância Z-API (Fase 6b, passo 20).
--
-- ESTA MIGRATION SÓ AGENDA. A função `trigger_whatsapp_instance_cycles()` foi
-- criada na 092 e lê `project_url` E `internal_api_key` do Vault, com
-- comportamento fail-closed: faltando qualquer um dos dois ela avisa e retorna
-- sem fazer POST. Por isso NÃO há URL de projeto aqui — diferente das treze
-- migrations legadas, que embutem o host e fariam um banco reconstruído
-- agendar cron apontando para PRODUÇÃO. O guardrail
-- scripts/migration-static-guard.test.ts reprova quem regredir.
--
-- POR QUE SEPARADA DA 092: `db push` aplica tudo que está pendente. Com o
-- `cron.schedule` dentro da 092, o cron nasceria no mesmo push das tabelas,
-- antes de qualquer execução manual sob observação. A separação é o que
-- permitiu exercitar o worker cinco vezes em produção, com inventário vazio,
-- antes de deixá-lo rodar sozinho — e foi assim que a divergência
-- CHANNEL_WITHOUT_INSTANCE do canal existente apareceu, sem automação ligada.
--
-- Schedule: diário 12:10 UTC. O deslocamento de 10 minutos é deliberado —
-- 12:00 UTC é `process-voucher-triggers`, e os dois leem `platform_flags` e
-- escrevem em `billing_notifications`. Vizinhos do dia: 03h trial-expiry, 04h
-- de domingo cleanup-orphan-assets, 06h billing-reconcile, 07h asaas-reconcile,
-- 08h asaas-invoice-reconcile, 10h billing-overdue, 11h whatsapp-enforcement,
-- 12h voucher-triggers, 12h10 (este), 13h reservation-reminders e
-- billing-reminders, 17h satisfaction-surveys. Os jobs de minuto
-- (notification-outbox */1, expire-pending-payments */2, billing-unblock */5,
-- billing-notifications */5) disparam a toda hora e não colidem por definição.
--
-- O QUE ESTE CRON NÃO FAZ: não chama a Z-API, não envia mensagem, não bloqueia
-- ninguém, não altera entitlement nem `organizations.billing_status`. Ele rola
-- ciclo, registra alerta no ledger e enfileira aviso administrativo. Com
-- `billing_notifications_dispatch` OFF — o estado previsto da fase — a fila
-- acumula e nenhum e-mail sai.

create extension if not exists pg_cron;

-- Idempotência: reagendar sem remover antes duplicaria o job.
do $$
begin
  perform cron.unschedule('whatsapp-instance-cycles');
exception when others then null;
end $$;

select cron.schedule(
  'whatsapp-instance-cycles',
  '10 12 * * *',
  'select trigger_whatsapp_instance_cycles();'
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, '10 12 * * *', active = true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'whatsapp-instance-cycles';
--
-- 2. Nenhum job duplicado com o mesmo nome (esperado: 1):
--   select count(*) from cron.job where jobname = 'whatsapp-instance-cycles';
--
-- 3. Depois da primeira execução automática (12:10 UTC do dia seguinte):
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'whatsapp-instance-cycles')
--    order by start_time desc limit 5;
--   -- ATENÇÃO: `status = succeeded` aqui significa que o pg_net ACEITOU o POST,
--   -- não que a Edge Function respondeu 200. A resposta real está em
--   -- net._http_response — pg_net é fire-and-forget.
--
-- 4. O ledger NÃO deve ganhar linha nova por execução repetida no mesmo mês:
--   select alert_type, dedupe_key, occurrences, first_detected_at, last_seen_at
--     from whatsapp_instance_alerts order by first_detected_at desc;
--
-- =====================================================================
-- Rollback
-- =====================================================================
-- Desagendar é seguro e reversível a qualquer momento — o inventário e o
-- ledger continuam intactos, só param de ser atualizados:
--   select cron.unschedule('whatsapp-instance-cycles');
--
-- A remoção da FUNÇÃO é degrau da 092, e a ordem inversa completa da fase
-- (092 -> 090 -> 089 -> 088 -> 087) está publicada na 088. Desagende ANTES de
-- remover a função, senão o cron dispara contra função inexistente.

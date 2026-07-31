-- Worker pg_cron: process-asaas-invoice-reconcile (Fase 5b, Task 11).
-- Mesmo padrão de 20260716140000_064_process_asaas_reconcile_cron.sql:
-- pg_cron -> wrapper SECURITY DEFINER -> pg_net.http_post com
-- internal_api_key do Vault -> Edge Function.
--
-- Reconcilia as cobranças do Asaas de CADA assinatura viva contra
-- billing_invoices: cria a fatura que falta (webhook perdido ou ingestão
-- ligada depois da cobrança já existir no provedor), liquida fatura 'open'
-- já paga lá, e retém fatura com valor divergente para revisão humana. Nunca
-- cria cobrança/assinatura no Asaas (só leitura contra o provedor). Escopo
-- exato no header de supabase/functions/process-asaas-invoice-reconcile/index.ts.
--
-- Schedule: diário 08:00 UTC (05:00 BRT) — horário livre na grade de workers
-- (tabela "Workers automáticos" do CLAUDE.md), escolhido para não colidir com
-- process-asaas-reconcile (07:00 UTC) nem com process-billing-overdue
-- (10:00 UTC). Vizinhos: 03h trial-expiry, 04h de domingo
-- cleanup-orphan-assets, 06h billing-reconcile, 07h asaas-reconcile, 10h
-- billing-overdue, 12h voucher-triggers, 13h reservation-reminders/
-- billing-reminders, 17h satisfaction-surveys. Os jobs de minuto
-- (notification-outbox */1, expire-pending-payments */2, billing-unblock
-- */5, billing-notifications */5) disparam todo hora de qualquer forma — não
-- colidem por definição.

create extension if not exists pg_cron;

create or replace function trigger_asaas_invoice_reconcile()
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
    raise notice '[asaas-invoice-reconcile] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-asaas-invoice-reconcile',
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
  perform cron.unschedule('asaas-invoice-reconcile');
exception when others then null;
end $$;

select cron.schedule(
  'asaas-invoice-reconcile',
  '0 8 * * *',
  'select trigger_asaas_invoice_reconcile();'
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, schedule '0 8 * * *', active=true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'asaas-invoice-reconcile';
--
-- 2. Disparo manual (com internal_api_key configurada no Vault):
--   select trigger_asaas_invoice_reconcile();
--   -- depois: select * from net._http_response order by created desc limit 1;
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   select cron.unschedule('asaas-invoice-reconcile');
--   drop function if exists trigger_asaas_invoice_reconcile();

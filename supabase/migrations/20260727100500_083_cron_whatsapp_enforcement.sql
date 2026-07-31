-- Worker pg_cron: process-whatsapp-enforcement (Fase 5b, Task 17).
-- Mesmo padrão de 20260727100400_082_cron_asaas_invoice_reconcile.sql:
-- pg_cron -> wrapper SECURITY DEFINER -> pg_net.http_post com
-- internal_api_key do Vault -> Edge Function.
--
-- Suspende (billing_subscriptions.status='unpaid') e restaura (volta a
-- 'active') a assinatura WHATSAPP_SUBSCRIPTION de cada organização por
-- inadimplência da mensalidade da INSTÂNCIA — nunca escreve
-- organizations.billing_status (isso é acesso ao SISTEMA, categoria
-- diferente) nem organization_entitlement_overrides (override é ação
-- administrativa). Gateado por whatsapp_service_enforcement: flag OFF calcula
-- tudo e não escreve nada (dry-run com telemetria). Escopo exato no header de
-- supabase/functions/process-whatsapp-enforcement/index.ts.
--
-- Schedule: diário 11:00 UTC — DEPOIS de process-billing-overdue (10:00 UTC),
-- para que a escada de inadimplência do SISTEMA já tenha rodado no mesmo dia
-- antes de avaliar a instância de WhatsApp. Vizinhos: 03h trial-expiry, 04h de
-- domingo cleanup-orphan-assets, 06h billing-reconcile, 07h asaas-reconcile,
-- 08h asaas-invoice-reconcile, 10h billing-overdue, 11h (este), 12h
-- voucher-triggers, 13h reservation-reminders/billing-reminders, 17h
-- satisfaction-surveys. Os jobs de minuto (notification-outbox */1,
-- expire-pending-payments */2, billing-unblock */5, billing-notifications
-- */5) disparam toda hora de qualquer forma — não colidem por definição.

create extension if not exists pg_cron;

create or replace function trigger_whatsapp_enforcement()
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
    raise notice '[whatsapp-enforcement] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-whatsapp-enforcement',
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
  perform cron.unschedule('whatsapp-enforcement');
exception when others then null;
end $$;

select cron.schedule(
  'whatsapp-enforcement',
  '0 11 * * *',
  'select trigger_whatsapp_enforcement();'
);

-- =====================================================================
-- Validação pós-migration
-- =====================================================================
-- 1. Job agendado (esperado: 1 linha, schedule '0 11 * * *', active=true):
--   select jobname, schedule, active from cron.job
--    where jobname = 'whatsapp-enforcement';
--
-- 2. Disparo manual (com internal_api_key configurada no Vault):
--   select trigger_whatsapp_enforcement();
--   -- depois: select * from net._http_response order by created desc limit 1;
--
-- =====================================================================
-- Rollback
-- =====================================================================
--   select cron.unschedule('whatsapp-enforcement');
--   drop function if exists trigger_whatsapp_enforcement();

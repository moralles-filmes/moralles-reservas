-- Worker pg_cron: process-asaas-reconcile (Fase 2 billing-asaas, Task 5).
-- Mesmo padrão de supabase/migrations/20260528010000_billing_crons.sql:
-- pg_cron -> wrapper SECURITY DEFINER -> pg_net.http_post com
-- internal_api_key do Vault -> Edge Function.
--
-- Reprocessa billing_events (provider='asaas') presos em 'received'/'failed'
-- que o asaas-webhook (Task 4) deixa pra trás quando o processamento estoura
-- ou o isolate morre no meio. Escopo exato (só reclassifica known/unknown,
-- nada de ativar assinatura/billing_status) no header de
-- supabase/functions/process-asaas-reconcile/index.ts.
--
-- Schedule: diário 07:00 UTC (04:00 BRT) — horário livre na grade de workers
-- (tabela "Workers automáticos" do CLAUDE.md): nenhum outro job diário usa a
-- hora 7 (vizinhos: 03h trial-expiry, 04h de domingo cleanup-orphan-assets,
-- 06h billing-reconcile, 10h billing-overdue, 12h voucher-triggers, 13h
-- reservation-reminders/billing-reminders, 17h satisfaction-surveys). Os
-- jobs de minuto (notification-outbox */1, expire-pending-payments */2,
-- billing-unblock */5) disparam todo hora de qualquer forma — não colidem
-- por definição.

create extension if not exists pg_cron;

create or replace function trigger_asaas_reconcile()
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
    raise notice '[asaas-reconcile] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-asaas-reconcile',
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
  perform cron.unschedule('asaas-reconcile');
exception when others then null;
end $$;

select cron.schedule(
  'asaas-reconcile',
  '0 7 * * *',
  'select trigger_asaas_reconcile();'
);

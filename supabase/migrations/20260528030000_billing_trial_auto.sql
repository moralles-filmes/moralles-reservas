-- Trial automático ao criar empresa + bloqueio quando vencer.
--
-- Adiciona em billing_plans:
--   - is_trial → marca o plano "trial automático" aplicado a todo cliente novo.
--
-- UNIQUE PARTIAL: máximo 1 plano com is_trial=true AND active=true por vez
-- (caso contrário manage-organizations não saberia qual escolher).
--
-- Schedule pg_cron novo: process-trial-expiry diário às 03:00 UTC. Worker
-- move orgs com trial vencido sem subscription paga pra billing_status=blocked.

begin;

-- =====================================================================
-- PART 1 — Coluna is_trial
-- =====================================================================

alter table billing_plans
  add column if not exists is_trial boolean not null default false;

comment on column billing_plans.is_trial is
  'Marca o plano como trial automático aplicado a toda nova organization criada via manage-organizations.create_organization. Cliente NUNCA escolhe esse plano manualmente — PricingTable.tsx filtra. Máximo 1 ativo por vez (UNIQUE PARTIAL).';

-- =====================================================================
-- PART 2 — UNIQUE PARTIAL (só 1 plano trial ativo)
-- =====================================================================

create unique index if not exists billing_plans_only_one_active_trial
  on billing_plans ((is_trial))
  where is_trial = true and active = true;

-- =====================================================================
-- PART 3 — Wrapper PL/pgSQL pro cron de trial expiry
-- Mesmo padrão dos outros workers de billing (security definer + vault)
-- =====================================================================

create or replace function trigger_billing_trial_expiry()
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
    raise notice '[billing-trial-expiry] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-trial-expiry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- =====================================================================
-- PART 4 — pg_cron schedule
-- Diário às 03:00 UTC (00:00 BRT — antes do horário comercial brasileiro)
-- =====================================================================

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('billing-trial-expiry');
exception when others then null;
end $$;

select cron.schedule(
  'billing-trial-expiry',
  '0 3 * * *',
  'select trigger_billing_trial_expiry();'
);

commit;

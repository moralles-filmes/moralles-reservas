-- Workers pg_cron para billing.
-- Padrão: pg_cron → wrapper SECURITY DEFINER → pg_net.http_post com
-- internal_api_key do Vault → Edge Function.
--
-- 1. process-billing-overdue     — diário 10:00 UTC (07:00 BRT)
-- 2. process-billing-reminders   — diário 13:00 UTC (10:00 BRT)
-- 3. process-billing-reconcile   — diário 06:00 UTC (03:00 BRT)
-- 4. process-billing-unblock     — a cada 5 minutos

create extension if not exists pg_cron;

-- ── 1. Overdue ────────────────────────────────────────────────────────────────

create or replace function trigger_billing_overdue()
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
    raise notice '[billing-overdue] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-overdue',
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
  perform cron.unschedule('billing-overdue');
exception when others then null;
end $$;

select cron.schedule(
  'billing-overdue',
  '0 10 * * *',
  'select trigger_billing_overdue();'
);

-- ── 2. Reminders ──────────────────────────────────────────────────────────────

create or replace function trigger_billing_reminders()
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
    raise notice '[billing-reminders] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-reminders',
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
  perform cron.unschedule('billing-reminders');
exception when others then null;
end $$;

select cron.schedule(
  'billing-reminders',
  '0 13 * * *',
  'select trigger_billing_reminders();'
);

-- ── 3. Reconcile ──────────────────────────────────────────────────────────────

create or replace function trigger_billing_reconcile()
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
    raise notice '[billing-reconcile] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

do $$
begin
  perform cron.unschedule('billing-reconcile');
exception when others then null;
end $$;

select cron.schedule(
  'billing-reconcile',
  '0 6 * * *',
  'select trigger_billing_reconcile();'
);

-- ── 4. Unblock ────────────────────────────────────────────────────────────────

create or replace function trigger_billing_unblock()
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
    raise notice '[billing-unblock] internal_api_key ausente no Vault — skip';
    return;
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-billing-unblock',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', api_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
end;
$$;

do $$
begin
  perform cron.unschedule('billing-unblock');
exception when others then null;
end $$;

select cron.schedule(
  'billing-unblock',
  '*/5 * * * *',
  'select trigger_billing_unblock();'
);

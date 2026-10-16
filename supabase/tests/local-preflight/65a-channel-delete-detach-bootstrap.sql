-- Disposable PostgreSQL only. Never run on Supabase/project database.
-- Mínimo que a migration 20261016140000 referencia: papéis, canais e as duas
-- tabelas com FK `on delete set null` para o canal. `webhook_executions` nasce
-- com FORCE RLS e sem policy, como em produção (026).
create role anon;
create role authenticated;
create role service_role bypassrls;

create table public.units(id uuid primary key);
create table public.whatsapp_channels(
  id uuid primary key,
  unit_id uuid not null references public.units(id)
);
create table public.webhook_executions(
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references public.whatsapp_channels(id) on delete set null,
  outcome text not null default 'success',
  created_at timestamptz not null default now()
);
alter table public.webhook_executions enable row level security;
alter table public.webhook_executions force row level security;
create table public.notifications_sent(
  id uuid primary key default gen_random_uuid(),
  whatsapp_channel_id uuid references public.whatsapp_channels(id) on delete set null,
  sent_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz
);

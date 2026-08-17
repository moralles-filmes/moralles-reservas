-- Ambiente mínimo para replay verbatim de 087, 088, 096 e da migration
-- multi-provider/UazAPI. Só o que essas migrations REFERENCIAM. Nada de
-- pg_cron/pg_net (deliberado:
-- migrations legadas embutem a URL de produção nos wrappers de cron).

-- Papéis do Supabase que as migrations citam em revoke/grant e em policies.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists vault;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Stub: sem GUC de request, devolve NULL — suficiente, porque nenhum caso
-- NOTE-A..NOTE-D exercita RLS (isso é NOTE-E, pelo client SDK).
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  name text not null
);

create table if not exists whatsapp_channels (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  provider text not null check (provider in ('zapi', 'waha', 'official')),
  status text not null default 'disconnected'
    check (status in ('connected', 'disconnected', 'error')),
  credentials jsonb not null default '{}'::jsonb,
  webhook_secret text,
  display_phone text,
  last_event_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, provider, display_phone)
);

create table if not exists processed_messages (
  message_id text primary key,
  processed_at timestamptz not null default now(),
  unit_id uuid references units(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome text,
  error text
);

-- Stub legado fiel mínimo para a migration multi-provider: a tabela já existe
-- em produção e a migration só acrescenta sua rota de delivery WhatsApp.
create table if not exists notifications_sent (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid,
  waitlist_id uuid,
  unit_id uuid references units(id) on delete cascade,
  kind text not null,
  status text not null default 'sent',
  error text,
  provider_message_id text,
  sent_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  unique (reservation_id, kind)
);

-- Stub deliberadamente local do Vault. O banco descartável não cifra o valor;
-- serve apenas para provar assinatura, FK e idempotência das RPCs. Produção usa
-- a extensão Vault real, que mantém vault.secrets cifrada em disco.
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace view vault.decrypted_secrets as
select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
from vault.secrets;

create or replace function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default null
)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, new_description)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null
)
returns void
language sql
as $$
  update vault.secrets
  set secret = coalesce(new_secret, secret),
      name = coalesce(new_name, name),
      description = coalesce(new_description, description),
      updated_at = now()
  where id = secret_id;
$$;

create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_platform_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = p_user)
$$;

create or replace function public.update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

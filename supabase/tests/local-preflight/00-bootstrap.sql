-- Ambiente mínimo para replay verbatim de 087, 088 e 096.
-- Só o que as três migrations REFERENCIAM. Nada de pg_cron/pg_net (deliberado:
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
  unit_id uuid references units(id) on delete cascade
);

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

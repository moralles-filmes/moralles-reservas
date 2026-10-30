-- 81a: base do pré-voo 81 (planta do salão: layout e presença).
--
-- Roda num contêiner EXCLUSIVO `public.ecr.aws/supabase/postgres:17.11.0.004`,
-- `--network none`, sem portas, banco `postgres` recém-criado, conectado como
-- `supabase_admin` (só para trocar `auth.uid()`/`auth.role()`); todo o resto
-- roda como `postgres`, que na imagem é como em produção: não superusuário,
-- com BYPASSRLS. Por isso o 81 mede RLS e ACL de verdade, não só trigger.
--
-- Projeta as tabelas no estado de produção ANTES das migrations
-- 20261030120000/120100, conferido por MCP só leitura em 2026-10-30: colunas,
-- CHECKs, FKs, triggers, policies (texto de `pg_policies`), ACL de tabela,
-- `app_private` sem USAGE para anon/authenticated e os helpers na forma real.
-- Não reaplicar: cria tudo uma vez (o 81 roda em transação desfeita).

-- ─── auth.*: forma de produção (lê `claim.*` e cai para `request.jwt.claims`) ──
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

set role postgres;
\set ON_ERROR_STOP on
begin;

-- ─── Tenancy mínima ──────────────────────────────────────────────────────────
create table public.organizations (id uuid primary key, name text not null);
create table public.units (
  id uuid primary key, organization_id uuid not null references public.organizations(id),
  name text not null, slug text not null, timezone text not null default 'America/Sao_Paulo');
create table public.unit_members (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  unit_id uuid not null references public.units(id) on delete cascade,
  role text not null default 'operador', unique (user_id, unit_id));
create table public.platform_admins (user_id uuid primary key);

-- ─── app_private: ACL de produção (só postgres e service_role têm USAGE) ─────
create schema app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to service_role;

create function app_private.is_unit_member(p_user_id uuid, p_unit_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from unit_members where user_id = p_user_id and unit_id = p_unit_id);
$$;
create function app_private.is_platform_admin(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = p_user_id);
$$;
revoke all on function app_private.is_unit_member(uuid, uuid) from public;
revoke all on function app_private.is_platform_admin(uuid) from public;
grant execute on function app_private.is_unit_member(uuid, uuid) to anon, authenticated, service_role;
grant execute on function app_private.is_platform_admin(uuid) to authenticated, service_role;

-- ─── halls e tables no estado de produção ────────────────────────────────────
create table public.halls (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null, description text, active boolean not null default true,
  allow_empty_seat boolean not null default false, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint halls_unit_id_name_key unique (unit_id, name));
create index halls_unit_idx on public.halls (unit_id);

create table public.tables (
  id uuid primary key default gen_random_uuid(),
  number integer not null, capacity integer not null,
  location text not null default 'internal', active boolean not null default true,
  unit_id uuid not null, hall_id uuid,
  min_capacity integer not null, max_capacity integer not null,
  constraint tables_capacity_range check (max_capacity >= min_capacity and min_capacity > 0),
  constraint tables_hall_id_fkey foreign key (hall_id) references public.halls(id) on delete set null,
  constraint tables_location_check check (location = any (array['internal', 'external'])),
  constraint tables_unit_id_fk foreign key (unit_id) references public.units(id) on delete restrict,
  constraint tables_unit_number_unique unique (unit_id, number));
create index tables_hall_idx on public.tables (hall_id);

create function public.set_halls_updated_at() returns trigger language plpgsql
set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger halls_updated_at before update on public.halls
  for each row execute function public.set_halls_updated_at();

create function public.sync_table_capacity() returns trigger language plpgsql
set search_path = public as $$
begin
  new.capacity := new.max_capacity;
  return new;
end
$$;
create trigger tables_sync_capacity before insert or update of min_capacity, max_capacity
  on public.tables for each row execute function public.sync_table_capacity();

alter table public.halls enable row level security;
alter table public.tables enable row level security;
create policy platform_admin_all_halls on public.halls for all to authenticated
  using (app_private.is_platform_admin(auth.uid())) with check (app_private.is_platform_admin(auth.uid()));
create policy unit_member_all_halls on public.halls for all to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id)) with check (app_private.is_unit_member(auth.uid(), unit_id));
create policy platform_admin_all_tables on public.tables for all to authenticated
  using (app_private.is_platform_admin(auth.uid())) with check (app_private.is_platform_admin(auth.uid()));
create policy unit_member_all_tables on public.tables for all to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id)) with check (app_private.is_unit_member(auth.uid(), unit_id));

grant all on table public.halls, public.tables to anon, authenticated, service_role;

-- ─── Fixtures (UUIDs a0d81000-…) ─────────────────────────────────────────────
-- Unidade A (…aa): owner …a1, gerente …a2, operador …a3. Unidade B (…bb):
-- gerente …b2. Outsider …e1 sem membership. Platform_admin …c1 sem membership.
-- Salões: S1 (…01) e S2 (…02) em A; SB (…03) em B. Mesas: T11, T12, T13 em S1;
-- T21 em S2; TB1 em B.
insert into public.organizations (id, name) values
  ('a0d81000-0000-4000-8000-00000000000a', 'planta81 org');
insert into public.units (id, organization_id, name, slug) values
  ('a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-00000000000a', 'planta81 A', 'planta81-a'),
  ('a0d81000-0000-4000-8000-0000000000bb', 'a0d81000-0000-4000-8000-00000000000a', 'planta81 B', 'planta81-b');
insert into public.unit_members (user_id, unit_id, role) values
  ('a0d81000-0000-4000-8000-0000000000a1', 'a0d81000-0000-4000-8000-0000000000aa', 'owner'),
  ('a0d81000-0000-4000-8000-0000000000a2', 'a0d81000-0000-4000-8000-0000000000aa', 'gerente'),
  ('a0d81000-0000-4000-8000-0000000000a3', 'a0d81000-0000-4000-8000-0000000000aa', 'operador'),
  ('a0d81000-0000-4000-8000-0000000000b2', 'a0d81000-0000-4000-8000-0000000000bb', 'gerente');
insert into public.platform_admins (user_id) values ('a0d81000-0000-4000-8000-0000000000c1');

-- Revisão inicial no passado: o 81 roda numa transação só, com now() fixo.
insert into public.halls (id, unit_id, name, updated_at) values
  ('a0d81000-0000-4000-8000-000000000001', 'a0d81000-0000-4000-8000-0000000000aa', 'S1', '2026-01-01 12:00:00+00'),
  ('a0d81000-0000-4000-8000-000000000002', 'a0d81000-0000-4000-8000-0000000000aa', 'S2', '2026-01-01 12:00:00+00'),
  ('a0d81000-0000-4000-8000-000000000003', 'a0d81000-0000-4000-8000-0000000000bb', 'SB', '2026-01-01 12:00:00+00');

insert into public.tables (id, number, capacity, unit_id, hall_id, min_capacity, max_capacity) values
  ('a0d81000-0000-4000-8000-000000000011', 11, 4, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000001', 1, 4),
  ('a0d81000-0000-4000-8000-000000000012', 12, 4, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000001', 1, 4),
  ('a0d81000-0000-4000-8000-000000000013', 13, 2, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000001', 1, 2),
  ('a0d81000-0000-4000-8000-000000000021', 21, 6, 'a0d81000-0000-4000-8000-0000000000aa', 'a0d81000-0000-4000-8000-000000000002', 2, 6),
  ('a0d81000-0000-4000-8000-000000000031', 31, 4, 'a0d81000-0000-4000-8000-0000000000bb', 'a0d81000-0000-4000-8000-000000000003', 1, 4);

commit;

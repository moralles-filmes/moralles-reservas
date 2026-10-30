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

-- ═══ Presença (Task 2): reservations, waitlist, walk_ins ═════════════════════
-- Fora da projeção: audit_trigger_func e enqueue_confirmation (AFTER, não
-- mudam a linha) e dispatch_waitlist_entered (AFTER INSERT).
alter table public.organizations add column is_public boolean not null default true;
alter table public.units add column is_public boolean not null default true;
grant select (id, is_public, organization_id) on public.units to anon;
grant select (id, is_public) on public.organizations to anon;

create table public.customers (
  id uuid primary key, organization_id uuid not null references public.organizations(id), name text not null);

create function public.update_updated_at() returns trigger language plpgsql
set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  table_id uuid references public.tables(id) on delete set null,
  date date not null, time time not null, party_size integer not null,
  status text not null default 'pending', notes text,
  reservation_code text not null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unit_id uuid not null references public.units(id) on delete restrict,
  cancelled_at timestamptz,
  constraint reservations_party_size_check check (party_size >= 1),
  constraint reservations_status_check check (status = any (array['pending', 'confirmed', 'cancelled', 'no_show'])));

create function public.enforce_operador_no_cancel() returns trigger language plpgsql
security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  -- Só interessa a transição PARA 'cancelled' iniciada por usuário do painel.
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and v_uid is not null then

    select role into v_role
    from unit_members
    where user_id = v_uid and unit_id = new.unit_id;

    if v_role = 'operador' then
      raise exception 'operador_cannot_cancel'
        using hint = 'Apenas gerente ou proprietário podem cancelar reservas.';
    end if;
  end if;

  return new;
end;
$$;
create function app_private.stamp_reservation_cancelled_at() returns trigger language plpgsql
set search_path = '' as $$
begin
  if new.status = 'cancelled' then
    if tg_op = 'INSERT' or old.status is distinct from 'cancelled' then
      new.cancelled_at := clock_timestamp();
    else
      new.cancelled_at := old.cancelled_at;
    end if;
  else
    new.cancelled_at := null;
  end if;
  return new;
end;
$$;
create trigger reservations_updated_at before update on public.reservations
  for each row execute function public.update_updated_at();
create trigger trg_enforce_operador_no_cancel before update on public.reservations
  for each row execute function public.enforce_operador_no_cancel();
create trigger trg_stamp_reservation_cancelled_at before insert or update on public.reservations
  for each row execute function app_private.stamp_reservation_cancelled_at();

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null, customer_phone text, party_size integer not null,
  requested_for_time time, priority integer not null default 0,
  status text not null default 'waiting', notes text, notified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  code integer, priority_category text not null default 'normal',
  seated_at timestamptz, notified_server_at timestamptz,
  constraint waitlist_party_size_check check (party_size >= 1),
  constraint waitlist_priority_category_check check (priority_category = any (array['normal', 'senior', 'pregnant', 'disabled', 'other'])),
  constraint waitlist_status_check check (status = any (array['waiting', 'notified', 'seated', 'cancelled'])));

create function public.set_waitlist_seated_at() returns trigger language plpgsql
set search_path = pg_catalog as $$
begin
  if new.status = 'seated' and (old.status is null or old.status <> 'seated')
     and new.seated_at is null then
    new.seated_at := now();
  end if;
  return new;
end;
$$;
create function public.validate_waitlist_status_transition() returns trigger language plpgsql
set search_path = pg_catalog as $$
begin
  -- No-op (mesmo status) é sempre permitido.
  if new.status = old.status then
    return new;
  end if;

  -- Matriz de transições válidas
  if old.status = 'waiting' and new.status in ('notified','seated','cancelled') then
    return new;
  end if;

  if old.status = 'notified' and new.status in ('seated','cancelled','waiting') then
    -- waiting permitido pra desfazer notificação enviada por engano
    return new;
  end if;

  -- Qualquer outra transição é proibida (seated → *, cancelled → *)
  raise exception 'invalid_waitlist_status_transition: % -> %', old.status, new.status
    using errcode = '23514';
end;
$$;
create function public.set_waitlist_notification_fact() returns trigger language plpgsql
set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.notified_at := null;
    new.notified_server_at := null;
  elsif old.status = 'waiting' and new.status = 'notified' then
    new.notified_at := clock_timestamp();
    new.notified_server_at := new.notified_at;
  elsif old.status = 'notified' and new.status = 'waiting' then
    new.notified_at := null;
    new.notified_server_at := null;
  else
    new.notified_at := old.notified_at;
    new.notified_server_at := old.notified_server_at;
  end if;
  return new;
end $$;
create function public.set_waitlist_priority_from_category() returns trigger language plpgsql
set search_path = pg_catalog as $$
begin
  if new.priority_category = 'normal' then
    new.priority := 0;
  else
    new.priority := -10;
  end if;
  return new;
end;
$$;
create trigger waitlist_priority_from_category before insert or update of priority_category on public.waitlist
  for each row execute function public.set_waitlist_priority_from_category();
create trigger waitlist_set_notification_fact before insert or update on public.waitlist
  for each row execute function public.set_waitlist_notification_fact();
create trigger waitlist_set_seated_at before update of status on public.waitlist
  for each row execute function public.set_waitlist_seated_at();
create trigger waitlist_updated_at before update on public.waitlist
  for each row execute function public.update_updated_at();
create trigger waitlist_validate_status_transition before update of status on public.waitlist
  for each row execute function public.validate_waitlist_status_transition();

create table public.walk_ins (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  customer_name text not null, customer_phone text, party_size integer not null,
  table_id uuid references public.tables(id) on delete set null,
  status text not null default 'waiting', notes text,
  arrived_at timestamptz not null default now(), seated_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint walk_ins_party_size_check check (party_size >= 1),
  constraint walk_ins_status_check check (status = any (array['waiting', 'seated', 'left', 'no_show'])));
create trigger walk_ins_updated_at before update on public.walk_ins
  for each row execute function public.update_updated_at();

-- RLS como em produção: reservations e waitlist com FORCE (o dono `postgres`
-- tem BYPASSRLS, como lá); walk_ins sem FORCE e, antes da 120100, sem policy
-- de platform_admin.
alter table public.reservations enable row level security;
alter table public.reservations force row level security;
alter table public.waitlist enable row level security;
alter table public.waitlist force row level security;
alter table public.walk_ins enable row level security;

create policy anon_insert_reservations on public.reservations for insert to anon
  with check (unit_id is not null and exists (
    select 1 from public.units u join public.organizations o on o.id = u.organization_id
     where u.id = reservations.unit_id and u.is_public = true and o.is_public = true));
create policy platform_admin_all_reservations on public.reservations for all to authenticated
  using (app_private.is_platform_admin(auth.uid())) with check (app_private.is_platform_admin(auth.uid()));
create policy unit_member_all_reservations on public.reservations for all to authenticated
  using (app_private.is_unit_member(auth.uid(), unit_id)) with check (app_private.is_unit_member(auth.uid(), unit_id));

create policy platform_admin_all_waitlist on public.waitlist for all to authenticated
  using (app_private.is_platform_admin(auth.uid())) with check (app_private.is_platform_admin(auth.uid()));
create policy waitlist_member_delete on public.waitlist for delete using (app_private.is_unit_member(auth.uid(), unit_id));
create policy waitlist_member_insert on public.waitlist for insert with check (app_private.is_unit_member(auth.uid(), unit_id));
create policy waitlist_member_select on public.waitlist for select using (app_private.is_unit_member(auth.uid(), unit_id));
create policy waitlist_member_update on public.waitlist for update using (app_private.is_unit_member(auth.uid(), unit_id));

create policy walk_ins_member_delete on public.walk_ins for delete using (app_private.is_unit_member(auth.uid(), unit_id));
create policy walk_ins_member_insert on public.walk_ins for insert with check (app_private.is_unit_member(auth.uid(), unit_id));
create policy walk_ins_member_select on public.walk_ins for select using (app_private.is_unit_member(auth.uid(), unit_id));
create policy walk_ins_member_update on public.walk_ins for update using (app_private.is_unit_member(auth.uid(), unit_id));

grant all on table public.reservations, public.walk_ins to anon, authenticated, service_role;
grant all on table public.waitlist to authenticated, service_role;
grant select, update, delete, truncate, references, trigger, maintain on table public.waitlist to anon;
grant select on table public.customers to anon, authenticated, service_role;

-- Fixtures. As datas das reservas são recolocadas em BRT pelo 81 a cada
-- execução (hoje, ontem, amanhã). Status: R1/R7 confirmed, R2 pending,
-- R3 cancelled, R4 no_show, R5 amanhã, R6 ontem; RB na unidade B.
insert into public.customers (id, organization_id, name) values
  ('a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-00000000000a', 'Cliente 81');
insert into public.reservations (id, customer_id, table_id, date, time, party_size, status, reservation_code, unit_id) values
  ('a0d81000-0000-4000-8000-000000000101', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000011', current_date, '20:00', 2, 'confirmed', 'P81-R1', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000102', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000012', current_date, '20:00', 2, 'pending', 'P81-R2', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000103', 'a0d81000-0000-4000-8000-0000000000f1', null, current_date, '20:00', 2, 'cancelled', 'P81-R3', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000104', 'a0d81000-0000-4000-8000-0000000000f1', null, current_date, '20:00', 2, 'no_show', 'P81-R4', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000105', 'a0d81000-0000-4000-8000-0000000000f1', null, current_date, '20:00', 2, 'confirmed', 'P81-R5', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000106', 'a0d81000-0000-4000-8000-0000000000f1', null, current_date, '23:30', 2, 'confirmed', 'P81-R6', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-000000000107', 'a0d81000-0000-4000-8000-0000000000f1', null, current_date, '21:00', 2, 'confirmed', 'P81-R7', 'a0d81000-0000-4000-8000-0000000000aa'),
  ('a0d81000-0000-4000-8000-0000000001b1', 'a0d81000-0000-4000-8000-0000000000f1', 'a0d81000-0000-4000-8000-000000000031', current_date, '20:00', 2, 'confirmed', 'P81-RB', 'a0d81000-0000-4000-8000-0000000000bb');

-- Fila em A: W1 waiting, W2 notified, W3 cancelled, W4 seated; WB em B.
insert into public.waitlist (id, unit_id, customer_name, party_size, status, seated_at) values
  ('a0d81000-0000-4000-8000-000000000201', 'a0d81000-0000-4000-8000-0000000000aa', 'W1', 2, 'waiting', null),
  ('a0d81000-0000-4000-8000-000000000202', 'a0d81000-0000-4000-8000-0000000000aa', 'W2', 2, 'notified', null),
  ('a0d81000-0000-4000-8000-000000000203', 'a0d81000-0000-4000-8000-0000000000aa', 'W3', 2, 'cancelled', null),
  ('a0d81000-0000-4000-8000-000000000204', 'a0d81000-0000-4000-8000-0000000000aa', 'W4', 2, 'seated', now() - interval '30 minutes'),
  ('a0d81000-0000-4000-8000-0000000002b1', 'a0d81000-0000-4000-8000-0000000000bb', 'WB', 2, 'waiting', null);

-- Passantes: P1 sentado em T12 e P2 esperando em A; PB sentado em B.
insert into public.walk_ins (id, unit_id, customer_name, party_size, status, table_id, seated_at) values
  ('a0d81000-0000-4000-8000-000000000301', 'a0d81000-0000-4000-8000-0000000000aa', 'P1', 2, 'seated', 'a0d81000-0000-4000-8000-000000000012', now() - interval '20 minutes'),
  ('a0d81000-0000-4000-8000-000000000302', 'a0d81000-0000-4000-8000-0000000000aa', 'P2', 2, 'waiting', null, null),
  ('a0d81000-0000-4000-8000-0000000003b1', 'a0d81000-0000-4000-8000-0000000000bb', 'PB', 2, 'seated', 'a0d81000-0000-4000-8000-000000000031', now() - interval '20 minutes');

commit;

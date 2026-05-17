-- 013_multi_tenant.sql
-- Transforma o sistema de single-tenant para multi-tenant (organizations → units).
-- Inclui: unit_members, platform_admins, whatsapp_channels.
-- Reescreve toda a RLS e atualiza todas as RPCs.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1 — Novas tabelas de multi-tenancy
-- ═══════════════════════════════════════════════════════════════════════════════

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  plan        text not null default 'free',
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table units (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  name             text not null,
  slug             text not null unique,
  address          jsonb,
  timezone         text not null default 'America/Sao_Paulo',
  is_public        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index units_organization_idx on units(organization_id);

create table unit_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  unit_id     uuid not null references units(id) on delete cascade,
  role        text not null default 'operador'
                check (role in ('owner', 'gerente', 'operador')),
  created_at  timestamptz not null default now(),
  unique (user_id, unit_id)
);

create index unit_members_user_idx on unit_members(user_id);
create index unit_members_unit_idx on unit_members(unit_id);

-- Super admins da plataforma (só visíveis internamente).
create table platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Canais WhatsApp por unidade (Z-API, WAHA, API Oficial).
-- Credentials ficam em JSONB acessível apenas por service_role.
create table whatsapp_channels (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id) on delete cascade,
  provider       text not null check (provider in ('zapi', 'waha', 'official')),
  status         text not null default 'disconnected'
                   check (status in ('connected', 'disconnected', 'error')),
  credentials    jsonb not null default '{}'::jsonb,
  webhook_secret text,
  display_phone  text,
  last_event_at  timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (unit_id, provider, display_phone)
);

create index whatsapp_channels_unit_idx on whatsapp_channels(unit_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 2 — Adicionar colunas de tenant (nullable) nas tabelas existentes
-- ═══════════════════════════════════════════════════════════════════════════════

-- customers → por organização
alter table customers add column if not exists organization_id uuid;

-- as demais → por unidade
alter table tables           add column if not exists unit_id uuid;
alter table reservations     add column if not exists unit_id uuid;
alter table conversations    add column if not exists unit_id uuid;
alter table business_hours   add column if not exists unit_id uuid;
alter table settings         add column if not exists unit_id uuid;
alter table special_dates    add column if not exists unit_id uuid;
alter table notifications_sent add column if not exists unit_id uuid;

-- audit_log recebe ambos (reservations têm unit_id; customers têm organization_id)
alter table audit_log add column if not exists unit_id         uuid;
alter table audit_log add column if not exists organization_id uuid;

-- rate_limit_events → por unidade para isolar o bucket por restaurante
alter table rate_limit_events add column if not exists unit_id uuid;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 3 — Seed: criar org + unidade; migrar dados existentes
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_org_id  uuid;
  v_unit_id uuid;
begin
  -- Organização raiz
  insert into organizations (name, slug)
  values ('Moralles', 'moralles')
  returning id into v_org_id;

  -- Unidade seed
  insert into units (organization_id, name, slug)
  values (v_org_id, 'Moralles Centro', 'moralles-centro')
  returning id into v_unit_id;

  -- Backfill: todas as linhas existentes pertencem à unidade seed
  update customers       set organization_id = v_org_id  where organization_id is null;
  update tables          set unit_id = v_unit_id         where unit_id is null;
  update reservations    set unit_id = v_unit_id         where unit_id is null;
  update conversations   set unit_id = v_unit_id         where unit_id is null;
  update business_hours  set unit_id = v_unit_id         where unit_id is null;
  update settings        set unit_id = v_unit_id         where unit_id is null;
  update special_dates   set unit_id = v_unit_id         where unit_id is null;
  update notifications_sent set unit_id = v_unit_id      where unit_id is null;

  -- audit_log: reservations → unit_id, customers → organization_id
  update audit_log set unit_id = v_unit_id
  where table_name = 'reservations' and unit_id is null;

  update audit_log set organization_id = v_org_id
  where table_name = 'customers' and organization_id is null;

  -- Migrar admin_users → unit_members + platform_admins
  insert into unit_members (user_id, unit_id, role)
  select
    au.id,
    v_unit_id,
    case when au.role = 'super_admin' then 'owner' else 'gerente' end
  from admin_users au
  on conflict (user_id, unit_id) do nothing;

  insert into platform_admins (user_id)
  select id from admin_users where role = 'super_admin'
  on conflict do nothing;

  -- Canal WhatsApp placeholder (desconectado; usuário configura via UI Automação)
  insert into whatsapp_channels (unit_id, provider, status)
  values (v_unit_id, 'zapi', 'disconnected')
  on conflict do nothing;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 4 — NOT NULL nas colunas de tenant recém-preenchidas
-- ═══════════════════════════════════════════════════════════════════════════════

alter table customers        alter column organization_id set not null;
alter table tables           alter column unit_id         set not null;
alter table reservations     alter column unit_id         set not null;
alter table conversations    alter column unit_id         set not null;
alter table business_hours   alter column unit_id         set not null;
alter table settings         alter column unit_id         set not null;
alter table special_dates    alter column unit_id         set not null;
alter table notifications_sent alter column unit_id       set not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 5 — FKs das novas colunas
-- ═══════════════════════════════════════════════════════════════════════════════

alter table customers      add constraint customers_organization_id_fk
  foreign key (organization_id) references organizations(id) on delete restrict;

alter table tables         add constraint tables_unit_id_fk
  foreign key (unit_id) references units(id) on delete restrict;

alter table reservations   add constraint reservations_unit_id_fk
  foreign key (unit_id) references units(id) on delete restrict;

alter table conversations  add constraint conversations_unit_id_fk
  foreign key (unit_id) references units(id) on delete restrict;

alter table business_hours add constraint business_hours_unit_id_fk
  foreign key (unit_id) references units(id) on delete cascade;

alter table settings       add constraint settings_unit_id_fk
  foreign key (unit_id) references units(id) on delete cascade;

alter table special_dates  add constraint special_dates_unit_id_fk
  foreign key (unit_id) references units(id) on delete cascade;

alter table notifications_sent add constraint notifications_sent_unit_id_fk
  foreign key (unit_id) references units(id) on delete restrict;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 6 — Corrigir UNIQUE constraints (global → composta com unit_id/org_id)
-- ═══════════════════════════════════════════════════════════════════════════════

-- customers.phone: era unique global; passa a ser único por organização
alter table customers       drop constraint if exists customers_phone_key;
alter table customers       add  constraint customers_org_phone_unique
  unique (organization_id, phone);

-- tables.number: era unique global; passa a ser único por unidade
alter table tables          drop constraint if exists tables_number_key;
alter table tables          add  constraint tables_unit_number_unique
  unique (unit_id, number);

-- business_hours.day_of_week: era unique global; passa a ser único por unidade
alter table business_hours  drop constraint if exists business_hours_day_of_week_key;
alter table business_hours  add  constraint business_hours_unit_dow_unique
  unique (unit_id, day_of_week);

-- settings.key: era unique global; passa a ser único por unidade
alter table settings        drop constraint if exists settings_key_key;
alter table settings        add  constraint settings_unit_key_unique
  unique (unit_id, key);

-- special_dates.date: era unique global; passa a ser único por unidade
alter table special_dates   drop constraint if exists special_dates_date_key;
alter table special_dates   add  constraint special_dates_unit_date_unique
  unique (unit_id, date);

-- reservation_code permanece UNIQUE global (facilita busca pública por código curto)
-- Obs: se o volume crescer, migrar para (unit_id, reservation_code) numa migration futura.

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 7 — Índices compostos com unit_id na frente
-- ═══════════════════════════════════════════════════════════════════════════════

-- Substituir índices sem unit_id por versões escopadas
drop index if exists reservations_status_date_idx;
drop index if exists reservations_date_time_idx;
drop index if exists reservations_customer_created_idx;
drop index if exists reservations_date_idx;
drop index if exists reservations_status_idx;

create index if not exists reservations_unit_status_date_idx
  on reservations(unit_id, status, date desc);

create index if not exists reservations_unit_date_time_idx
  on reservations(unit_id, date, time);

create index if not exists reservations_unit_customer_idx
  on reservations(unit_id, customer_id);

create index if not exists customers_org_idx
  on customers(organization_id);

create index if not exists conversations_unit_idx
  on conversations(unit_id);

create index if not exists settings_unit_idx
  on settings(unit_id);

create index if not exists special_dates_unit_idx
  on special_dates(unit_id);

create index if not exists notifications_sent_unit_idx
  on notifications_sent(unit_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 8 — RLS: habilitar nas novas tabelas + reescrever todas as políticas
-- ═══════════════════════════════════════════════════════════════════════════════

alter table organizations      enable row level security;
alter table units              enable row level security;
alter table unit_members       enable row level security;
alter table platform_admins    enable row level security;
alter table whatsapp_channels  enable row level security;

-- ── 8.1 Helper functions ─────────────────────────────────────────────────────

create or replace function public.is_platform_admin(p_user_id uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from platform_admins where user_id = p_user_id
  );
$$;

create or replace function public.is_unit_member(p_user_id uuid, p_unit_id uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from unit_members
    where user_id = p_user_id and unit_id = p_unit_id
  );
$$;

create or replace function public.is_org_member(p_user_id uuid, p_org_id uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1
    from unit_members um
    join units u on u.id = um.unit_id
    where um.user_id = p_user_id
      and u.organization_id = p_org_id
  );
$$;

create or replace function public.unit_role(p_user_id uuid, p_unit_id uuid)
returns text
language sql security definer stable
set search_path = public
as $$
  select role from unit_members
  where user_id = p_user_id and unit_id = p_unit_id
  limit 1;
$$;

-- Revoga acesso público (só authenticated pode chamar via PostgREST se necessário)
revoke all on function public.is_platform_admin(uuid)       from public;
revoke all on function public.is_unit_member(uuid, uuid)    from public;
revoke all on function public.is_org_member(uuid, uuid)     from public;
revoke all on function public.unit_role(uuid, uuid)         from public;
grant execute on function public.is_platform_admin(uuid)    to authenticated;
grant execute on function public.is_unit_member(uuid, uuid) to authenticated;
grant execute on function public.is_org_member(uuid, uuid)  to authenticated;
grant execute on function public.unit_role(uuid, uuid)      to authenticated;

-- ── 8.2 organizations ────────────────────────────────────────────────────────

create policy "platform_admin_all_organizations" on organizations
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "org_member_read_organizations" on organizations
  for select to authenticated
  using (is_org_member(auth.uid(), id));

create policy "public_read_organizations" on organizations
  for select to anon
  using (is_public = true);

-- ── 8.3 units ────────────────────────────────────────────────────────────────

create policy "platform_admin_all_units" on units
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_read_units" on units
  for select to authenticated
  using (is_unit_member(auth.uid(), id));

create policy "public_read_units" on units
  for select to anon
  using (is_public = true);

-- ── 8.4 unit_members ─────────────────────────────────────────────────────────

create policy "platform_admin_all_unit_members" on unit_members
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_read_unit_members" on unit_members
  for select to authenticated
  using (is_unit_member(auth.uid(), unit_id));

-- Writes via manage-members Edge Function (service_role bypassa RLS)

-- ── 8.5 platform_admins ──────────────────────────────────────────────────────

create policy "platform_admin_read_platform_admins" on platform_admins
  for select to authenticated
  using (is_platform_admin(auth.uid()));

-- ── 8.6 whatsapp_channels ────────────────────────────────────────────────────

create policy "unit_member_read_channels" on whatsapp_channels
  for select to authenticated
  using (
    is_platform_admin(auth.uid())
    or is_unit_member(auth.uid(), unit_id)
  );

-- Writes via manage-channels Edge Function (service_role)

-- ── 8.7 customers ────────────────────────────────────────────────────────────

-- Remover políticas antigas
drop policy if exists "anon_insert_customers"     on customers;
drop policy if exists "anon_select_own_customer"  on customers;
drop policy if exists "auth_all_customers"        on customers;

create policy "anon_insert_customers" on customers
  for insert to anon
  with check (organization_id is not null);

create policy "platform_admin_all_customers" on customers
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "org_member_all_customers" on customers
  for all to authenticated
  using (is_org_member(auth.uid(), organization_id))
  with check (is_org_member(auth.uid(), organization_id));

-- ── 8.8 reservations ─────────────────────────────────────────────────────────

drop policy if exists "anon_insert_reservation"  on reservations;
drop policy if exists "anon_select_reservation"  on reservations;
drop policy if exists "auth_all_reservations"    on reservations;

create policy "anon_insert_reservations" on reservations
  for insert to anon
  with check (unit_id is not null);

create policy "platform_admin_all_reservations" on reservations
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_reservations" on reservations
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.9 tables ───────────────────────────────────────────────────────────────

drop policy if exists "public_read_tables"  on tables;
drop policy if exists "auth_all_tables"     on tables;

-- Anon pode ler mesas ativas (form público filtra por unit_id)
create policy "anon_read_active_tables" on tables
  for select to anon
  using (active = true);

create policy "platform_admin_all_tables" on tables
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_tables" on tables
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.10 conversations ───────────────────────────────────────────────────────

drop policy if exists "auth_all_conversations" on conversations;

create policy "platform_admin_all_conversations" on conversations
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_conversations" on conversations
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.11 business_hours ──────────────────────────────────────────────────────

drop policy if exists "public_read_hours" on business_hours;
drop policy if exists "auth_all_hours"    on business_hours;

create policy "anon_read_business_hours" on business_hours
  for select to anon
  using (true);

create policy "platform_admin_all_business_hours" on business_hours
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_business_hours" on business_hours
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.12 settings ────────────────────────────────────────────────────────────

drop policy if exists "public_read_settings" on settings;
drop policy if exists "auth_all_settings"    on settings;

create policy "anon_read_settings" on settings
  for select to anon
  using (true);

create policy "platform_admin_all_settings" on settings
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_settings" on settings
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.13 table_blocks ────────────────────────────────────────────────────────

drop policy if exists "auth_all_table_blocks" on table_blocks;

create policy "platform_admin_all_table_blocks" on table_blocks
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

-- Deriva unit_id via tables.unit_id
create policy "unit_member_all_table_blocks" on table_blocks
  for all to authenticated
  using (
    exists (
      select 1 from tables t
      where t.id = table_id
        and is_unit_member(auth.uid(), t.unit_id)
    )
  )
  with check (
    exists (
      select 1 from tables t
      where t.id = table_id
        and is_unit_member(auth.uid(), t.unit_id)
    )
  );

-- ── 8.14 special_dates ───────────────────────────────────────────────────────

drop policy if exists "public_read_special_dates"  on special_dates;
drop policy if exists "auth_all_special_dates"     on special_dates;

create policy "anon_read_special_dates" on special_dates
  for select to anon
  using (true);

create policy "platform_admin_all_special_dates" on special_dates
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

create policy "unit_member_all_special_dates" on special_dates
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ── 8.15 audit_log ───────────────────────────────────────────────────────────

drop policy if exists "auth_select_audit" on audit_log;

create policy "platform_admin_read_audit" on audit_log
  for select to authenticated
  using (is_platform_admin(auth.uid()));

-- Membros de unidade veem audit de reservations da sua unidade
create policy "unit_member_read_audit" on audit_log
  for select to authenticated
  using (
    (unit_id is not null and is_unit_member(auth.uid(), unit_id))
    or (organization_id is not null and is_org_member(auth.uid(), organization_id))
  );

-- ── 8.16 notifications_sent ──────────────────────────────────────────────────

drop policy if exists "auth_read_notifications_sent" on notifications_sent;

create policy "platform_admin_read_notifications_sent" on notifications_sent
  for select to authenticated
  using (is_platform_admin(auth.uid()));

create policy "unit_member_read_notifications_sent" on notifications_sent
  for select to authenticated
  using (is_unit_member(auth.uid(), unit_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 9 — RPCs atualizadas com escopo de unidade
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 9.1 get_reservation_by_code ─────────────────────────────────────────────
-- p_unit_id optional: se informado filtra pelo unit; se null busca globalmente
-- (usado pelo portal público que conhece a unidade pelo slug).

create or replace function public.get_reservation_by_code(
  p_code    text,
  p_unit_id uuid default null
)
returns table (
  id                uuid,
  reservation_code  text,
  date              date,
  time              time,
  party_size        integer,
  status            text,
  notes             text,
  created_at        timestamptz,
  updated_at        timestamptz,
  customer_name     text,
  customer_phone    text,
  customer_email    text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.reservation_code,
    r.date,
    r.time,
    r.party_size,
    r.status,
    r.notes,
    r.created_at,
    r.updated_at,
    c.name,
    c.phone,
    c.email
  from reservations r
  join customers c on c.id = r.customer_id
  where r.reservation_code = upper(p_code)
    and (p_unit_id is null or r.unit_id = p_unit_id)
  limit 1;
$$;

revoke all on function public.get_reservation_by_code(text, uuid) from public;
grant execute on function public.get_reservation_by_code(text, uuid)
  to anon, authenticated;

-- Manter assinatura antiga (sem p_unit_id) para backward-compat durante deploy
-- A versão antiga (text) já não existe como função separada; a nova usa default null.

-- ── 9.2 check_rate_limit ─────────────────────────────────────────────────────
-- Bucket por (phone, unit_id) para isolar rate limiting por restaurante.

create or replace function public.check_rate_limit(
  p_phone          text,
  p_window_seconds integer,
  p_max            integer,
  p_unit_id        uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from rate_limit_events
   where created_at < now() - interval '1 hour';

  select count(*)
    into v_count
    from rate_limit_events
   where phone = p_phone
     and (p_unit_id is null or unit_id = p_unit_id)
     and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max then
    return false;
  end if;

  insert into rate_limit_events(phone, unit_id) values (p_phone, p_unit_id);
  return true;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer, uuid) from public;
revoke execute on function public.check_rate_limit(text, integer, integer, uuid)
  from anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer, uuid)
  to service_role;

-- Manter assinatura antiga (3 args) para backward-compat com N8N workflows existentes
create or replace function public.check_rate_limit(
  p_phone          text,
  p_window_seconds integer,
  p_max            integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.check_rate_limit(p_phone, p_window_seconds, p_max, null);
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public;
revoke execute on function public.check_rate_limit(text, integer, integer)
  from anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer)
  to service_role;

-- ── 9.3 get_customer_stats ───────────────────────────────────────────────────
-- p_unit_id optional: se informado filtra reservas da unidade; se null, total org.

create or replace function public.get_customer_stats(
  p_customer_id uuid,
  p_unit_id     uuid default null
)
returns table (
  total         integer,
  confirmed     integer,
  no_shows      integer,
  cancelled     integer,
  no_show_rate  numeric,
  last_visit    date
)
language sql
security definer
set search_path = public
stable
as $$
  with r as (
    select status, date
      from reservations
     where customer_id = p_customer_id
       and (p_unit_id is null or unit_id = p_unit_id)
  ),
  agg as (
    select
      count(*)::int                                                    as total,
      count(*) filter (where status = 'confirmed')::int               as confirmed,
      count(*) filter (where status = 'no_show')::int                 as no_shows,
      count(*) filter (where status = 'cancelled')::int               as cancelled,
      max(date) filter (where status in ('confirmed', 'no_show'))     as last_visit
    from r
  )
  select
    total,
    confirmed,
    no_shows,
    cancelled,
    case when (confirmed + no_shows) > 0
         then round(no_shows::numeric / (confirmed + no_shows), 3)
         else 0::numeric
    end as no_show_rate,
    last_visit
  from agg;
$$;

revoke all on function public.get_customer_stats(uuid, uuid) from public;
revoke execute on function public.get_customer_stats(uuid, uuid) from anon;
grant execute on function public.get_customer_stats(uuid, uuid) to authenticated;

-- Manter assinatura antiga (1 arg) para backward-compat
create or replace function public.get_customer_stats(p_customer_id uuid)
returns table (
  total         integer,
  confirmed     integer,
  no_shows      integer,
  cancelled     integer,
  no_show_rate  numeric,
  last_visit    date
)
language sql
security definer
set search_path = public
stable
as $$
  select * from public.get_customer_stats(p_customer_id, null);
$$;

revoke all on function public.get_customer_stats(uuid) from public;
revoke execute on function public.get_customer_stats(uuid) from anon;
grant execute on function public.get_customer_stats(uuid) to authenticated;

-- ── 9.4 get_reservations_for_reminder ────────────────────────────────────────

create or replace function public.get_reservations_for_reminder(
  p_target_date date,
  p_unit_id     uuid default null
)
returns table (
  reservation_id    uuid,
  customer_phone    text,
  customer_name     text,
  reservation_time  time,
  party_size        integer,
  code              text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    c.phone,
    c.name,
    r.time,
    r.party_size,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
    and (p_unit_id is null or r.unit_id = p_unit_id)
    and r.status = 'confirmed'
    and c.do_not_contact = false
    and not exists (
      select 1
        from notifications_sent n
       where n.reservation_id = r.id
         and n.kind = 'reminder_d1'
         and n.status = 'sent'
    );
$$;

revoke all on function public.get_reservations_for_reminder(date, uuid) from public;
revoke execute on function public.get_reservations_for_reminder(date, uuid)
  from anon, authenticated;
grant execute on function public.get_reservations_for_reminder(date, uuid)
  to service_role;

-- Backward-compat (1 arg)
create or replace function public.get_reservations_for_reminder(p_target_date date)
returns table (
  reservation_id    uuid,
  customer_phone    text,
  customer_name     text,
  reservation_time  time,
  party_size        integer,
  code              text
)
language sql security definer set search_path = public stable
as $$ select * from public.get_reservations_for_reminder(p_target_date, null); $$;

revoke all on function public.get_reservations_for_reminder(date) from public;
revoke execute on function public.get_reservations_for_reminder(date)
  from anon, authenticated;
grant execute on function public.get_reservations_for_reminder(date) to service_role;

-- ── 9.5 get_reservations_for_survey ─────────────────────────────────────────

create or replace function public.get_reservations_for_survey(
  p_target_date date,
  p_unit_id     uuid default null
)
returns table (
  reservation_id  uuid,
  customer_phone  text,
  customer_name   text,
  code            text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    c.phone,
    c.name,
    r.reservation_code
  from reservations r
  join customers c on c.id = r.customer_id
  where r.date = p_target_date
    and (p_unit_id is null or r.unit_id = p_unit_id)
    and r.status = 'confirmed'
    and c.do_not_contact = false
    and r.satisfaction_rating is null
    and not exists (
      select 1
        from notifications_sent n
       where n.reservation_id = r.id
         and n.kind = 'survey_d1'
         and n.status = 'sent'
    );
$$;

revoke all on function public.get_reservations_for_survey(date, uuid) from public;
revoke execute on function public.get_reservations_for_survey(date, uuid)
  from anon, authenticated;
grant execute on function public.get_reservations_for_survey(date, uuid)
  to service_role;

-- Backward-compat (1 arg)
create or replace function public.get_reservations_for_survey(p_target_date date)
returns table (
  reservation_id  uuid,
  customer_phone  text,
  customer_name   text,
  code            text
)
language sql security definer set search_path = public stable
as $$ select * from public.get_reservations_for_survey(p_target_date, null); $$;

revoke all on function public.get_reservations_for_survey(date) from public;
revoke execute on function public.get_reservations_for_survey(date)
  from anon, authenticated;
grant execute on function public.get_reservations_for_survey(date) to service_role;

-- ── 9.6 get_upcoming_reservations ────────────────────────────────────────────

create or replace function public.get_upcoming_reservations(
  p_from_date date,
  p_to_date   date,
  p_unit_id   uuid default null
)
returns table (
  reservation_id    uuid,
  reservation_code  text,
  reservation_date  date,
  reservation_time  time,
  party_size        integer,
  status            text,
  notes             text,
  customer_name     text,
  customer_phone    text,
  customer_email    text,
  table_number      integer
)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.reservation_code,
    r.date,
    r.time,
    r.party_size,
    r.status,
    r.notes,
    c.name,
    c.phone,
    c.email,
    t.number
  from reservations r
  join customers c   on c.id = r.customer_id
  left join tables t on t.id = r.table_id
  where r.date between p_from_date and p_to_date
    and (p_unit_id is null or r.unit_id = p_unit_id)
    and r.status in ('pending', 'confirmed')
  order by r.date, r.time;
$$;

revoke all on function public.get_upcoming_reservations(date, date, uuid) from public;
revoke execute on function public.get_upcoming_reservations(date, date, uuid)
  from anon, authenticated;
grant execute on function public.get_upcoming_reservations(date, date, uuid)
  to service_role;

-- Backward-compat (2 args)
create or replace function public.get_upcoming_reservations(
  p_from_date date,
  p_to_date   date
)
returns table (
  reservation_id    uuid,
  reservation_code  text,
  reservation_date  date,
  reservation_time  time,
  party_size        integer,
  status            text,
  notes             text,
  customer_name     text,
  customer_phone    text,
  customer_email    text,
  table_number      integer
)
language sql security definer set search_path = public stable
as $$ select * from public.get_upcoming_reservations(p_from_date, p_to_date, null); $$;

revoke all on function public.get_upcoming_reservations(date, date) from public;
revoke execute on function public.get_upcoming_reservations(date, date)
  from anon, authenticated;
grant execute on function public.get_upcoming_reservations(date, date) to service_role;

-- ── 9.7 RPCs públicas de unidade (para o portal público) ─────────────────────

create or replace function public.get_unit_public(p_slug text)
returns table (
  id               uuid,
  name             text,
  slug             text,
  address          jsonb,
  timezone         text,
  organization_id  uuid,
  organization_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    u.id,
    u.name,
    u.slug,
    u.address,
    u.timezone,
    u.organization_id,
    o.name as organization_name
  from units u
  join organizations o on o.id = u.organization_id
  where u.slug = lower(p_slug)
    and u.is_public = true
  limit 1;
$$;

grant execute on function public.get_unit_public(text) to anon, authenticated;

create or replace function public.list_public_units()
returns table (
  id              uuid,
  name            text,
  slug            text,
  address         jsonb,
  timezone        text,
  organization_id uuid
)
language sql
security definer
set search_path = public
stable
as $$
  select u.id, u.name, u.slug, u.address, u.timezone, u.organization_id
  from units u
  join organizations o on o.id = u.organization_id
  where u.is_public = true and o.is_public = true
  order by o.name, u.name;
$$;

grant execute on function public.list_public_units() to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 10 — Atualizar trigger de auditoria para capturar unit_id / org_id
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.audit_trigger_func()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id       uuid;
  v_actor_email    text;
  v_old            jsonb;
  v_new            jsonb;
  v_record_id      text;
  v_unit_id        uuid;
  v_org_id         uuid;
begin
  v_actor_id := auth.uid();
  begin
    v_actor_email := auth.email();
  exception when others then
    v_actor_email := null;
  end;

  if (TG_OP = 'INSERT') then
    v_old := null;
    v_new := to_jsonb(NEW);
    v_record_id := (NEW).id::text;
  elsif (TG_OP = 'UPDATE') then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_record_id := (NEW).id::text;
  elsif (TG_OP = 'DELETE') then
    v_old := to_jsonb(OLD);
    v_new := null;
    v_record_id := (OLD).id::text;
  end if;

  -- Capturar unit_id se a tabela tiver a coluna
  begin
    v_unit_id := coalesce(
      (v_new->>'unit_id')::uuid,
      (v_old->>'unit_id')::uuid
    );
  exception when others then
    v_unit_id := null;
  end;

  -- Capturar organization_id (customers)
  begin
    v_org_id := coalesce(
      (v_new->>'organization_id')::uuid,
      (v_old->>'organization_id')::uuid
    );
  exception when others then
    v_org_id := null;
  end;

  insert into audit_log (
    table_name, record_id, action,
    old_values, new_values,
    actor_id, actor_email,
    unit_id, organization_id
  )
  values (
    TG_TABLE_NAME, v_record_id, TG_OP,
    v_old, v_new,
    v_actor_id, v_actor_email,
    v_unit_id, v_org_id
  );

  return coalesce(NEW, OLD);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 11 — Triggers de updated_at para novas tabelas
-- ═══════════════════════════════════════════════════════════════════════════════

create trigger organizations_updated_at
  before update on organizations
  for each row execute function public.update_updated_at();

create trigger units_updated_at
  before update on units
  for each row execute function public.update_updated_at();

create trigger whatsapp_channels_updated_at
  before update on whatsapp_channels
  for each row execute function public.update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 12 — Manter admin_users viva (dropada após frontend migrar para unit_members)
-- A Fase 2 do refactor frontend irá ler unit_members em vez de admin_users.
-- Após o deploy do frontend, executar: drop table admin_users;
-- ═══════════════════════════════════════════════════════════════════════════════

-- (nenhuma alteração em admin_users aqui — backward-compat com frontend atual)

commit;

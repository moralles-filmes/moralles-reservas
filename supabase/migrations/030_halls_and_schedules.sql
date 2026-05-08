-- Migration 030: introduce halls + hall_schedules + table capacity range
--
-- Reorganiza o módulo "Reservas" em torno do conceito de SALÃO (hall):
--   units -> halls -> tables (hall_id) + halls -> hall_schedules
--
-- - tables ganha (min_capacity, max_capacity, hall_id). Mesa fixa = min=max.
--   `capacity` legacy mantido por compat transicional, sincronizado via trigger.
-- - business_hours fica vivo como DEPRECATED — drop em migration futura
--   após validação em produção (caller path: get_unit_public_full ainda
--   retorna pra compat).
-- - Anon não lê halls/hall_schedules direto: leitura pública via RPC
--   `get_unit_public_full(slug)` (SECURITY DEFINER), padrão idêntico ao
--   resto do schema endurecido em 023a/023b.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — Novas tabelas: halls, hall_schedules
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists halls (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default true,
  allow_empty_seat boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, name)
);

create index if not exists halls_unit_idx on halls (unit_id);

create table if not exists hall_schedules (
  id uuid primary key default gen_random_uuid(),
  hall_id uuid not null references halls(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  open_time time not null,
  close_time time not null,
  slot_minutes int not null default 30
    check (slot_minutes in (5,10,15,20,30,45,60)),
  min_advance_minutes int not null default 0
    check (min_advance_minutes >= 0),
  discount_percent int not null default 0
    check (discount_percent between 0 and 100),
  charge_enabled boolean not null default false,
  charge_amount_cents int
    check (charge_amount_cents is null or charge_amount_cents >= 0),
  created_at timestamptz not null default now(),
  check (close_time > open_time),
  check (charge_enabled = false or charge_amount_cents is not null)
);

create index if not exists hall_schedules_hall_dow_idx
  on hall_schedules (hall_id, day_of_week);

-- updated_at trigger pra halls
create or replace function public.set_halls_updated_at()
returns trigger language plpgsql
set search_path = public
as $body$
begin
  new.updated_at := now();
  return new;
end
$body$;

drop trigger if exists halls_updated_at on halls;
create trigger halls_updated_at
  before update on halls
  for each row execute function public.set_halls_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — Estender `tables` com hall_id + range de capacidade
-- ═══════════════════════════════════════════════════════════════════════════

alter table tables
  add column if not exists hall_id uuid references halls(id) on delete set null,
  add column if not exists min_capacity int,
  add column if not exists max_capacity int;

update tables set min_capacity = capacity where min_capacity is null;
update tables set max_capacity = capacity where max_capacity is null;

alter table tables
  alter column min_capacity set not null,
  alter column max_capacity set not null;

alter table tables
  drop constraint if exists tables_capacity_range;
alter table tables
  add constraint tables_capacity_range
  check (max_capacity >= min_capacity and min_capacity > 0);

create index if not exists tables_hall_idx on tables (hall_id);

-- Trigger: legacy `capacity` follows `max_capacity` (compat transicional)
create or replace function public.sync_table_capacity()
returns trigger language plpgsql
set search_path = public
as $body$
begin
  new.capacity := new.max_capacity;
  return new;
end
$body$;

drop trigger if exists tables_sync_capacity on tables;
create trigger tables_sync_capacity
  before insert or update of min_capacity, max_capacity on tables
  for each row execute function public.sync_table_capacity();

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — Migração de dados: 1 salão default por unit + bind + horários
-- ═══════════════════════════════════════════════════════════════════════════

-- 3.1 — 1 hall "Salão Principal" por unit que tem mesas ou business_hours
insert into halls (unit_id, name, sort_order, active)
select distinct u.id, 'Salão Principal', 0, true
from units u
where not exists (select 1 from halls h where h.unit_id = u.id)
  and (
    exists (select 1 from tables t where t.unit_id = u.id)
    or exists (select 1 from business_hours b where b.unit_id = u.id)
  )
on conflict (unit_id, name) do nothing;

-- 3.2 — Vincular mesas existentes ao hall default da unit
update tables t
set hall_id = (
  select h.id from halls h
  where h.unit_id = t.unit_id
  order by h.sort_order, h.created_at
  limit 1
)
where t.hall_id is null;

-- 3.3 — Copiar business_hours abertos pra hall_schedules (escala default 30min)
insert into hall_schedules (hall_id, day_of_week, open_time, close_time, slot_minutes)
select
  (select h.id from halls h where h.unit_id = b.unit_id
   order by h.sort_order, h.created_at limit 1),
  b.day_of_week,
  b.open_time,
  b.close_time,
  30
from business_hours b
where b.is_closed = false
  and exists (select 1 from halls h where h.unit_id = b.unit_id)
  and not exists (
    select 1 from hall_schedules hs
    join halls h on h.id = hs.hall_id
    where h.unit_id = b.unit_id and hs.day_of_week = b.day_of_week
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4 — RLS
-- ═══════════════════════════════════════════════════════════════════════════

alter table halls enable row level security;
alter table hall_schedules enable row level security;

-- halls: padrão `is_unit_member` (igual special_dates / business_hours).
-- Anon NÃO lê direto — leitura pública via RPC get_unit_public_full.
drop policy if exists "platform_admin_all_halls" on halls;
create policy "platform_admin_all_halls" on halls
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_halls" on halls;
create policy "unit_member_all_halls" on halls
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- hall_schedules: deriva unit_id via halls (padrão idêntico ao de table_blocks).
drop policy if exists "platform_admin_all_hall_schedules" on hall_schedules;
create policy "platform_admin_all_hall_schedules" on hall_schedules
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_hall_schedules" on hall_schedules;
create policy "unit_member_all_hall_schedules" on hall_schedules
  for all to authenticated
  using (
    exists (
      select 1 from halls h
      where h.id = hall_id and is_unit_member(auth.uid(), h.unit_id)
    )
  )
  with check (
    exists (
      select 1 from halls h
      where h.id = hall_id and is_unit_member(auth.uid(), h.unit_id)
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5 — RPCs públicas (atualizadas + nova)
-- ═══════════════════════════════════════════════════════════════════════════

-- 5.1 — get_unit_public_full: incluir array `halls` com schedules
create or replace function public.get_unit_public_full(p_slug text)
returns jsonb
language sql security definer stable
set search_path = public
as $$
  with u as (
    select * from units where slug = p_slug and is_public = true limit 1
  )
  select case
    when not exists (select 1 from u) then null
    else jsonb_build_object(
      'unit', (
        select jsonb_build_object(
          'id', u.id,
          'name', u.name,
          'slug', u.slug,
          'organization_id', u.organization_id,
          'description', u.description,
          'price_range_min', u.price_range_min,
          'price_range_max', u.price_range_max,
          'hero_image_url', u.hero_image_url,
          'logo_url', u.logo_url,
          'address', u.address,
          'timezone', u.timezone
        ) from u
      ),
      'halls', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', h.id,
            'name', h.name,
            'description', h.description,
            'allow_empty_seat', h.allow_empty_seat,
            'sort_order', h.sort_order,
            'schedules', (
              select coalesce(jsonb_agg(
                jsonb_build_object(
                  'day_of_week', hs.day_of_week,
                  'open_time', hs.open_time,
                  'close_time', hs.close_time,
                  'slot_minutes', hs.slot_minutes,
                  'min_advance_minutes', hs.min_advance_minutes,
                  'discount_percent', hs.discount_percent,
                  'charge_enabled', hs.charge_enabled,
                  'charge_amount_cents', hs.charge_amount_cents
                ) order by hs.day_of_week, hs.open_time
              ), '[]'::jsonb)
              from hall_schedules hs
              where hs.hall_id = h.id
            )
          ) order by h.sort_order, h.name
        ), '[]'::jsonb)
        from halls h
        where h.unit_id = (select id from u) and h.active = true
      ),
      'business_hours', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'day_of_week', bh.day_of_week,
            'open_time', bh.open_time,
            'close_time', bh.close_time,
            'is_closed', bh.is_closed
          ) order by bh.day_of_week
        ), '[]'::jsonb)
        from business_hours bh
        where bh.unit_id = (select id from u)
      ),
      'special_dates', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'date', sd.date,
            'is_closed', sd.is_closed,
            'open_time', sd.open_time,
            'close_time', sd.close_time
          ) order by sd.date
        ), '[]'::jsonb)
        from special_dates sd
        where sd.unit_id = (select id from u)
          and sd.date >= current_date
      )
    )
  end;
$$;

revoke all on function public.get_unit_public_full(text) from public;
grant execute on function public.get_unit_public_full(text) to anon, authenticated;

-- 5.2 — get_public_hall_schedules: janelas de um hall numa data específica
create or replace function public.get_public_hall_schedules(
  p_hall_id uuid,
  p_date    date
) returns table (
  day_of_week         int,
  open_time           time,
  close_time          time,
  slot_minutes        int,
  min_advance_minutes int,
  discount_percent    int,
  charge_enabled      boolean,
  charge_amount_cents int
)
language sql security definer stable
set search_path = public
as $$
  select hs.day_of_week, hs.open_time, hs.close_time, hs.slot_minutes,
         hs.min_advance_minutes, hs.discount_percent,
         hs.charge_enabled, hs.charge_amount_cents
    from hall_schedules hs
    join halls h on h.id = hs.hall_id
    join units u on u.id = h.unit_id
   where hs.hall_id = p_hall_id
     and hs.day_of_week = extract(dow from p_date)::int
     and h.active = true
     and u.is_public = true
   order by hs.open_time;
$$;

revoke all on function public.get_public_hall_schedules(uuid, date) from public;
grant execute on function public.get_public_hall_schedules(uuid, date)
  to anon, authenticated;

commit;

-- Migration 031: expande `special_dates` para suportar override completo de
-- horário/regras durante um INTERVALO de datas, opcionalmente escopado a um
-- salão específico.
--
-- Mudanças:
--   - `end_date` (NOT NULL): data final do intervalo. Backfill = date.
--   - `hall_id` (nullable, FK halls): se NULL, aplica em todos os salões da unit.
--   - `slot_minutes`, `min_advance_minutes`, `discount_percent`,
--     `charge_enabled`, `charge_amount_cents`: parâmetros de override
--     (mesmos campos de hall_schedules).
--   - drop `unique(unit_id, date)`: agora podem coexistir várias overrides
--     para a mesma data (ex: 1 por hall, ou várias com is_closed=false).
--   - mantém `is_closed`, `name`, `open_time`, `close_time`, `max_party_size`,
--     `notes` por compat.

begin;

alter table special_dates
  add column if not exists end_date date,
  add column if not exists hall_id uuid references halls(id) on delete cascade,
  add column if not exists slot_minutes int check (slot_minutes in (5,10,15,20,30,45,60)),
  add column if not exists min_advance_minutes int default 0 check (min_advance_minutes >= 0),
  add column if not exists discount_percent int default 0 check (discount_percent between 0 and 100),
  add column if not exists charge_enabled boolean default false,
  add column if not exists charge_amount_cents int check (charge_amount_cents is null or charge_amount_cents >= 0);

-- Backfill end_date = date pra rows existentes (eram single-day)
update special_dates set end_date = date where end_date is null;

alter table special_dates
  alter column end_date set not null;

-- Range válido (end_date pode ser igual a date — single day)
alter table special_dates
  drop constraint if exists special_dates_date_range;
alter table special_dates
  add constraint special_dates_date_range check (end_date >= date);

-- Drop unique(unit_id, date) — agora múltiplas overrides por dia coexistem
alter table special_dates
  drop constraint if exists special_dates_unit_date_unique;

-- Índices: filtro por intervalo + por hall
create index if not exists special_dates_unit_range_idx
  on special_dates (unit_id, date, end_date);
create index if not exists special_dates_hall_idx
  on special_dates (hall_id) where hall_id is not null;

-- Charge requires amount when enabled
alter table special_dates
  drop constraint if exists special_dates_charge_amount_required;
alter table special_dates
  add constraint special_dates_charge_amount_required
  check (charge_enabled = false or charge_amount_cents is not null);

-- ═══════════════════════════════════════════════════════════════════════════
-- get_unit_public_full: incluir end_date + hall_id + slot/advance/discount
-- nas datas especiais retornadas (≥ data atual ou que englobam data atual).
-- ═══════════════════════════════════════════════════════════════════════════

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
          'id', u.id, 'name', u.name, 'slug', u.slug,
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
            'end_date', sd.end_date,
            'hall_id', sd.hall_id,
            'name', sd.name,
            'is_closed', sd.is_closed,
            'open_time', sd.open_time,
            'close_time', sd.close_time,
            'slot_minutes', sd.slot_minutes,
            'min_advance_minutes', sd.min_advance_minutes,
            'discount_percent', sd.discount_percent,
            'charge_enabled', sd.charge_enabled,
            'charge_amount_cents', sd.charge_amount_cents
          ) order by sd.date
        ), '[]'::jsonb)
        from special_dates sd
        where sd.unit_id = (select id from u)
          and sd.end_date >= current_date
      )
    )
  end;
$$;

revoke all on function public.get_unit_public_full(text) from public;
grant execute on function public.get_unit_public_full(text) to anon, authenticated;

commit;

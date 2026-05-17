-- Migration 033: reservation widgets
--
-- Cada widget é um link público de reserva (`/w/<slug>`) configurável:
--   - vinculado a 1 unit (modelo MVP — multi-unit pode evoluir via n:n depois)
--   - campos do form customizáveis via `field_config` JSONB
--   - texto livre de instruções pro cliente
--   - toggle de banner de cardápio (placeholder pra integração futura)
--
-- O slug curto identifica o widget na URL pública (8 chars alfanuméricos).

begin;

create table if not exists reservation_widgets (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  slug text not null unique,
  name text not null,
  field_config jsonb not null default '{}'::jsonb,
  client_instructions text,
  show_menu_banner boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reservation_widgets_unit_idx
  on reservation_widgets (unit_id);

create or replace function public.set_widget_updated_at()
returns trigger language plpgsql
set search_path = public
as $body$
begin
  new.updated_at := now();
  return new;
end
$body$;

drop trigger if exists widgets_updated_at on reservation_widgets;
create trigger widgets_updated_at
  before update on reservation_widgets
  for each row execute function public.set_widget_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — padrão das outras tabelas: anon NÃO lê direto; leitura pública via RPC.
-- ═══════════════════════════════════════════════════════════════════════════

alter table reservation_widgets enable row level security;

drop policy if exists "platform_admin_all_widgets" on reservation_widgets;
create policy "platform_admin_all_widgets" on reservation_widgets
  for all to authenticated
  using (is_platform_admin(auth.uid()))
  with check (is_platform_admin(auth.uid()));

drop policy if exists "unit_member_all_widgets" on reservation_widgets;
create policy "unit_member_all_widgets" on reservation_widgets
  for all to authenticated
  using (is_unit_member(auth.uid(), unit_id))
  with check (is_unit_member(auth.uid(), unit_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC pública pra renderizar widget público (anon-safe).
-- Retorna widget + unit + halls (com schedules) — formato igual ao
-- get_unit_public_full pra reaproveitar ReservaForm sem mudanças no shape.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_widget_public(p_slug text)
returns jsonb
language sql security definer stable
set search_path = public
as $$
  with w as (
    select rw.*
    from reservation_widgets rw
    join units u on u.id = rw.unit_id
    join organizations o on o.id = u.organization_id
    where rw.slug = p_slug
      and rw.active = true
      and u.is_public = true
      and o.is_public = true
    limit 1
  )
  select case
    when not exists (select 1 from w) then null
    else jsonb_build_object(
      'widget', (
        select jsonb_build_object(
          'id', w.id,
          'slug', w.slug,
          'name', w.name,
          'field_config', w.field_config,
          'client_instructions', w.client_instructions,
          'show_menu_banner', w.show_menu_banner
        ) from w
      ),
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
        )
        from units u
        where u.id = (select unit_id from w)
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
        where h.unit_id = (select unit_id from w) and h.active = true
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
        where sd.unit_id = (select unit_id from w)
          and sd.end_date >= current_date
      )
    )
  end;
$$;

revoke all on function public.get_widget_public(text) from public;
grant execute on function public.get_widget_public(text) to anon, authenticated;

commit;

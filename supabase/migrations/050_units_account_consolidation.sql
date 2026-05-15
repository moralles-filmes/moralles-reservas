-- Migration 050: Consolida dados da unidade na tabela `units`
--
-- Esta migration:
--   1. Adiciona colunas faltantes (cnpj, financial_email, cuisine_types,
--      opening_hours_text, payment_methods, facilities, phone, instagram, website)
--   2. Faz backfill dos valores hoje em settings (restaurant_phone/instagram/
--      website/address) pras novas colunas
--   3. Atualiza RPCs públicas (get_unit_public_full e get_widget_public) pra
--      expor os novos campos públicos no portal
--
-- IMPORTANTE: NÃO dropa as chaves antigas em `settings` — ficam como sombra
-- pra fallback da Edge Function send-confirmation durante período de transição.
-- Limpeza fica pra migration futura.

begin;

-- ── 1) Novas colunas ─────────────────────────────────────────────────────────

alter table public.units
  add column if not exists cnpj text,
  add column if not exists financial_email text,
  add column if not exists cuisine_types text[] not null default array[]::text[],
  add column if not exists opening_hours_text text,
  add column if not exists payment_methods text,
  add column if not exists facilities jsonb not null default '[]'::jsonb,
  add column if not exists phone text,
  add column if not exists instagram text,
  add column if not exists website text;

-- Garante que facilities é sempre um array JSON
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'units_facilities_is_array'
  ) then
    alter table public.units
      add constraint units_facilities_is_array
      check (jsonb_typeof(facilities) = 'array');
  end if;
end $$;

-- ── 2) Backfill a partir de settings ─────────────────────────────────────────
-- settings.value é jsonb. Quando o valor é uma string ("foo"), `value #>> '{}'`
-- extrai como text. Quando é número/bool/null, retorna a representação textual.

update public.units u
set
  phone = coalesce(
    u.phone,
    (select s.value #>> '{}'
     from public.settings s
     where s.unit_id = u.id and s.key = 'restaurant_phone'
     limit 1)
  ),
  instagram = coalesce(
    u.instagram,
    (select s.value #>> '{}'
     from public.settings s
     where s.unit_id = u.id and s.key = 'restaurant_instagram'
     limit 1)
  ),
  website = coalesce(
    u.website,
    (select s.value #>> '{}'
     from public.settings s
     where s.unit_id = u.id and s.key = 'restaurant_website'
     limit 1)
  )
where exists (
  select 1 from public.settings s
  where s.unit_id = u.id
    and s.key in ('restaurant_phone', 'restaurant_instagram', 'restaurant_website')
);

-- Backfill de address.full a partir de settings.restaurant_address quando
-- units.address não tem `full` nem campos estruturados preenchidos.
update public.units u
set address = coalesce(u.address, '{}'::jsonb) || jsonb_build_object(
  'full', (select s.value #>> '{}'
           from public.settings s
           where s.unit_id = u.id and s.key = 'restaurant_address'
           limit 1)
)
where (
  u.address is null
  or coalesce(u.address ->> 'full', '') = ''
)
and exists (
  select 1 from public.settings s
  where s.unit_id = u.id
    and s.key = 'restaurant_address'
    and coalesce(s.value #>> '{}', '') <> ''
);

-- ── 3) Recria get_unit_public_full ───────────────────────────────────────────

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
          'timezone', u.timezone,
          'phone', u.phone,
          'instagram', u.instagram,
          'website', u.website,
          'cuisine_types', to_jsonb(u.cuisine_types),
          'opening_hours_text', u.opening_hours_text,
          'payment_methods', u.payment_methods,
          'facilities', u.facilities
        ) from u
      ),
      'unit_settings', (
        select jsonb_object_agg(s.key, s.value)
        from settings s
        where s.unit_id = (select id from u)
          and s.key in ('booking_window_days', 'rules_and_conditions', 'additional_info')
      ),
      'halls', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', h.id, 'name', h.name, 'description', h.description,
            'allow_empty_seat', h.allow_empty_seat, 'sort_order', h.sort_order,
            'schedules', (
              select coalesce(jsonb_agg(
                jsonb_build_object(
                  'day_of_week', hs.day_of_week, 'open_time', hs.open_time,
                  'close_time', hs.close_time, 'slot_minutes', hs.slot_minutes,
                  'min_advance_minutes', hs.min_advance_minutes,
                  'discount_percent', hs.discount_percent,
                  'charge_enabled', hs.charge_enabled,
                  'charge_amount_cents', hs.charge_amount_cents
                ) order by hs.day_of_week, hs.open_time
              ), '[]'::jsonb)
              from hall_schedules hs where hs.hall_id = h.id
            )
          ) order by h.sort_order, h.name
        ), '[]'::jsonb)
        from halls h where h.unit_id = (select id from u) and h.active = true
      ),
      'business_hours', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'day_of_week', bh.day_of_week, 'open_time', bh.open_time,
            'close_time', bh.close_time, 'is_closed', bh.is_closed
          ) order by bh.day_of_week
        ), '[]'::jsonb)
        from business_hours bh where bh.unit_id = (select id from u)
      ),
      'special_dates', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'date', sd.date, 'end_date', sd.end_date, 'hall_id', sd.hall_id,
            'name', sd.name, 'is_closed', sd.is_closed,
            'open_time', sd.open_time, 'close_time', sd.close_time,
            'slot_minutes', sd.slot_minutes,
            'min_advance_minutes', sd.min_advance_minutes,
            'discount_percent', sd.discount_percent,
            'charge_enabled', sd.charge_enabled,
            'charge_amount_cents', sd.charge_amount_cents
          ) order by sd.date
        ), '[]'::jsonb)
        from special_dates sd
        where sd.unit_id = (select id from u) and sd.end_date >= current_date
      ),
      'custom_fields', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', cf.id, 'label', cf.label, 'type', cf.type,
            'options', cf.options, 'required', cf.required,
            'sort_order', cf.sort_order
          ) order by cf.sort_order, cf.created_at
        ), '[]'::jsonb)
        from unit_custom_fields cf
        where cf.unit_id = (select id from u) and cf.active = true
      )
    )
  end;
$$;

revoke all on function public.get_unit_public_full(text) from public;
grant execute on function public.get_unit_public_full(text) to anon, authenticated;

-- ── 4) Recria get_widget_public (mesmo unit jsonb expandido) ────────────────

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
    where rw.slug = p_slug and rw.active = true
      and u.is_public = true and o.is_public = true
    limit 1
  )
  select case
    when not exists (select 1 from w) then null
    else jsonb_build_object(
      'widget', (
        select jsonb_build_object(
          'id', w.id, 'slug', w.slug, 'name', w.name,
          'field_config', w.field_config,
          'client_instructions', w.client_instructions,
          'show_menu_banner', w.show_menu_banner
        ) from w
      ),
      'unit', (
        select jsonb_build_object(
          'id', u.id, 'name', u.name, 'slug', u.slug,
          'organization_id', u.organization_id, 'description', u.description,
          'price_range_min', u.price_range_min, 'price_range_max', u.price_range_max,
          'hero_image_url', u.hero_image_url, 'logo_url', u.logo_url,
          'address', u.address, 'timezone', u.timezone,
          'phone', u.phone, 'instagram', u.instagram, 'website', u.website,
          'cuisine_types', to_jsonb(u.cuisine_types),
          'opening_hours_text', u.opening_hours_text,
          'payment_methods', u.payment_methods,
          'facilities', u.facilities
        )
        from units u where u.id = (select unit_id from w)
      ),
      'unit_settings', (
        select jsonb_object_agg(s.key, s.value)
        from settings s
        where s.unit_id = (select unit_id from w)
          and s.key in ('booking_window_days', 'rules_and_conditions', 'additional_info')
      ),
      'halls', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', h.id, 'name', h.name, 'description', h.description,
            'allow_empty_seat', h.allow_empty_seat, 'sort_order', h.sort_order,
            'schedules', (
              select coalesce(jsonb_agg(
                jsonb_build_object(
                  'day_of_week', hs.day_of_week, 'open_time', hs.open_time,
                  'close_time', hs.close_time, 'slot_minutes', hs.slot_minutes,
                  'min_advance_minutes', hs.min_advance_minutes,
                  'discount_percent', hs.discount_percent,
                  'charge_enabled', hs.charge_enabled,
                  'charge_amount_cents', hs.charge_amount_cents
                ) order by hs.day_of_week, hs.open_time
              ), '[]'::jsonb)
              from hall_schedules hs where hs.hall_id = h.id
            )
          ) order by h.sort_order, h.name
        ), '[]'::jsonb)
        from halls h where h.unit_id = (select unit_id from w) and h.active = true
      ),
      'special_dates', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'date', sd.date, 'end_date', sd.end_date, 'hall_id', sd.hall_id,
            'name', sd.name, 'is_closed', sd.is_closed,
            'open_time', sd.open_time, 'close_time', sd.close_time,
            'slot_minutes', sd.slot_minutes,
            'min_advance_minutes', sd.min_advance_minutes,
            'discount_percent', sd.discount_percent,
            'charge_enabled', sd.charge_enabled,
            'charge_amount_cents', sd.charge_amount_cents
          ) order by sd.date
        ), '[]'::jsonb)
        from special_dates sd
        where sd.unit_id = (select unit_id from w) and sd.end_date >= current_date
      ),
      'custom_fields', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', cf.id, 'label', cf.label, 'type', cf.type,
            'options', cf.options, 'required', cf.required,
            'sort_order', cf.sort_order
          ) order by cf.sort_order, cf.created_at
        ), '[]'::jsonb)
        from unit_custom_fields cf
        where cf.unit_id = (select unit_id from w) and cf.active = true
      )
    )
  end;
$$;

revoke all on function public.get_widget_public(text) from public;
grant execute on function public.get_widget_public(text) to anon, authenticated;

commit;

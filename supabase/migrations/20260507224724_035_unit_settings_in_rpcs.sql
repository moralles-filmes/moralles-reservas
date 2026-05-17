-- Migration 035: expõe `unit_settings` (booking_window_days, rules_and_conditions,
-- additional_info) nas RPCs públicas. Sem mudanças de schema — só atualização
-- das funções pra ler keys públicas da tabela `settings` existente.

begin;

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
          'address', u.address, 'timezone', u.timezone
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

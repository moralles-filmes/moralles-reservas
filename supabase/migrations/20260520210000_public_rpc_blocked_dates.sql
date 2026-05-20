-- Expõe table_blocks macro (table_id IS NULL) nas RPCs públicas
-- `get_unit_public_full` e `get_widget_public` como o array `blocked_dates`,
-- pra que o wizard de reserva (`/r/:slug` e `/w/:slug`) consiga marcar dias
-- bloqueados ANTES do cliente preencher o form todo. Sem isso, o front só
-- descobria o bloqueio quando `reserveSlot` devolvia `closed_day` no submit —
-- cliente perde o tempo de preencher dados e só leva erro no fim.
--
-- Cada item:
--   { date_from: 'YYYY-MM-DD', date_to: 'YYYY-MM-DD', title, hall_id }
-- Datas calculadas no fuso BRT (`America/Sao_Paulo`) pra casar com a percepção
-- do cliente — bloqueio "12/06 dia inteiro" tem blocked_from=03:00Z, e a
-- conversão BRT garante que `date_from` saia como '2026-06-12' (e não '2026-06-11'
-- via `::date` em UTC). Bloqueios de mesa individual (`table_id IS NOT NULL`)
-- são excluídos — não afetam o macro do salão; o wizard só desabilita o dia
-- inteiro quando o bloqueio é macro (hall_id IS NULL) ou cobre TODOS os
-- salões via combinação. O front decide a renderização final.
--
-- Janela: 90 dias à frente (booking_window_days da plataforma geralmente é
-- menor — 60 — mas damos folga pra wizard mostrar tooltip mesmo em janelas
-- exibidas só pra contexto).
--
-- `create or replace function` exige recriar o corpo inteiro, então preservamos
-- o que veio da migration 052 (min/max_capacity por hall) + 050 (campos da unit).

begin;

-- ── 1) Recria get_unit_public_full com blocked_dates ───────────────────────

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
            'min_capacity', (
              select min(t.min_capacity)
              from tables t
              where t.hall_id = h.id and t.active = true
            ),
            'max_capacity', (
              select max(t.max_capacity)
              from tables t
              where t.hall_id = h.id and t.active = true
            ),
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
      'blocked_dates', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'date_from', to_char((tb.blocked_from at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
            'date_to', to_char((tb.blocked_to at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
            'title', coalesce(tb.title, tb.reason, 'Bloqueio'),
            'hall_id', tb.hall_id
          ) order by tb.blocked_from
        ), '[]'::jsonb)
        from table_blocks tb
        where tb.unit_id = (select id from u)
          and tb.table_id is null
          and tb.blocked_to > now()
          and tb.blocked_from < now() + interval '90 days'
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

-- ── 2) Recria get_widget_public com blocked_dates ──────────────────────────

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
            'min_capacity', (
              select min(t.min_capacity)
              from tables t
              where t.hall_id = h.id and t.active = true
            ),
            'max_capacity', (
              select max(t.max_capacity)
              from tables t
              where t.hall_id = h.id and t.active = true
            ),
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
      'blocked_dates', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'date_from', to_char((tb.blocked_from at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
            'date_to', to_char((tb.blocked_to at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
            'title', coalesce(tb.title, tb.reason, 'Bloqueio'),
            'hall_id', tb.hall_id
          ) order by tb.blocked_from
        ), '[]'::jsonb)
        from table_blocks tb
        where tb.unit_id = (select unit_id from w)
          and tb.table_id is null
          and tb.blocked_to > now()
          and tb.blocked_from < now() + interval '90 days'
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

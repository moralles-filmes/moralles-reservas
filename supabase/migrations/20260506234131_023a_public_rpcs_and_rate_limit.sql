-- Migration 023a: cria as RPCs públicas usadas pelo portal/form anon e
-- endurece check_rate_limit (rejeita p_unit_id null). NÃO dropa policies
-- anon ainda — isso fica para 023b, depois do deploy do frontend novo.
-- Estratégia em duas fases para não derrubar o portal público durante o
-- deploy.

begin;

-- ── M1 (parcial): exigir p_unit_id em check_rate_limit ─────────────────────
-- Não muda comportamento de callers que já passam unit_id; apenas rejeita
-- callers que dependiam do default null (cross-tenant rate limit).
drop function if exists public.check_rate_limit(text, integer, integer);
drop function if exists public.check_rate_limit(text, integer, integer, uuid);

create function public.check_rate_limit(
  p_phone          text,
  p_window_seconds integer,
  p_max            integer,
  p_unit_id        uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_unit_id is null then
    raise exception 'check_rate_limit: p_unit_id is required';
  end if;

  delete from rate_limit_events
   where created_at < now() - make_interval(secs => p_window_seconds * 10);

  select count(*) into v_count
    from rate_limit_events
   where phone = p_phone
     and unit_id = p_unit_id
     and created_at >= now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max then
    return false;
  end if;

  insert into rate_limit_events (phone, unit_id) values (p_phone, p_unit_id);
  return true;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer, uuid) from public;
revoke execute on function public.check_rate_limit(text, integer, integer, uuid) from anon;
revoke execute on function public.check_rate_limit(text, integer, integer, uuid) from authenticated;

-- ── RPC pública: get_unit_public_full ──────────────────────────────────────
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

-- ── RPC pública: get_public_business_hours ─────────────────────────────────
create or replace function public.get_public_business_hours(p_unit_id uuid)
returns table (
  day_of_week smallint,
  open_time   time,
  close_time  time,
  is_closed   boolean
)
language sql security definer stable
set search_path = public
as $$
  select bh.day_of_week, bh.open_time, bh.close_time, bh.is_closed
    from business_hours bh
    join units u on u.id = bh.unit_id
   where bh.unit_id = p_unit_id
     and u.is_public = true
   order by bh.day_of_week;
$$;

revoke all on function public.get_public_business_hours(uuid) from public;
grant execute on function public.get_public_business_hours(uuid) to anon, authenticated;

commit;

-- Public waitlist authority and serialized IP rate limit. The old
-- check_rate_limit RPC and authenticated panel flow are unchanged.
begin;

-- All public entry now passes through the EF. Close both direct anon paths:
-- PostgREST RPC and table INSERT. Existing authenticated panel writes remain.
revoke all on function public.enter_waitlist(uuid,text,text,integer,text,text,time)
  from public, anon, service_role;
grant execute on function public.enter_waitlist(uuid,text,text,integer,text,text,time)
  to authenticated;
drop policy if exists "anon_insert_waitlist" on public.waitlist;
revoke insert on public.waitlist from public, anon;
do $$
declare v_column name;
begin
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
     where a.attrelid='public.waitlist'::regclass
       and a.attnum>0 and not a.attisdropped
  loop
    execute pg_catalog.format('revoke insert (%I) on table public.waitlist from public, anon',v_column);
  end loop;
end $$;
grant insert on public.waitlist to authenticated, service_role;

-- A public EF's service-role client may enter only while both visibility flags
-- remain true. SHARE locks hold those flags through enter_waitlist's INSERT in
-- this same RPC transaction; the underlying RPC is not callable by service_role.
create or replace function public.enter_public_waitlist(
  p_unit_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_party_size integer,
  p_notes text,
  p_priority_category text
)
returns table(waitlist_id uuid, code integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_unit_id is null or p_party_size is null or p_party_size not between 1 and 20
    or p_customer_name is null or pg_catalog.btrim(p_customer_name) = ''
    or p_customer_phone is null or pg_catalog.btrim(p_customer_phone) = '' then
    raise exception 'public_waitlist_invalid' using errcode = '22023';
  end if;

  perform 1 from public.units u
    join public.organizations o on o.id = u.organization_id
   where u.id = p_unit_id and u.is_public = true and o.is_public = true
   for share of u,o;
  if not found then
    raise exception 'public_waitlist_unavailable' using errcode = '42501';
  end if;

  return query
    select e.waitlist_id,e.code
      from public.enter_waitlist(
        p_unit_id,p_customer_name,p_customer_phone,p_party_size,p_notes,
        p_priority_category,null::time
      ) e;
end;
$$;

revoke all on function public.enter_public_waitlist(uuid,text,text,integer,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.enter_public_waitlist(uuid,text,text,integer,text,text)
  to service_role;

create index if not exists rate_limit_events_public_waitlist_expiry_idx
  on public.rate_limit_events(created_at)
  where phone like 'public-waitlist-ip:%';

create or replace function public.check_public_waitlist_rate_limit(
  p_unit_id uuid,
  p_ip_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_count integer;
begin
  if p_unit_id is null
    or p_ip_hash is null
    or p_ip_hash !~ '^public-waitlist-ip:[0-9a-f]{64}$' then
    raise exception 'public_waitlist_rate_limit_invalid' using errcode = '22023';
  end if;

  -- Serialize count+insert for this unit and hash, including independent
  -- Edge Function invocations. A 64-bit collision can only over-limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public_waitlist_rate:' || p_unit_id::text || ':' || p_ip_hash, 0)
  );
  v_now := pg_catalog.clock_timestamp();

  delete from public.rate_limit_events
   where phone like 'public-waitlist-ip:%'
     and created_at < v_now - interval '1 hour';

  select count(*) into v_count
    from public.rate_limit_events
   where unit_id = p_unit_id
     and phone = p_ip_hash
     and created_at >= v_now - interval '60 seconds';
  if v_count >= 5 then return false; end if;

  insert into public.rate_limit_events(phone, unit_id, created_at)
  values(p_ip_hash, p_unit_id, v_now);
  return true;
end;
$$;

revoke all on function public.check_public_waitlist_rate_limit(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.check_public_waitlist_rate_limit(uuid,text)
  to service_role;

commit;

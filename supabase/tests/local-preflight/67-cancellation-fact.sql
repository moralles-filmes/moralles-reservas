-- Run after the migration, and again after applying the migration twice more.
begin;
do $$
declare
  old_fact timestamptz;
  new_fact timestamptz;
  row_id uuid := '00000000-0000-4000-8000-000000000002';
begin
  if to_regprocedure('app_private.stamp_reservation_cancelled_at()') is null then
    raise exception 'FAIL67 migration not installed';
  end if;
  if has_function_privilege('anon', 'app_private.stamp_reservation_cancelled_at()', 'EXECUTE')
    or has_function_privilege('authenticated', 'app_private.stamp_reservation_cancelled_at()', 'EXECUTE') then
    raise exception 'FAIL67 trigger function executable by API roles';
  end if;
  if (select cancelled_at from public.reservations where id = '00000000-0000-4000-8000-000000000001') is not null then
    raise exception 'FAIL67 old cancellation was backfilled';
  end if;
  insert into public.reservations (id, status, cancelled_at)
    values ('00000000-0000-4000-8000-000000000003', 'cancelled', '1999-01-01');
  if (select cancelled_at from public.reservations where id = '00000000-0000-4000-8000-000000000003')
    is null or (select cancelled_at from public.reservations where id = '00000000-0000-4000-8000-000000000003')
    = '1999-01-01'::timestamptz then
    raise exception 'FAIL67 cancelled INSERT did not get server timestamp';
  end if;
  update public.reservations set status = 'cancelled', cancelled_at = '2000-01-01' where id = row_id;
  select cancelled_at into old_fact from public.reservations where id = row_id;
  if old_fact is null or old_fact = '2000-01-01' or old_fact > clock_timestamp() then
    raise exception 'FAIL67 transition timestamp not server-authored';
  end if;
  update public.reservations set cancelled_at = '2001-01-01' where id = row_id;
  if (select cancelled_at from public.reservations where id = row_id) is distinct from old_fact then
    raise exception 'FAIL67 direct spoof changed fact';
  end if;
  update public.reservations set status = 'confirmed', cancelled_at = '2002-01-01' where id = row_id;
  if (select cancelled_at from public.reservations where id = row_id) is not null then
    raise exception 'FAIL67 restored reservation kept fact';
  end if;
  perform pg_sleep(0.01);
  update public.reservations set status = 'cancelled', cancelled_at = '2003-01-01' where id = row_id;
  select cancelled_at into new_fact from public.reservations where id = row_id;
  if new_fact <= old_fact then raise exception 'FAIL67 recancellation reused fact'; end if;
end $$;

-- Positive control: with the trigger disabled, spoofing succeeds. This must
-- differ from the protected assertion above, proving that it detects absence.
alter table public.reservations disable trigger trg_stamp_reservation_cancelled_at;
update public.reservations set cancelled_at = '2004-01-01' where id = '00000000-0000-4000-8000-000000000002';
do $$ begin
  if (select cancelled_at from public.reservations where id = '00000000-0000-4000-8000-000000000002')
    is distinct from '2004-01-01'::timestamptz then
    raise exception 'FAIL67 control did not defeat protection';
  end if;
end $$;
-- The same protected invariant above (caller-supplied timestamp is refused)
-- must now trip. Catch only this expected assertion; any other error aborts.
do $$
declare assertion_tripped boolean := false;
begin
  begin
    if (select cancelled_at from public.reservations where id = '00000000-0000-4000-8000-000000000002')
      = '2004-01-01'::timestamptz then
      raise exception 'protected_spoof_assertion';
    end if;
  exception when raise_exception then
    if sqlerrm <> 'protected_spoof_assertion' then raise; end if;
    assertion_tripped := true;
  end;
  if not assertion_tripped then raise exception 'FAIL67 disabled-trigger assertion did not fail'; end if;
end $$;
alter table public.reservations enable trigger trg_stamp_reservation_cancelled_at;
rollback;

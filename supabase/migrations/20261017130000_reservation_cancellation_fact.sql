-- A cancellation fact is authoritative only when the row enters cancelled.
-- Existing cancelled reservations remain NULL until a fresh status transition.
begin;

alter table public.reservations add column if not exists cancelled_at timestamptz;

create or replace function app_private.stamp_reservation_cancelled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'cancelled' then
    if tg_op = 'INSERT' or old.status is distinct from 'cancelled' then
      new.cancelled_at := clock_timestamp();
    else
      new.cancelled_at := old.cancelled_at;
    end if;
  else
    new.cancelled_at := null;
  end if;
  return new;
end;
$$;

revoke all on function app_private.stamp_reservation_cancelled_at() from public, anon, authenticated;

drop trigger if exists trg_stamp_reservation_cancelled_at on public.reservations;
create trigger trg_stamp_reservation_cancelled_at
  before insert or update on public.reservations
  for each row execute function app_private.stamp_reservation_cancelled_at();

commit;

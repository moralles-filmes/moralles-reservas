-- Funcionalidades de produto:
-- 1. table_blocks    — bloqueio de mesa por intervalo (manutenção, evento privado)
-- 2. special_dates   — feriados / datas especiais (sobrescreve business_hours)
-- 3. customers.*     — preferências (alergias, VIP, mesa preferida, não-contatar)
-- 4. get_customer_stats(uuid) — RPC com histórico e taxa de no-show

-- ─── 1. Bloqueios de mesa ─────────────────────────────────────────────────────

create table if not exists table_blocks (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references tables(id) on delete cascade,
  blocked_from  timestamptz not null,
  blocked_to    timestamptz not null,
  reason        text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (blocked_to > blocked_from)
);

create index if not exists table_blocks_table_idx on table_blocks(table_id);
create index if not exists table_blocks_period_idx on table_blocks(blocked_from, blocked_to);

alter table table_blocks enable row level security;

create policy "auth_all_table_blocks" on table_blocks
  for all to authenticated using (true) with check (true);

-- ─── 2. Datas especiais ───────────────────────────────────────────────────────

create table if not exists special_dates (
  id              uuid primary key default gen_random_uuid(),
  date            date not null unique,
  name            text not null,
  is_closed       boolean not null default false,
  open_time       time,
  close_time      time,
  max_party_size  integer,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (is_closed or (open_time is not null and close_time is not null))
);

create index if not exists special_dates_date_idx on special_dates(date);

alter table special_dates enable row level security;

create policy "public_read_special_dates" on special_dates
  for select to anon using (true);

create policy "auth_all_special_dates" on special_dates
  for all to authenticated using (true) with check (true);

create trigger special_dates_updated_at
  before update on special_dates
  for each row execute function public.update_updated_at();

-- ─── 3. Preferências do cliente ──────────────────────────────────────────────

alter table customers
  add column if not exists allergies                text,
  add column if not exists dietary_restrictions     text,
  add column if not exists vip_notes                text,
  add column if not exists preferred_table_location text check (preferred_table_location in ('internal', 'external')),
  add column if not exists do_not_contact           boolean not null default false;

-- ─── 4. Customer stats — total/confirmadas/no-show/taxa/última visita ───────

create or replace function public.get_customer_stats(p_customer_id uuid)
returns table (
  total          integer,
  confirmed      integer,
  no_shows       integer,
  cancelled      integer,
  no_show_rate   numeric,
  last_visit     date
)
language sql
security definer
set search_path = public
stable
as $$
  with r as (
    select status, date
      from reservations
     where customer_id = p_customer_id
  ),
  agg as (
    select
      count(*)::int                                                              as total,
      count(*) filter (where status = 'confirmed')::int                          as confirmed,
      count(*) filter (where status = 'no_show')::int                            as no_shows,
      count(*) filter (where status = 'cancelled')::int                          as cancelled,
      max(date) filter (where status in ('confirmed', 'no_show'))                as last_visit
    from r
  )
  select
    total,
    confirmed,
    no_shows,
    cancelled,
    case when (confirmed + no_shows) > 0
         then round(no_shows::numeric / (confirmed + no_shows), 3)
         else 0::numeric
    end as no_show_rate,
    last_visit
  from agg;
$$;

revoke all on function public.get_customer_stats(uuid) from public;
revoke execute on function public.get_customer_stats(uuid) from anon;
grant execute on function public.get_customer_stats(uuid) to authenticated;

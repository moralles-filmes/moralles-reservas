-- Disposable projection for the standalone public waitlist IP limiter.
-- Never apply to a linked project database.
\set ON_ERROR_STOP on
begin;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon,authenticated,service_role;
create table if not exists public.organizations(id uuid primary key,is_public boolean not null);
create table if not exists public.units(
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  is_public boolean not null
);
create table if not exists public.waitlist(
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id),
  customer_name text not null,
  customer_phone text,
  party_size integer not null,
  notes text,
  priority_category text not null,
  status text not null default 'waiting',
  code integer not null default 1
);
alter table public.waitlist enable row level security;
drop policy if exists "anon_insert_waitlist" on public.waitlist;
create policy "anon_insert_waitlist" on public.waitlist
  for insert to anon with check(status='waiting' and party_size between 1 and 20);
grant insert on public.waitlist to anon,authenticated,service_role;
-- Drift fixture: independent column-level ACL must also be closed.
grant insert(customer_name) on public.waitlist to anon;

create or replace function public.enter_waitlist(
  p_unit_id uuid,p_customer_name text,p_customer_phone text,p_party_size integer,
  p_notes text,p_priority_category text,p_requested_for_time time
) returns table(waitlist_id uuid,code integer)
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_code integer;
begin
  insert into public.waitlist(unit_id,customer_name,customer_phone,party_size,notes,priority_category)
  values(p_unit_id,p_customer_name,p_customer_phone,p_party_size,p_notes,p_priority_category)
  returning id,public.waitlist.code into v_id,v_code;
  return query select v_id,v_code;
end $$;
revoke all on function public.enter_waitlist(uuid,text,text,integer,text,text,time)
  from public,anon,authenticated,service_role;
grant execute on function public.enter_waitlist(uuid,text,text,integer,text,text,time)
  to anon,authenticated;

create table if not exists public.rate_limit_events(
  id bigserial primary key,
  phone text not null,
  unit_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_phone_created_idx
  on public.rate_limit_events(phone,created_at desc);
alter table public.rate_limit_events enable row level security;
commit;

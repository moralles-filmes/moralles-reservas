-- Disposable local PostgreSQL only. Apply before migration 20261017130000.
begin;
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists app_private;
create table public.reservations (
  id uuid primary key,
  status text not null
);
insert into public.reservations values
  ('00000000-0000-4000-8000-000000000001', 'cancelled'),
  ('00000000-0000-4000-8000-000000000002', 'confirmed');
commit;

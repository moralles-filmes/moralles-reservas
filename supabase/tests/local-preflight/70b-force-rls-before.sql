-- Run after 70a and the real 20261017173000 migration, before 180000.
-- Capture ACL/policies and prove that a non-BYPASSRLS owner currently bypasses.
\set ON_ERROR_STOP on
create table public.force_rls_fixture_snapshot(
  table_name text primary key,
  owner_name text not null,
  table_acl text,
  column_acl jsonb not null,
  policies jsonb not null
);
insert into public.force_rls_fixture_snapshot
select c.relname, c.relowner::regrole::text, c.relacl::text,
  (select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text)
      order by a.attnum),'[]'::jsonb)
     from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  (select coalesce(jsonb_agg(to_jsonb(p) order by p.policyname),'[]'::jsonb)
     from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
from pg_class c
where c.oid in (
  'public.reservations'::regclass,'public.waitlist'::regclass,
  'public.conversations'::regclass,'public.notifications_sent'::regclass,
  'public.rate_limit_events'::regclass
);
do $$ begin
  if (select count(*) from public.force_rls_fixture_snapshot)<>5
    or exists(select from pg_class c join public.force_rls_fixture_snapshot s on s.table_name=c.relname
      where c.relnamespace='public'::regnamespace
        and (not c.relrowsecurity or c.relforcerowsecurity
          or s.owner_name<>'force_rls_fixture_owner'))
    or (select rolbypassrls from pg_roles where rolname='force_rls_fixture_owner') is distinct from false
    or (select rolbypassrls from pg_roles where rolname='service_role') is distinct from true then
    raise exception 'FAIL70 pre-migration owner/RLS/role baseline';
  end if;
end $$;

begin;
set local role force_rls_fixture_owner;
do $$ declare affected integer; begin
  if (select count(*) from public.reservations)<>2
    or (select count(*) from public.waitlist)<>2
    or (select count(*) from public.conversations)<>2
    or (select count(*) from public.notifications_sent)<>2
    or (select count(*) from public.rate_limit_events)<>2 then
    raise exception 'FAIL70 pre-migration owner did not bypass all five';
  end if;
  update public.rate_limit_events set phone='owner-before'
    where phone='fixture-a';
  get diagnostics affected = row_count;
  if affected<>1 then
    raise exception 'FAIL70 pre-migration owner did not bypass write';
  end if;
end $$;
rollback;
select 'GREEN70-before' as result;

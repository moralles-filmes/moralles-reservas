-- Disposable projection of the five operational tables. Apply after 69a in
-- an isolated local PostgreSQL Supabase container, never in a linked project.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if not exists(select from pg_roles where rolname='force_rls_fixture_owner') then
    create role force_rls_fixture_owner nologin noinherit nobypassrls;
  end if;
end $$;
grant force_rls_fixture_owner to postgres;
grant usage,create on schema public to force_rls_fixture_owner;

create table public.reservations(id uuid primary key, unit_id uuid not null references public.units(id));
create table public.conversations(id uuid primary key, unit_id uuid not null references public.units(id),
  messages jsonb not null default '[]'::jsonb, status text not null default 'ai_active');
create table public.notifications_sent(id uuid primary key, unit_id uuid not null references public.units(id),
  status text not null default 'sent');
create table public.force_rls_fixture_members(user_id uuid not null, unit_id uuid not null,
  primary key(user_id,unit_id));
create table public.force_rls_fixture_admins(user_id uuid primary key);

alter table public.reservations enable row level security;
alter table public.conversations enable row level security;
alter table public.notifications_sent enable row level security;

-- Shape of the current policies. These are fixture policies, not a replay of
-- the historical migrations; live policy equivalence is a separate gate.
create policy fixture_anon_insert_reservations on public.reservations
  for insert to anon with check(exists(
    select from public.units u join public.organizations o on o.id=u.organization_id
     where u.id=unit_id and u.is_public and o.is_public));
create policy fixture_member_reservations on public.reservations for all to authenticated
  using(exists(select from public.force_rls_fixture_members m
    where m.unit_id=reservations.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_members m
    where m.unit_id=reservations.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)));
create policy fixture_admin_reservations on public.reservations for all to authenticated
  using(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)));

-- 69a supplies the historical anon INSERT policy; 173000 removes it. Add the
-- authenticated policies that remain after that migration.
create policy fixture_member_waitlist on public.waitlist for all to authenticated
  using(exists(select from public.force_rls_fixture_members m
    where m.unit_id=waitlist.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_members m
    where m.unit_id=waitlist.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)));
create policy fixture_admin_waitlist on public.waitlist for all to authenticated
  using(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)));

create policy fixture_member_conversations on public.conversations for all to authenticated
  using(exists(select from public.force_rls_fixture_members m
    where m.unit_id=conversations.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_members m
    where m.unit_id=conversations.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)));
create policy fixture_admin_conversations on public.conversations for all to authenticated
  using(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)))
  with check(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)));

create policy fixture_member_notifications on public.notifications_sent for select to authenticated
  using(exists(select from public.force_rls_fixture_members m
    where m.unit_id=notifications_sent.unit_id
      and m.user_id::text=current_setting('request.jwt.claim.sub',true)));
create policy fixture_admin_notifications on public.notifications_sent for select to authenticated
  using(exists(select from public.force_rls_fixture_admins a
    where a.user_id::text=current_setting('request.jwt.claim.sub',true)));

grant select(id,is_public,organization_id) on public.units to anon;
grant select(id,is_public) on public.organizations to anon;
grant select on public.force_rls_fixture_members, public.force_rls_fixture_admins to authenticated;
grant select,insert on public.reservations to anon;
grant select,insert,update,delete on public.reservations,public.waitlist to authenticated;
grant select,update(status) on public.conversations to authenticated;
grant select on public.notifications_sent to authenticated;
grant select on public.waitlist,public.conversations,public.notifications_sent,
  public.rate_limit_events to anon;
grant select,insert,update,delete on public.reservations,public.waitlist,
  public.conversations,public.notifications_sent,public.rate_limit_events to service_role;

insert into public.organizations(id,is_public) values
  ('70000000-0000-4000-8000-000000000001',true),
  ('70000000-0000-4000-8000-000000000002',true);
insert into public.units(id,organization_id,is_public) values
  ('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000001',true),
  ('70000000-0000-4000-8000-000000000022','70000000-0000-4000-8000-000000000002',true);
insert into public.force_rls_fixture_members(user_id,unit_id) values
  ('70000000-0000-4000-8000-000000000101','70000000-0000-4000-8000-000000000011');
insert into public.force_rls_fixture_admins(user_id) values
  ('70000000-0000-4000-8000-000000000102');
insert into public.reservations(id,unit_id) values
  ('70000000-0000-4000-8000-000000001011','70000000-0000-4000-8000-000000000011'),
  ('70000000-0000-4000-8000-000000001022','70000000-0000-4000-8000-000000000022');
insert into public.waitlist(id,unit_id,customer_name,party_size,priority_category) values
  ('70000000-0000-4000-8000-000000002011','70000000-0000-4000-8000-000000000011','A',2,'normal'),
  ('70000000-0000-4000-8000-000000002022','70000000-0000-4000-8000-000000000022','B',2,'normal');
insert into public.conversations(id,unit_id) values
  ('70000000-0000-4000-8000-000000003011','70000000-0000-4000-8000-000000000011'),
  ('70000000-0000-4000-8000-000000003022','70000000-0000-4000-8000-000000000022');
insert into public.notifications_sent(id,unit_id) values
  ('70000000-0000-4000-8000-000000004011','70000000-0000-4000-8000-000000000011'),
  ('70000000-0000-4000-8000-000000004022','70000000-0000-4000-8000-000000000022');
insert into public.rate_limit_events(phone,unit_id) values
  ('fixture-a','70000000-0000-4000-8000-000000000011'),
  ('fixture-b','70000000-0000-4000-8000-000000000022');

alter table public.reservations owner to force_rls_fixture_owner;
alter table public.waitlist owner to force_rls_fixture_owner;
alter table public.conversations owner to force_rls_fixture_owner;
alter table public.notifications_sent owner to force_rls_fixture_owner;
alter table public.rate_limit_events owner to force_rls_fixture_owner;
commit;

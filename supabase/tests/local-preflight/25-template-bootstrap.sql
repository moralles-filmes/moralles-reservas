-- Isolated fixture for 26-template-catalog.sql; never replay this in production.
-- Preserves installed Supabase Auth/GoTrue functions. Standalone PostgreSQL may
-- create missing roles/helpers, but that mode proves SQL only, never real JWT.
begin;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create schema if not exists app_private;
do $$ begin
  if to_regclass('auth.users') is null then execute 'create table auth.users(id uuid primary key)'; end if;
end $$;
do $outer$ begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$create function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$$fn$;
  end if;
  if to_regprocedure('auth.role()') is null then
    execute $fn$create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')$$$fn$;
  end if;
end $outer$;
-- Conditional copy of migration 060's canonicalizer, including DDD 55 handling.
do $outer$ begin
  if to_regprocedure('public.normalize_br_phone(text)') is null then
    execute $fn$create function public.normalize_br_phone(raw text) returns text language plpgsql immutable as $$declare d text; begin
      d:=regexp_replace(coalesce(raw,''),'[^0-9]','','g');
      if length(d) in(12,13) and left(d,2)='55' then d:=substr(d,3); end if;
      if length(d)=10 and substr(d,3,1) in('6','7','8','9') then d:=substr(d,1,2)||'9'||substr(d,3); end if;
      return d;
    end $$ $fn$;
    revoke all on function public.normalize_br_phone(text) from public,anon,authenticated,service_role;
  end if;
end $outer$;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create table if not exists public.organizations(id uuid primary key, name text not null);
create table if not exists public.units(id uuid primary key, organization_id uuid not null references public.organizations(id) on delete cascade, name text not null);
create table if not exists public.unit_members(id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, unit_id uuid not null references public.units(id) on delete cascade, role text not null check(role in('owner','gerente','operador')), unique(user_id,unit_id));
create table if not exists public.platform_admins(user_id uuid primary key references auth.users(id) on delete cascade);
create table if not exists public.whatsapp_channels(id uuid primary key, unit_id uuid not null references public.units(id) on delete cascade, provider text not null check(provider in('zapi','waha','official','uazapi','datafy')), status text not null, is_active boolean, credentials jsonb not null default '{}', webhook_secret text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists public.customers(id uuid primary key, organization_id uuid not null references public.organizations(id) on delete cascade, name text not null, phone text not null, deleted_at timestamptz, do_not_contact boolean not null default false,unique(organization_id,phone));
create table if not exists public.reservations(id uuid primary key, unit_id uuid not null references public.units(id) on delete cascade, customer_id uuid not null references public.customers(id) on delete cascade, status text not null default 'confirmed');
create table if not exists public.waitlist(id uuid primary key, unit_id uuid not null references public.units(id) on delete cascade, customer_id uuid references public.customers(id) on delete set null,customer_phone text,customer_name text, status text not null default 'waiting');
create table if not exists public.vouchers(id uuid primary key, unit_id uuid not null references public.units(id) on delete cascade, customer_id uuid not null references public.customers(id) on delete cascade, status text not null default 'active');
-- Task4 columns mirror the legacy final schema actually consumed by the RPCs.
alter table public.whatsapp_channels add column if not exists last_health_check_at timestamptz;
create table if not exists public.platform_flags(key text primary key,value jsonb not null);
create table if not exists public.notifications_sent(
  id uuid primary key default gen_random_uuid(),unit_id uuid not null references public.units(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,waitlist_id uuid references public.waitlist(id) on delete cascade,
  kind text not null check(kind in('confirmation','confirmation_email','reminder_d1','survey_d1','cancellation','waitlist_entered','waitlist_table_ready','waitlist_feedback','voucher_issued')),
  status text not null default 'sent' check(status in('sent','failed','skipped')),sent_at timestamptz not null default now(),error text,
  provider_message_id text,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,whatsapp_provider text,whatsapp_channel_id uuid,
  unique(reservation_id,kind),unique(waitlist_id,kind)
);
create table if not exists public.reservation_message_templates(id uuid primary key default gen_random_uuid(), unit_id uuid not null references public.units(id) on delete cascade, event text not null check(event in('reminder_d1','survey_d1')), body text not null default '', customized boolean not null default false, created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(unit_id,event));
create table if not exists public.waitlist_message_templates(id uuid primary key default gen_random_uuid(), unit_id uuid not null references public.units(id) on delete cascade, event text not null check(event in('entered','table_ready','feedback')), body text not null default '', customized boolean not null default false, created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(unit_id,event));
create table if not exists public.settings(id uuid primary key default gen_random_uuid(),unit_id uuid not null references public.units(id) on delete cascade,key text not null,value jsonb not null,unique(unit_id,key));
create table if not exists public.audit_log(id bigint generated by default as identity primary key,table_name text not null,record_id text not null,action text not null check(action in('INSERT','UPDATE','DELETE')),old_values jsonb,new_values jsonb,actor_id uuid,actor_email text,unit_id uuid references public.units(id) on delete set null,organization_id uuid references public.organizations(id) on delete set null,created_at timestamptz not null default now());
create or replace function app_private.is_unit_member(p_user_id uuid,p_unit_id uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select from public.unit_members where user_id=p_user_id and unit_id=p_unit_id)$$;
create or replace function app_private.is_platform_admin(p_user_id uuid) returns boolean language sql stable security definer set search_path='' as $$select exists(select from public.platform_admins where user_id=p_user_id)$$;
revoke all on function app_private.is_unit_member(uuid,uuid) from public,anon,authenticated;
revoke all on function app_private.is_platform_admin(uuid) from public,anon,authenticated;
grant execute on function app_private.is_unit_member(uuid,uuid),app_private.is_platform_admin(uuid) to authenticated,service_role;
revoke all on schema app_private from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['reservation_message_templates','waitlist_message_templates','settings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists fixture_members on public.%I',t);
    if t='settings' then
      execute format('create policy fixture_members on public.%I for all to authenticated using(app_private.is_unit_member(auth.uid(),unit_id) or app_private.is_platform_admin(auth.uid())) with check(app_private.is_unit_member(auth.uid(),unit_id) or app_private.is_platform_admin(auth.uid()))',t);
    else
      execute format('create policy fixture_members on public.%I for all to authenticated using(app_private.is_unit_member(auth.uid(),unit_id)) with check(app_private.is_unit_member(auth.uid(),unit_id))',t);
    end if;
  end loop;
end $$;
alter table public.whatsapp_channels enable row level security;
alter table public.whatsapp_channels force row level security;
revoke all on public.whatsapp_channels from public,anon,authenticated;
grant select,insert,update,delete on public.whatsapp_channels to service_role;
insert into public.organizations values('aaaaaaaa-0000-0000-0000-000000000001','Org A'),('aaaaaaaa-0000-0000-0000-000000000002','Org B') on conflict do nothing;
insert into public.units values('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','A1'),('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','A2'),('bbbbbbbb-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','B1') on conflict do nothing;
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active) values('dddddddd-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','datafy','connected',true),('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','official','connected',true),('dddddddd-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000003','zapi','connected',true) on conflict do nothing;
insert into public.customers(id,organization_id,name,phone) values('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Fixture A','11911110001'),('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','Fixture B','11911110002') on conflict do nothing;
insert into public.reservations(id,unit_id,customer_id) values('eeeeeeee-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001') on conflict do nothing;
insert into public.waitlist(id,unit_id,customer_phone,customer_name) values('eeeeeeee-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001','+55 (11) 91111-0001','Fixture A') on conflict do nothing;
insert into public.vouchers(id,unit_id,customer_id) values('eeeeeeee-0000-0000-0000-000000000003','bbbbbbbb-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001') on conflict do nothing;
-- Legacy texts intentionally seeded before guards, proving migration keeps them.
insert into public.reservation_message_templates(unit_id,event,body,customized) values('bbbbbbbb-0000-0000-0000-000000000001','reminder_d1','Texto legado preservado',true) on conflict do nothing;
commit;

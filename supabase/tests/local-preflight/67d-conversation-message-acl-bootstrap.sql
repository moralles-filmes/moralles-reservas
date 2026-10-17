-- Disposable, minimal projection of the conversations schema and Supabase's
-- default table grants. This bootstrap never runs against a project database.
\set ON_ERROR_STOP on
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
grant usage on schema auth to authenticated, service_role;
create table if not exists auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table if not exists public.organizations(id uuid primary key, name text not null);
create table if not exists public.units(id uuid primary key, organization_id uuid not null references public.organizations(id),
  name text not null, slug text not null, timezone text not null);
create table if not exists public.customers(id uuid primary key, organization_id uuid not null references public.organizations(id),
  name text not null, phone text not null, do_not_contact boolean not null default false, deleted_at timestamptz);
create table if not exists public.unit_members(user_id uuid not null references auth.users(id), unit_id uuid not null references public.units(id),
  role text not null, primary key(user_id,unit_id));
create table if not exists public.conversations(id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id), customer_id uuid not null references public.customers(id),
  status text not null default 'ai_active', messages jsonb not null default '[]'::jsonb,
  assigned_to uuid references auth.users(id), handoff_reason text, handoff_at timestamptz,
  updated_at timestamptz not null default now(), last_message_at timestamptz);
grant all on table public.conversations to anon, authenticated, service_role;
-- Simulate ACL drift: column grants survive table-level revokes.
grant update (messages) on table public.conversations to authenticated;
grant insert (messages) on table public.conversations to anon, authenticated;
grant select on table public.unit_members to authenticated;
alter table public.conversations enable row level security;
create policy fixture_conversations_member on public.conversations for all to authenticated
  using (exists(select from public.unit_members m where m.user_id=auth.uid() and m.unit_id=conversations.unit_id))
  with check (exists(select from public.unit_members m where m.user_id=auth.uid() and m.unit_id=conversations.unit_id));

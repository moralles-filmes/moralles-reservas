-- Disposable baseline for migration 20261017190000. Apply after 00-bootstrap.sql
-- in an isolated Supabase PostgreSQL container with no external network.
do $$ begin
  if to_regclass('public.whatsapp_ops_email_attempts') is not null then
    raise exception '71a must precede the ops email migration';
  end if;
end $$;
create schema if not exists app_private;

-- Supabase default grants must exist before CREATE TABLE/FUNCTION so the
-- migration's revokes are tested against an initially broad baseline.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
-- FOR KEY SHARE in the INVOKER RPC also requires UPDATE privilege. Existing
-- production tables grant service_role full access; the fixture mirrors that.
grant select, update on public.units, public.whatsapp_channels to service_role;

insert into public.organizations(id, name) values
  ('70000000-0000-4000-8000-000000000001', 'Fixture A'),
  ('70000000-0000-4000-8000-000000000002', 'Fixture B');
insert into public.units(id, organization_id, name) values
  ('70000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000001', 'A'),
  ('70000000-0000-4000-8000-000000000022', '70000000-0000-4000-8000-000000000002', 'B');
insert into public.whatsapp_channels(id, unit_id, provider, status) values
  ('70000000-0000-4000-8000-000000000111', '70000000-0000-4000-8000-000000000011', 'official', 'connected'),
  ('70000000-0000-4000-8000-000000000222', '70000000-0000-4000-8000-000000000022', 'official', 'connected');

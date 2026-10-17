-- 67d: execute after 20261017160000 on disposable local PostgreSQL.
-- Tests effective ACL and actual authenticated/service-role statements.
\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare role_name text; column_name text;
begin
  foreach role_name in array array['public','anon','authenticated'] loop
    if role_name <> 'public' and (has_table_privilege(role_name, 'public.conversations', 'INSERT')
      or has_table_privilege(role_name, 'public.conversations', 'UPDATE')
      or has_table_privilege(role_name, 'public.conversations', 'DELETE')
      or has_table_privilege(role_name, 'public.conversations', 'TRUNCATE')) then
      raise exception 'FAIL67d table write ACL open for %', role_name;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'public.conversations', 'messages', 'UPDATE')
    or has_column_privilege('authenticated', 'public.conversations', 'customer_id', 'UPDATE')
    or has_column_privilege('authenticated', 'public.conversations', 'last_message_at', 'UPDATE') then
    raise exception 'FAIL67d protected column writable';
  end if;
  for column_name in select a.attname from pg_catalog.pg_attribute a
    where a.attrelid = 'public.conversations'::pg_catalog.regclass
      and a.attnum > 0 and not a.attisdropped loop
    if has_column_privilege('authenticated', 'public.conversations', column_name, 'INSERT')
      or has_column_privilege('anon', 'public.conversations', column_name, 'INSERT') then
      raise exception 'FAIL67d column INSERT open on %', column_name;
    end if;
  end loop;
  foreach column_name in array array['status','assigned_to','handoff_reason','handoff_at','updated_at'] loop
    if not has_column_privilege('authenticated', 'public.conversations', column_name, 'UPDATE') then
      raise exception 'FAIL67d handoff column % unavailable', column_name;
    end if;
  end loop;
  if not has_column_privilege('service_role', 'public.conversations', 'messages', 'UPDATE')
    or not has_table_privilege('service_role', 'public.conversations', 'INSERT') then
    raise exception 'FAIL67d service writer unavailable';
  end if;
end $$;

do $$
declare actor uuid := gen_random_uuid(); org uuid := gen_random_uuid(); unit uuid := gen_random_uuid();
  customer uuid := gen_random_uuid(); conversation uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(actor);
  insert into public.organizations(id,name) values(org,'Fixture67d');
  insert into public.units(id,organization_id,name,slug,timezone)
    values(unit,org,'Fixture67d','fixture67d-' || unit,'America/Sao_Paulo');
  insert into public.unit_members(user_id,unit_id,role) values(actor,unit,'operador');
  insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at)
    values(customer,org,'Fixture67d customer','11999996767',false,null);
  insert into public.conversations(id,unit_id,customer_id,status,messages)
    values(conversation,unit,customer,'awaiting_human','[]'::jsonb);
  perform set_config('task67d.actor', actor::text, true);
  perform set_config('task67d.unit', unit::text, true);
  perform set_config('task67d.customer', customer::text, true);
  perform set_config('task67d.conversation', conversation::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('task67d.actor'), true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;

do $$
declare conv uuid := current_setting('task67d.conversation')::uuid;
  unit uuid := current_setting('task67d.unit')::uuid;
  customer uuid := current_setting('task67d.customer')::uuid;
  affected integer;
begin
  begin
    update public.conversations set messages = '[{"role":"user","timestamp":"2026-10-16T15:00:00Z"}]'::jsonb where id = conv;
    raise exception 'FAIL67d authenticated spoof UPDATE succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.conversations(unit_id,customer_id,messages) values
      (unit,customer,'[{"role":"user","timestamp":"2026-10-16T15:00:00Z"}]'::jsonb);
    raise exception 'FAIL67d authenticated spoof INSERT succeeded';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.conversations where id = conv;
    raise exception 'FAIL67d authenticated DELETE succeeded';
  exception when insufficient_privilege then null; end;
  update public.conversations set status='human_active', assigned_to=current_setting('task67d.actor')::uuid,
    handoff_reason='Fixture67d handoff', handoff_at=clock_timestamp(), updated_at=clock_timestamp()
    where id = conv;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL67d authenticated handoff denied'; end if;
end $$;

reset role;
-- Positive control: granting just the protected column must make the
-- previously refused spoof succeed. ROLLBACK restores the production ACL.
grant update (messages) on public.conversations to authenticated;
set local role authenticated;
do $$
declare conv uuid := current_setting('task67d.conversation')::uuid; affected integer;
begin
  update public.conversations set messages = '[{"role":"user","timestamp":"2026-10-16T15:00:00Z"}]'::jsonb where id = conv;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL67d positive control did not expose spoof'; end if;
end $$;
reset role;
revoke update (messages) on public.conversations from authenticated;

grant insert (unit_id, customer_id, messages) on public.conversations to authenticated;
set local role authenticated;
do $$
declare unit uuid := current_setting('task67d.unit')::uuid;
  customer uuid := current_setting('task67d.customer')::uuid;
begin
  insert into public.conversations(unit_id,customer_id,messages)
    values(unit,customer,'[{"role":"user","timestamp":"2026-10-16T15:00:00Z"}]'::jsonb);
end $$;
reset role;
revoke insert (unit_id, customer_id, messages) on public.conversations from authenticated;

set local role service_role;
do $$
declare conv uuid := current_setting('task67d.conversation')::uuid;
  unit uuid := current_setting('task67d.unit')::uuid;
  customer uuid := current_setting('task67d.customer')::uuid; affected integer;
begin
  update public.conversations set messages='[{"role":"user","timestamp":"2026-10-16T15:00:00Z"}]'::jsonb where id=conv;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'FAIL67d service UPDATE denied'; end if;
  insert into public.conversations(unit_id,customer_id,messages) values(unit,customer,'[]'::jsonb);
end $$;
reset role;

select 'GREEN67d' as result;
rollback;

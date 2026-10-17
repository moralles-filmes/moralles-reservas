-- Run after 69a bootstrap and migration 20261017173000 in disposable DB.
\set ON_ERROR_STOP on
begin;
insert into public.organizations(id,is_public) values
  ('69000000-0000-4000-8000-000000000101',true),
  ('69000000-0000-4000-8000-000000000102',false);
insert into public.units(id,organization_id,is_public) values
  ('69000000-0000-4000-8000-000000000111','69000000-0000-4000-8000-000000000101',true),
  ('69000000-0000-4000-8000-000000000112','69000000-0000-4000-8000-000000000101',false),
  ('69000000-0000-4000-8000-000000000113','69000000-0000-4000-8000-000000000102',true);

-- Effective privileges through independent role changes, not only metadata.
set local role anon;
do $$ begin
  begin
    perform * from public.enter_waitlist('69000000-0000-4000-8000-000000000111','Test','11999998888',2,null,'normal',null);
    raise exception 'FAIL69 anon RPC allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.waitlist(unit_id,customer_name,party_size,priority_category)
    values('69000000-0000-4000-8000-000000000111','Test',2,'normal');
    raise exception 'FAIL69 anon direct INSERT allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000111','Test','11999998888',2,null,'normal');
    raise exception 'FAIL69 anon wrapper allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
do $$ begin
  perform * from public.enter_waitlist('69000000-0000-4000-8000-000000000111','Internal','11999998888',2,null,'normal',null);
  begin
    perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000111','Test','11999998888',2,null,'normal');
    raise exception 'FAIL69 authenticated wrapper allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role service_role;
do $$ begin
  begin
    perform * from public.enter_waitlist('69000000-0000-4000-8000-000000000111','Direct','11999998888',2,null,'normal',null);
    raise exception 'FAIL69 service direct legacy RPC allowed';
  exception when insufficient_privilege then null; end;
  perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000111','Public','11999998888',2,null,'normal');
  begin
    perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000112','Private unit','11999998888',2,null,'normal');
    raise exception 'FAIL69 private unit allowed';
  exception when sqlstate '42501' then null; end;
  begin
    perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000113','Private org','11999998888',2,null,'normal');
    raise exception 'FAIL69 private org allowed';
  exception when sqlstate '42501' then null; end;
  begin
    perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000111','Too many','11999998888',21,null,'normal');
    raise exception 'FAIL69 party cap bypass';
  exception when sqlstate '22023' then null; end;
end $$;
reset role;

do $$
declare
  v_unit uuid := '69000000-0000-4000-8000-000000000001';
  v_other uuid := '69000000-0000-4000-8000-000000000002';
  v_ip text := 'public-waitlist-ip:' || repeat('a',64);
  v_other_ip text := 'public-waitlist-ip:' || repeat('b',64);
  i integer;
begin
  if has_table_privilege('anon','public.waitlist','INSERT')
    or exists(select 1 from pg_catalog.pg_attribute a
      where a.attrelid='public.waitlist'::regclass and a.attnum>0 and not a.attisdropped
        and has_column_privilege('anon','public.waitlist',a.attname,'INSERT')) then
    raise exception 'FAIL69 anon table/column INSERT ACL';
  end if;
  if (select count(*) from public.waitlist) <> 2
    or (select count(*) from public.waitlist where customer_name in('Internal','Public')) <> 2 then
    raise exception 'FAIL69 public wrapper/panel persistence';
  end if;
  if to_regprocedure('public.check_public_waitlist_rate_limit(uuid,text)') is null then
    raise exception 'FAIL69 function missing';
  end if;
  if has_function_privilege('anon','public.check_public_waitlist_rate_limit(uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.check_public_waitlist_rate_limit(uuid,text)','EXECUTE')
    or not has_function_privilege('service_role','public.check_public_waitlist_rate_limit(uuid,text)','EXECUTE') then
    raise exception 'FAIL69 ACL';
  end if;
  if (select prosecdef from pg_proc where oid='public.check_public_waitlist_rate_limit(uuid,text)'::regprocedure) is distinct from true
    or (select proconfig from pg_proc where oid='public.check_public_waitlist_rate_limit(uuid,text)'::regprocedure)
       is distinct from array['search_path=""']::text[] then
    raise exception 'FAIL69 security shape';
  end if;

  for i in 1..5 loop
    if public.check_public_waitlist_rate_limit(v_unit,v_ip) is distinct from true then
      raise exception 'FAIL69 allowed attempt %',i;
    end if;
  end loop;
  if public.check_public_waitlist_rate_limit(v_unit,v_ip) is distinct from false then
    raise exception 'FAIL69 sixth attempt';
  end if;
  if public.check_public_waitlist_rate_limit(v_other,v_ip) is distinct from true
    or public.check_public_waitlist_rate_limit(v_unit,v_other_ip) is distinct from true then
    raise exception 'FAIL69 separate buckets';
  end if;
  if (select count(*) from public.rate_limit_events where unit_id=v_unit and phone=v_ip) <> 5 then
    raise exception 'FAIL69 persisted count';
  end if;

  begin
    perform public.check_public_waitlist_rate_limit(null,v_ip);
    raise exception 'FAIL69 null unit allowed';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.check_public_waitlist_rate_limit(v_unit,'203.0.113.9');
    raise exception 'FAIL69 unhashed IP allowed';
  exception when sqlstate '22023' then null; end;
end $$;

-- Positive controls for the wrapper guards: the same rows become eligible
-- when only their respective public flag is restored inside this transaction.
update public.units set is_public=true
 where id='69000000-0000-4000-8000-000000000112';
set local role service_role;
do $$ begin
  perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000112','Unit control','11999998888',2,null,'normal');
end $$;
reset role;
update public.units set is_public=false
 where id='69000000-0000-4000-8000-000000000112';

update public.organizations set is_public=true
 where id='69000000-0000-4000-8000-000000000102';
set local role service_role;
do $$ begin
  perform * from public.enter_public_waitlist('69000000-0000-4000-8000-000000000113','Org control','11999998888',2,null,'normal');
end $$;
reset role;
update public.organizations set is_public=false
 where id='69000000-0000-4000-8000-000000000102';
rollback;

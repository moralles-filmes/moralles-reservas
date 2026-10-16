-- Run after 70a, 173000, 70b and real 180000 in a disposable database.
-- Repeat after each reapplication of 180000. Everything here rolls back.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if (select count(*) from public.force_rls_fixture_snapshot)<>5
    or exists(
      select from pg_class c join public.force_rls_fixture_snapshot s on s.table_name=c.relname
       where c.relnamespace='public'::regnamespace
         and (not c.relrowsecurity or not c.relforcerowsecurity
           or c.relowner::regrole::text<>s.owner_name
           or c.relacl::text is distinct from s.table_acl
           or (select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text)
                 order by a.attnum),'[]'::jsonb)
                from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
              is distinct from s.column_acl
           or (select coalesce(jsonb_agg(to_jsonb(p) order by p.policyname),'[]'::jsonb)
                from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
              is distinct from s.policies)) then
    raise exception 'FAIL70 FORCE/catalog delta';
  end if;
  if exists(select from pg_policies where schemaname='public' and tablename='rate_limit_events') then
    raise exception 'FAIL70 rate_limit_events gained a policy';
  end if;
end $$;

-- FORCE applies to the non-BYPASSRLS owner of the real five fixture tables.
set local role force_rls_fixture_owner;
do $$ declare affected integer; begin
  if (select count(*) from public.reservations)<>0
    or (select count(*) from public.waitlist)<>0
    or (select count(*) from public.conversations)<>0
    or (select count(*) from public.notifications_sent)<>0
    or (select count(*) from public.rate_limit_events)<>0 then
    raise exception 'FAIL70 owner still bypasses FORCE';
  end if;
  update public.rate_limit_events set phone='owner-forbidden'
    where phone='fixture-a';
  get diagnostics affected = row_count;
  if affected<>0 then
    raise exception 'FAIL70 owner UPDATE bypassed FORCE';
  end if;
end $$;
reset role;

-- Service role bypass remains effective, including the table with no policy.
set local role service_role;
do $$ declare i integer; begin
  if (select count(*) from public.reservations)<>2
    or (select count(*) from public.waitlist)<>2
    or (select count(*) from public.conversations)<>2
    or (select count(*) from public.notifications_sent)<>2
    or (select count(*) from public.rate_limit_events)<>2 then
    raise exception 'FAIL70 service_role lost BYPASSRLS';
  end if;
  if not has_function_privilege('service_role',
      'public.enter_public_waitlist(uuid,text,text,integer,text,text)','EXECUTE')
    or not has_function_privilege('service_role',
      'public.check_public_waitlist_rate_limit(uuid,text)','EXECUTE') then
    raise exception 'FAIL70 service RPC ACL';
  end if;
  perform * from public.enter_public_waitlist(
    '70000000-0000-4000-8000-000000000011','Public','11999998888',2,null,'normal');
  if (select count(*) from public.waitlist)<>3 then
    raise exception 'FAIL70 service waitlist wrapper did not insert';
  end if;
  for i in 1..5 loop
    if public.check_public_waitlist_rate_limit(
      '70000000-0000-4000-8000-000000000011',
      'public-waitlist-ip:' || repeat('a',64)) is distinct from true then
      raise exception 'FAIL70 limiter allowed attempt %',i;
    end if;
  end loop;
  if public.check_public_waitlist_rate_limit(
    '70000000-0000-4000-8000-000000000011',
    'public-waitlist-ip:' || repeat('a',64)) is distinct from false then
    raise exception 'FAIL70 limiter sixth attempt';
  end if;
end $$;
reset role;

-- The fixture mirrors the auth/member/admin policy shape, not their exact
-- migration definitions. This checks that FORCE does not filter these actors.
select set_config('request.jwt.claim.sub','70000000-0000-4000-8000-000000000101',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.reservations)<>1
    or (select count(*) from public.waitlist)<>2
    or (select count(*) from public.conversations)<>1
    or (select count(*) from public.notifications_sent)<>1
    or (select count(*) from public.rate_limit_events)<>0 then
    raise exception 'FAIL70 member access';
  end if;
  update public.conversations set status='human_active'
   where id='70000000-0000-4000-8000-000000003011';
  if (select status from public.conversations
       where id='70000000-0000-4000-8000-000000003011')<>'human_active' then
    raise exception 'FAIL70 member handoff';
  end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub','70000000-0000-4000-8000-000000000102',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.reservations)<>2
    or (select count(*) from public.waitlist)<>3
    or (select count(*) from public.conversations)<>2
    or (select count(*) from public.notifications_sent)<>2 then
    raise exception 'FAIL70 platform admin access';
  end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub','70000000-0000-4000-8000-000000000199',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.reservations)<>0
    or (select count(*) from public.waitlist)<>0
    or (select count(*) from public.conversations)<>0
    or (select count(*) from public.notifications_sent)<>0 then
    raise exception 'FAIL70 outsider saw tenant rows';
  end if;
end $$;
reset role;

set local role anon;
do $$ begin
  if (select count(*) from public.reservations)<>0
    or (select count(*) from public.waitlist)<>0
    or (select count(*) from public.conversations)<>0
    or (select count(*) from public.notifications_sent)<>0
    or (select count(*) from public.rate_limit_events)<>0 then
    raise exception 'FAIL70 anon read';
  end if;
  if has_function_privilege('anon',
       'public.enter_waitlist(uuid,text,text,integer,text,text,time)','EXECUTE')
    or has_function_privilege('anon',
       'public.enter_public_waitlist(uuid,text,text,integer,text,text)','EXECUTE') then
    raise exception 'FAIL70 anon waitlist RPC EXECUTE';
  end if;
  begin
    insert into public.waitlist(unit_id,customer_name,party_size,priority_category)
    values('70000000-0000-4000-8000-000000000011','Forbidden',2,'normal');
    raise exception 'FAIL70 anon waitlist INSERT allowed';
  exception when insufficient_privilege then null; end;
  insert into public.reservations(id,unit_id)
  values('70000000-0000-4000-8000-000000001099','70000000-0000-4000-8000-000000000011');
end $$;
reset role;
do $$ begin
  if not exists(select from public.reservations
    where id='70000000-0000-4000-8000-000000001099') then
    raise exception 'FAIL70 anon reservation INSERT';
  end if;
end $$;

-- Positive control: disabling FORCE in this rollback-only transaction makes
-- the same owner see rows in all five tables. Re-enable and confirm DENY.
alter table public.reservations no force row level security;
alter table public.waitlist no force row level security;
alter table public.conversations no force row level security;
alter table public.notifications_sent no force row level security;
alter table public.rate_limit_events no force row level security;
set local role force_rls_fixture_owner;
do $$ declare affected integer; begin
  if (select count(*) from public.reservations)<2
    or (select count(*) from public.waitlist)<2
    or (select count(*) from public.conversations)<2
    or (select count(*) from public.notifications_sent)<2
    or (select count(*) from public.rate_limit_events)<2 then
    raise exception 'FAIL70 positive control did not reopen owner bypass';
  end if;
  update public.rate_limit_events set phone='owner-positive'
    where phone='fixture-a';
  get diagnostics affected = row_count;
  if affected<>1 then
    raise exception 'FAIL70 positive control did not reopen owner write';
  end if;
end $$;
reset role;
alter table public.reservations force row level security;
alter table public.waitlist force row level security;
alter table public.conversations force row level security;
alter table public.notifications_sent force row level security;
alter table public.rate_limit_events force row level security;
set local role force_rls_fixture_owner;
do $$ begin
  if (select count(*) from public.reservations)<>0
    or (select count(*) from public.waitlist)<>0
    or (select count(*) from public.conversations)<>0
    or (select count(*) from public.notifications_sent)<>0
    or (select count(*) from public.rate_limit_events)<>0 then
    raise exception 'FAIL70 positive control restore';
  end if;
end $$;
reset role;

rollback;
select 'GREEN70' as result;

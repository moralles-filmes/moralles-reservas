-- Run after 00-bootstrap, 71a, and the actual 20261017190000 migration in
-- isolated PostgreSQL. All test writes roll back; failure aborts psql.

begin;
set local role service_role;
do $$
declare
  a uuid := '70000000-0000-4000-8000-000000000011';
  b uuid := '70000000-0000-4000-8000-000000000022';
  ca uuid := '70000000-0000-4000-8000-000000000111';
  cb uuid := '70000000-0000-4000-8000-000000000222';
  r jsonb;
  attempt_id uuid;
  denied boolean;
begin
  r := public.reserve_whatsapp_ops_email_attempt(a, 'inbound_dead_letter', ca,
    2, null, now(), repeat('a',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-1 first reservation: %', r; end if;
  attempt_id := (r->>'attempt_id')::uuid;
  if not public.complete_whatsapp_ops_email_attempt(attempt_id, 'accepted', 'test_accept_1') then
    raise exception 'OPS-2 accepted transition';
  end if;
  r := public.reserve_whatsapp_ops_email_attempt(a, 'inbound_dead_letter', ca,
    2, null, now(), repeat('a',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'replay' or (r->>'attempt_id')::uuid is distinct from attempt_id then
    raise exception 'OPS-3 accepted replay: %', r;
  end if;
  r := public.reserve_whatsapp_ops_email_attempt(a, 'inbound_dead_letter', ca,
    2, null, now(), repeat('c',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'window' then
    raise exception 'OPS-4 changed digest must not replay: %', r;
  end if;
  r := public.reserve_whatsapp_ops_email_attempt(b, 'inbound_dead_letter', cb,
    2, null, now(), repeat('a',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-5 tenant B independent: %', r; end if;

  denied := false;
  begin
    perform public.reserve_whatsapp_ops_email_attempt(a, 'datafy_subscription_failed', cb,
      null, null, now(), repeat('d',64), 'ops-email-v1', repeat('b',64));
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'OPS-6 cross-unit channel accepted'; end if;
  denied := false;
  begin
    perform public.reserve_whatsapp_ops_email_attempt(
      '70000000-0000-4000-8000-000000000099', 'datafy_subscription_failed', null,
      null, null, now(), repeat('d',64), 'ops-email-v1', repeat('b',64));
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'OPS-7 nonexistent unit accepted'; end if;
  denied := false;
  begin
    update public.whatsapp_ops_email_attempts set payload_digest = repeat('d',64) where id = attempt_id;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'OPS-8 service role modified immutable column'; end if;
  if public.complete_whatsapp_ops_email_attempt(attempt_id, 'accepted', 'different_id') then
    raise exception 'OPS-9 accepted provider id overwritten';
  end if;
  r := public.reserve_whatsapp_ops_email_attempt(null, 'synthetic_test', null,
    null, null, now(), repeat('e',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-10 synthetic first attempt: %', r; end if;
  r := public.reserve_whatsapp_ops_email_attempt(null, 'synthetic_test', null,
    null, null, now(), repeat('f',64), 'ops-email-v1', repeat('b',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'unresolved' then
    raise exception 'OPS-11 synthetic daily and unresolved cap: %', r;
  end if;
  raise notice 'OPS-1..11 PASS';
end $$;
rollback;

-- A failed completion transaction cannot release the reserved attempt. The
-- savepoint models a DB persistence failure after the provider call; SQL does
-- not itself make or count provider requests (Task 4 fake-handler test does).
begin;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'datafy_subscription_failed', null,
    null, null, now(), repeat('8',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-23 reservation setup: %', r; end if;
end $$;
savepoint completion_fail;
do $$ declare attempt_id uuid; begin
  select id into attempt_id from public.whatsapp_ops_email_attempts
   where unit_id = '70000000-0000-4000-8000-000000000011'
     and alert_type = 'datafy_subscription_failed';
  if public.complete_whatsapp_ops_email_attempt(attempt_id, 'accepted', 'test_rolled_back') is distinct from true then
    raise exception 'OPS-23 completion setup';
  end if;
end $$;
rollback to savepoint completion_fail;
do $$ declare r jsonb; state text; begin
  select status into state from public.whatsapp_ops_email_attempts
   where unit_id = '70000000-0000-4000-8000-000000000011'
     and alert_type = 'datafy_subscription_failed';
  if state is distinct from 'reserved' then raise exception 'OPS-23 rollback did not preserve reservation: %', state; end if;
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'datafy_subscription_failed', null,
    null, null, now(), repeat('8',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'unresolved' then
    raise exception 'OPS-23 completion persistence failure allowed retry: %', r;
  end if;
  raise notice 'OPS-23 rolled-back completion keeps reserved attempt blocked PASS';
end $$;
rollback;

-- Accepted production alert: replay/changed digest are held inside 30 min;
-- after the rolling window a new attempt is allowed. Ages are fixture-only.
begin;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'inbound_backlog_stalled', null,
    null, 12, now(), repeat('1',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-18 setup: %', r; end if;
  if public.complete_whatsapp_ops_email_attempt((r->>'attempt_id')::uuid, 'accepted', 'test_window_30m') is distinct from true then
    raise exception 'OPS-18 acceptance setup';
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '29 minutes 59 seconds'
 where unit_id = '70000000-0000-4000-8000-000000000011'
   and alert_type = 'inbound_backlog_stalled';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'inbound_backlog_stalled', null,
    null, 12, now(), repeat('1',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'replay' then raise exception 'OPS-18 accepted replay inside 30m: %', r; end if;
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'inbound_backlog_stalled', null,
    null, 12, now(), repeat('3',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'window' then
    raise exception 'OPS-18 changed digest inside 30m: %', r;
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '30 minutes 1 second'
 where unit_id = '70000000-0000-4000-8000-000000000011'
   and alert_type = 'inbound_backlog_stalled';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'inbound_backlog_stalled', null,
    null, 12, now(), repeat('3',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-18 30m window did not roll: %', r; end if;
  raise notice 'OPS-18 accepted 30m rolling boundary PASS';
end $$;
rollback;

-- A missing completion grant must turn readiness off before any provider send.
begin;
revoke execute on function public.complete_whatsapp_ops_email_attempt(uuid,text,text) from service_role;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.check_whatsapp_ops_email_reservation_ready();
  if (r->>'ready')::boolean is distinct from false then raise exception 'OPS-21 completion RPC ACL drift was ready: %', r; end if;
  raise notice 'OPS-21 completion RPC drift fails closed PASS';
end $$;
rollback;

begin;
revoke update (provider_id) on public.whatsapp_ops_email_attempts from service_role;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.check_whatsapp_ops_email_reservation_ready();
  if (r->>'ready')::boolean is distinct from false then raise exception 'OPS-22 completion column ACL drift was ready: %', r; end if;
  raise notice 'OPS-22 completion column drift fails closed PASS';
end $$;
rollback;

-- A completed synthetic test remains within its separate 24 h budget.
begin;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(null, 'synthetic_test', null,
    null, null, now(), repeat('4',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-19 setup: %', r; end if;
  if public.complete_whatsapp_ops_email_attempt((r->>'attempt_id')::uuid, 'accepted', 'test_window_24h') is distinct from true then
    raise exception 'OPS-19 acceptance setup';
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '23 hours 59 minutes'
 where alert_type = 'synthetic_test';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(null, 'synthetic_test', null,
    null, null, now(), repeat('5',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'window' then
    raise exception 'OPS-19 synthetic cap inside 24h: %', r;
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '24 hours 1 minute'
 where alert_type = 'synthetic_test';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(null, 'synthetic_test', null,
    null, null, now(), repeat('5',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-19 synthetic 24h window did not roll: %', r; end if;
  raise notice 'OPS-19 accepted synthetic 24h rolling boundary PASS';
end $$;
rollback;

-- Test clock aging is fixture-only: temporarily disable the guard as postgres,
-- then re-enable it before invoking the production RPC as service_role.
begin;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'datafy_subscription_failed', null,
    null, null, now(), repeat('1',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-13 setup: %', r; end if;
  if not public.complete_whatsapp_ops_email_attempt((r->>'attempt_id')::uuid, 'uncertain', null) then
    raise exception 'OPS-13 uncertain setup';
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts set created_at = clock_timestamp() - interval '31 minutes'
  where unit_id = '70000000-0000-4000-8000-000000000011'
    and alert_type = 'datafy_subscription_failed';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'datafy_subscription_failed', null,
    null, null, now(), repeat('3',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'unresolved' then
    raise exception 'OPS-13 aged uncertain retried: %', r;
  end if;
  raise notice 'OPS-13 aged uncertain blocked PASS';
end $$;
reset role;
do $$ declare attempt_id uuid; begin
  select id into attempt_id from public.whatsapp_ops_email_attempts
    where unit_id = '70000000-0000-4000-8000-000000000011'
      and alert_type = 'datafy_subscription_failed';
  if not app_private.reconcile_whatsapp_ops_email_attempt(
    attempt_id, '70000000-0000-4000-8000-000000000070') then
    raise exception 'OPS-14 manual reconciliation failed';
  end if;
end $$;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.reserve_whatsapp_ops_email_attempt(
    '70000000-0000-4000-8000-000000000011', 'datafy_subscription_failed', null,
    null, null, now(), repeat('3',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-14 reconciled window: %', r; end if;
  raise notice 'OPS-14 manual release PASS';
end $$;
rollback;

-- 50 distinct units consume the moving project budget even while reserved.
begin;
insert into public.units(organization_id, name)
  select '70000000-0000-4000-8000-000000000001', 'Cap ' || i
  from generate_series(1, 51) as i;
set local role service_role;
do $$ declare u record; r jsonb; n integer := 0; begin
  for u in select id from public.units where name like 'Cap %' order by name loop
    r := public.reserve_whatsapp_ops_email_attempt(
      u.id, 'datafy_subscription_failed', null, null, null, now(),
      repeat('4',64), 'ops-email-v1', repeat('2',64));
    n := n + 1;
    if n = 1 and public.complete_whatsapp_ops_email_attempt((r->>'attempt_id')::uuid, 'uncertain', null) is distinct from true then
      raise exception 'OPS-15 uncertain setup failed';
    end if;
    if n <= 50 and r->>'decision' is distinct from 'reserved' then
      raise exception 'OPS-15 budget closed early at %: %', n, r;
    end if;
    if n = 51 and (r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'capacity') then
      raise exception 'OPS-15 budget exceeded: %', r;
    end if;
  end loop;
  if n is distinct from 51 then raise exception 'OPS-15 fixture count %', n; end if;
  if (select count(*) from public.whatsapp_ops_email_attempts where status = 'uncertain') is distinct from 1 then
    raise exception 'OPS-15 uncertain attempt not counted';
  end if;
  r := public.check_whatsapp_ops_email_reservation_ready();
  if (r->>'ready')::boolean is distinct from false or (r->>'remaining')::integer is distinct from 0 then
    raise exception 'OPS-16 readiness ignored budget: %', r;
  end if;
  raise notice 'OPS-15 global 50/24h cap including uncertain PASS';
end $$;
rollback;

-- The global cap is a rolling 24 h window, not a calendar-day counter.
begin;
insert into public.units(organization_id, name)
  select '70000000-0000-4000-8000-000000000001', 'Rolling cap ' || i
  from generate_series(1, 51) as i;
set local role service_role;
do $$ declare u record; r jsonb; n integer := 0; begin
  for u in select id from public.units
    where name like 'Rolling cap %' and name is distinct from 'Rolling cap 51'
    order by name loop
    r := public.reserve_whatsapp_ops_email_attempt(u.id, 'datafy_subscription_failed',
      null, null, null, now(), repeat('6',64), 'ops-email-v1', repeat('2',64));
    if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-20 setup at %: %', n, r; end if;
    n := n + 1;
    if n = 1 and public.complete_whatsapp_ops_email_attempt((r->>'attempt_id')::uuid, 'uncertain', null) is distinct from true then
      raise exception 'OPS-20 uncertain setup failed';
    end if;
  end loop;
  if n is distinct from 50 then raise exception 'OPS-20 fixture count: %', n; end if;
  if (select count(*) from public.whatsapp_ops_email_attempts where status = 'uncertain') is distinct from 1 then
    raise exception 'OPS-20 uncertain attempt not counted';
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '23 hours 59 minutes';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare u uuid; r jsonb; begin
  select id into u from public.units where name = 'Rolling cap 51';
  if u is null then raise exception 'OPS-20 missing 51st unit'; end if;
  r := public.reserve_whatsapp_ops_email_attempt(u, 'datafy_subscription_failed',
    null, null, null, now(), repeat('7',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'blocked' or r->>'reason' is distinct from 'capacity' then
    raise exception 'OPS-20 global cap inside 24h: %', r;
  end if;
end $$;
reset role;
alter table public.whatsapp_ops_email_attempts disable trigger user;
update public.whatsapp_ops_email_attempts
   set created_at = clock_timestamp() - interval '24 hours 1 minute';
alter table public.whatsapp_ops_email_attempts enable trigger user;
set local role service_role;
do $$ declare u uuid; r jsonb; begin
  select id into u from public.units where name = 'Rolling cap 51';
  r := public.reserve_whatsapp_ops_email_attempt(u, 'datafy_subscription_failed',
    null, null, null, now(), repeat('7',64), 'ops-email-v1', repeat('2',64));
  if r->>'decision' is distinct from 'reserved' then raise exception 'OPS-20 global 24h window did not roll: %', r; end if;
  raise notice 'OPS-20 global 24h rolling boundary PASS';
end $$;
rollback;

do $$
begin
  if (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.whatsapp_ops_email_attempts'::regclass) is distinct from true
    or exists (
      select 1 from (values ('anon'), ('authenticated')) as role_name(name)
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as privilege_name(name)
      where has_table_privilege(role_name.name, 'public.whatsapp_ops_email_attempts', privilege_name.name)
    )
    or exists (
      select 1 from (values
        ('public.reserve_whatsapp_ops_email_attempt(uuid,text,uuid,integer,integer,timestamptz,text,text,text)'),
        ('public.complete_whatsapp_ops_email_attempt(uuid,text,text)'),
        ('public.check_whatsapp_ops_email_reservation_ready()'),
        ('public.whatsapp_ops_email_attempt_guard()')
      ) as signature(name)
      cross join (values ('anon'), ('authenticated')) as role_name(name)
      where has_function_privilege(role_name.name, signature.name, 'EXECUTE')
    )
    or exists (
      select 1 from (values ('anon'), ('authenticated'), ('service_role')) as role_name(name)
      where has_function_privilege(role_name.name,
        'app_private.reconcile_whatsapp_ops_email_attempt(uuid,uuid)', 'EXECUTE')
    )
    or has_table_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'DELETE')
    or has_table_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'TRUNCATE')
    or exists (
      select 1 from (values
        ('id'), ('unit_id'), ('alert_type'), ('channel_id'), ('count'),
        ('oldest_age_seconds'), ('generated_at'), ('created_at'),
        ('payload_digest'), ('template_version'), ('config_hmac'),
        ('reconciliation_evidence_id'), ('reconciled_at')
      ) as column_name(name)
      where has_column_privilege('service_role', 'public.whatsapp_ops_email_attempts', column_name.name, 'UPDATE')
    )
    or not has_column_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'status', 'UPDATE')
    or not has_column_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'provider_id', 'UPDATE')
    or not has_table_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'SELECT')
    or not has_table_privilege('service_role', 'public.whatsapp_ops_email_attempts', 'INSERT')
    or not has_function_privilege('service_role', 'public.reserve_whatsapp_ops_email_attempt(uuid,text,uuid,integer,integer,timestamptz,text,text,text)', 'execute')
    or not has_function_privilege('service_role', 'public.complete_whatsapp_ops_email_attempt(uuid,text,text)', 'execute')
    or not has_function_privilege('service_role', 'public.check_whatsapp_ops_email_reservation_ready()', 'execute') then
    raise exception 'OPS-12 RLS/ACL mismatch';
  end if;
  raise notice 'OPS-12 RLS/ACL PASS';
end $$;

begin;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.check_whatsapp_ops_email_reservation_ready();
  if (r->>'ready')::boolean is distinct from true or (r->>'remaining')::integer is distinct from 50 then
    raise exception 'OPS-17 readiness failed: %', r;
  end if;
  raise notice 'OPS-17 readiness/ACL PASS';
end $$;
rollback;

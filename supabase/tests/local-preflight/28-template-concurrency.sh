#!/usr/bin/env bash
# Two real PostgreSQL sessions. Dedicated disposable local DB only; no provider.
set -euo pipefail
if [[ -n "${TASK_DOCKER:-}" ]]; then
  [[ "${TASK_DB_CONTAINER:-}" == 'supabase_db_moralles-templates-20261003' ]] || { echo 'wrong disposable DB'; exit 1; }
  psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
else
  [[ "${PGHOST:-}" == '127.0.0.1' && "${PGPORT:-}" == '55452' ]] || { echo 'loopback disposable DB required'; exit 1; }
  psql_task() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
fi
export PGCLIENTENCODING=UTF8
tmpdir=$(mktemp -d)
flag_before=$(psql_task -c "select coalesce((select value::text from public.platform_flags where key='whatsapp_automation_dispatch'),'__absent__')")
cleanup() {
  psql_task <<'SQL' >/dev/null
delete from public.organizations where id='28282828-0000-0000-0000-000000000001';
delete from auth.users where id='28282828-0000-0000-0000-000000000009';
SQL
  if [[ "$flag_before" == '__absent__' ]]; then
    psql_task -c "delete from public.platform_flags where key='whatsapp_automation_dispatch'" >/dev/null
  else
    psql_task -v flag_before="$flag_before" <<'SQL' >/dev/null
update public.platform_flags set value=:'flag_before'::jsonb where key='whatsapp_automation_dispatch';
SQL
  fi
  rm -f "$tmpdir/a" "$tmpdir/b" "$tmpdir/lock"
  rmdir "$tmpdir"
}
trap cleanup EXIT
psql_task <<'SQL' >/dev/null
begin;
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
insert into auth.users(id) values('28282828-0000-0000-0000-000000000009');
insert into public.platform_admins values('28282828-0000-0000-0000-000000000009');
insert into public.organizations(id,name) values('28282828-0000-0000-0000-000000000001','Concurrency fixture');
insert into public.units(id,organization_id,name) values('28282828-0000-0000-0000-000000000002','28282828-0000-0000-0000-000000000001','Concurrency unit');
insert into public.customers(id,organization_id,name,phone) values('28282828-0000-0000-0000-000000000003','28282828-0000-0000-0000-000000000001','Concurrency customer','55999990028');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('28282828-0000-0000-0000-000000000004','28282828-0000-0000-0000-000000000002','waha','connected',true,clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider) values('28282828-0000-0000-0000-000000000005','28282828-0000-0000-0000-000000000002','28282828-0000-0000-0000-000000000004','waha');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"28282828-0000-0000-0000-000000000009"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id='28282828-0000-0000-0000-000000000005';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.waitlist(id,unit_id,customer_phone) values('28282828-0000-0000-0000-000000000006','28282828-0000-0000-0000-000000000002','55999990028');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,waitlist_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,safe_log_body)
values('28282828-0000-0000-0000-000000000007','28282828-0000-0000-0000-000000000002','28282828-0000-0000-0000-000000000001','waitlist_entered','28282828-0000-0000-0000-000000000006','28282828-0000-0000-0000-000000000003','two_session',clock_timestamp(),clock_timestamp()+interval '1 hour','28282828-0000-0000-0000-000000000004','waha','28282828-0000-0000-0000-000000000005',1,'text','Concurrency safe render');
commit;
SQL
# First session keeps row lock across claim; second must observe committed lease.
psql_task <<'SQL' >"$tmpdir/a" &
begin;
select (public.claim_whatsapp_automation('28282828-0000-0000-0000-000000000007')->>'claim_token') is not null;
select pg_sleep(2);
commit;
SQL
pid_a=$!
psql_task <<'SQL' >"$tmpdir/b" &
select (public.claim_whatsapp_automation('28282828-0000-0000-0000-000000000007')->>'claim_token') is not null;
SQL
pid_b=$!
wait "$pid_a"; wait "$pid_b"
[[ $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^t$') == 1 ]] || { echo 'claim had multiple owners'; exit 1; }
[[ $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^f$') == 1 ]] || { echo 'claim loser did not refuse'; exit 1; }
echo 'GREEN: two sessions, exactly one fenced owner'

# Hold customer lock, shorten the unposted lease while prepare is waiting, then
# release it after actual expiry. SQL clock must be read AFTER acquiring locks.
psql_task <<'SQL' >/dev/null
update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()+interval '2 seconds' where id='28282828-0000-0000-0000-000000000007';
SQL
psql_task <<'SQL' >"$tmpdir/lock" &
begin;
set application_name='template28_customer_lock';
select id from public.customers where id='28282828-0000-0000-0000-000000000003' for update;
select pg_sleep(4);
commit;
SQL
pid_lock=$!
# Wait for actual server-side lock holder rather than assuming process timing.
for _ in {1..50}; do
  [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='template28_customer_lock' and query like 'select pg_sleep%')") == t ]] && break
done
result=$(psql_task -c "select public.prepare_whatsapp_automation_post('28282828-0000-0000-0000-000000000007',(select claim_token from public.whatsapp_automation_jobs where id='28282828-0000-0000-0000-000000000007'),1,null,null)")
wait "$pid_lock"
[[ "$result" == f ]] || { echo 'expired lock-wait lease incorrectly authorized POST'; exit 1; }
[[ $(psql_task -c "select posting_started_at is null and attempts=0 from public.whatsapp_automation_jobs where id='28282828-0000-0000-0000-000000000007'") == t ]] || { echo 'expired prepare consumed POST'; exit 1; }
echo 'GREEN: lease expires during customer lock wait; no POST/attempt'

# A binding may change accounts while enqueue waits for its initial account.
# Reread must refuse, never acquire the new account after already owning binding.
psql_task <<'SQL' >/dev/null
begin;
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('28282828-0000-0000-0000-000000000011','28282828-0000-0000-0000-000000000001','280011',clock_timestamp()),('28282828-0000-0000-0000-000000000012','28282828-0000-0000-0000-000000000001','280012',clock_timestamp());
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active) values('28282828-0000-0000-0000-000000000013','28282828-0000-0000-0000-000000000002','datafy','connected',false);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,account_id) values('28282828-0000-0000-0000-000000000014','28282828-0000-0000-0000-000000000002','28282828-0000-0000-0000-000000000013','datafy','28282828-0000-0000-0000-000000000011');
commit;
SQL
psql_task <<'SQL' >"$tmpdir/lock" &
begin;
set application_name='template28_account_lock';
select id from public.whatsapp_template_accounts where id='28282828-0000-0000-0000-000000000011' for update;
select pg_sleep(4);
commit;
SQL
pid_lock=$!
for _ in {1..50}; do
  [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='template28_account_lock' and query like 'select pg_sleep%')") == t ]] && break
done
psql_task <<'SQL' >"$tmpdir/b" 2>&1 &
\set VERBOSITY verbose
set application_name='template28_enqueue';
select public.enqueue_whatsapp_template_job('28282828-0000-0000-0000-000000000014','sync','account',1);
SQL
pid_enqueue=$!
for _ in {1..50}; do
  [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='template28_enqueue' and wait_event_type='Lock')") == t ]] && break
done
psql_task -c "update public.whatsapp_template_bindings set account_id='28282828-0000-0000-0000-000000000012',generation=2 where id='28282828-0000-0000-0000-000000000014'" >/dev/null
wait "$pid_lock"
if wait "$pid_enqueue"; then echo 'enqueue followed changed account without ordered lock'; exit 1; fi
grep -q '42501.*template_binding_refused' "$tmpdir/b" || { cat "$tmpdir/b"; exit 1; }
[[ $(psql_task -c "select count(*)=0 from public.whatsapp_template_jobs where binding_id='28282828-0000-0000-0000-000000000014'") == t ]] || { echo 'racy account job created'; exit 1; }
echo 'GREEN: account changes during enqueue parent-lock wait; no job/reroute'

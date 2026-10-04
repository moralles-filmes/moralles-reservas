#!/usr/bin/env bash
# Real two-session races on the explicitly isolated fixture database.
set -euo pipefail
export PGCLIENTENCODING=UTF8
if [[ -n "${TASK_DOCKER:-}" ]]; then
  [[ "${TASK_DB_CONTAINER:-}" == 'supabase_db_moralles-templates-20261003' ]] || { echo 'wrong disposable DB'; exit 1; }
  psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
else
  [[ "${PGHOST:-}" == '127.0.0.1' && "${PGPORT:-}" == '55452' ]] || { echo 'loopback disposable DB required'; exit 1; }
  psql_task() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
fi
tmpdir=$(mktemp -d)
flag_before=$(psql_task -c "select coalesce((select value::text from public.platform_flags where key='whatsapp_automation_dispatch'),'__absent__')")
cleanup() {
  psql_task <<'SQL' >/dev/null
delete from public.organizations where id='30303030-0000-0000-0000-000000000001';
delete from auth.users where id='30303030-0000-0000-0000-000000000009';
delete from app_private.whatsapp_preference_rate_buckets where bucket_hash=repeat('0',64);
SQL
  if [[ "$flag_before" == '__absent__' ]]; then
    psql_task -c "delete from public.platform_flags where key='whatsapp_automation_dispatch'" >/dev/null
  else
    psql_task -v flag_before="$flag_before" <<'SQL' >/dev/null
update public.platform_flags set value=:'flag_before'::jsonb where key='whatsapp_automation_dispatch';
SQL
  fi
  rm -f "$tmpdir/a" "$tmpdir/b" "$tmpdir/lock"; rmdir "$tmpdir"
}
trap cleanup EXIT
wait_sleep() {
  local found=false
  for _ in {1..80}; do
    if [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='$1' and query like 'select pg_sleep%')") == t ]]; then found=true; break; fi
  done
  [[ "$found" == true ]] || { echo 'server lock holder not observed'; exit 1; }
}
assert_true() { [[ $(psql_task -c "$1") == t ]] || { echo "FAIL: $2"; exit 1; }; }
psql_task <<'SQL' >/dev/null
begin;
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
insert into auth.users(id) values('30303030-0000-0000-0000-000000000009');
insert into public.platform_admins values('30303030-0000-0000-0000-000000000009');
insert into public.organizations(id,name) values('30303030-0000-0000-0000-000000000001','Preferences concurrency');
insert into public.units(id,organization_id,name) values('30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000001','Preferences unit');
insert into public.customers(id,organization_id,name,phone) values('30303030-0000-0000-0000-000000000003','30303030-0000-0000-0000-000000000001','Contact A','55999990030'),('30303030-0000-0000-0000-000000000013','30303030-0000-0000-0000-000000000001','Contact B','55999990031');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('30303030-0000-0000-0000-000000000004','30303030-0000-0000-0000-000000000002','waha','connected',true,clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider) values('30303030-0000-0000-0000-000000000005','30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000004','waha');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"30303030-0000-0000-0000-000000000009"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id='30303030-0000-0000-0000-000000000005';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at)
  select '30303030-0000-0000-0000-000000000002',id,'promotional','opt_in','individual_proof','concurrency-proof',clock_timestamp() from public.customers where organization_id='30303030-0000-0000-0000-000000000001';
insert into public.vouchers(id,unit_id,customer_id) values('30303030-0000-0000-0000-000000000006','30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000003'),('30303030-0000-0000-0000-000000000016','30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000003'),('30303030-0000-0000-0000-000000000026','30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000013');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,voucher_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,safe_log_body)
  select case id when '30303030-0000-0000-0000-000000000006' then '30303030-0000-0000-0000-000000000007'::uuid when '30303030-0000-0000-0000-000000000016' then '30303030-0000-0000-0000-000000000017'::uuid else '30303030-0000-0000-0000-000000000027'::uuid end,
    unit_id,'30303030-0000-0000-0000-000000000001','voucher_issued',id,customer_id,'preferences-race',clock_timestamp(),clock_timestamp()+interval '1 hour','30303030-0000-0000-0000-000000000004','waha','30303030-0000-0000-0000-000000000005',1,'text','Fake Name safe promotion'
  from public.vouchers where unit_id='30303030-0000-0000-0000-000000000002';
select public.issue_whatsapp_preference_token('30303030-0000-0000-0000-000000000027',repeat('6',64));
select public.claim_whatsapp_automation(id) is not null from public.whatsapp_automation_jobs where unit_id='30303030-0000-0000-0000-000000000002';
commit;
SQL
# The first successful prepare holds the customer mutex. The other must wait.
psql_task <<'SQL' >"$tmpdir/a" &
begin;
set application_name='preferences30_prepare';
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000007',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000007'),1,1,null);
select pg_sleep(3);
commit;
SQL
pid_a=$!; wait_sleep preferences30_prepare
psql_task <<'SQL' >"$tmpdir/b" &
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000017',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000017'),1,1,null);
SQL
pid_b=$!; wait "$pid_a"; wait "$pid_b"
[[ $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^t$') == 1 && $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^f$') == 1 ]] || { echo 'multiple promotional POSTs'; exit 1; }
assert_true "select count(*)=1 from public.whatsapp_promotion_slots where unit_id='30303030-0000-0000-0000-000000000002'" 'single provisional slot'
echo 'GREEN: concurrent prepare permits exactly one promotional POST'
# Expired marker remains protected even before a finisher updates the slot.
psql_task -c "update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()-interval '1 second' where id='30303030-0000-0000-0000-000000000007'; update public.whatsapp_promotion_slots set claimed_until=clock_timestamp()-interval '1 second' where job_id='30303030-0000-0000-0000-000000000007'; select public.requeue_whatsapp_automation('30303030-0000-0000-0000-000000000017'); select public.claim_whatsapp_automation('30303030-0000-0000-0000-000000000017') is not null" >/dev/null
assert_true "select not public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000017',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000017'),1,1,null)" 'expired posting protection'
echo 'GREEN: expired posting lease cannot reclaim provisional slot'
# Finish locks customer->slot->job; concurrent next prepare cannot reverse them.
psql_task -c "select public.requeue_whatsapp_automation('30303030-0000-0000-0000-000000000017');select public.claim_whatsapp_automation('30303030-0000-0000-0000-000000000017') is not null" >/dev/null
psql_task <<'SQL' >"$tmpdir/a" &
begin;
set application_name='preferences30_finish';
select public.finish_whatsapp_automation('30303030-0000-0000-0000-000000000007',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000007'),'{"outcome":"uncertain","reason":"post_ambiguous"}');
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep preferences30_finish
psql_task <<'SQL' >"$tmpdir/b" &
set statement_timeout='8s';
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000017',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000017'),1,1,null);
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^f$' "$tmpdir/b") == 1 ]] || { echo 'finish allowed overlapping promotion';exit 1; }
echo 'GREEN: finish versus prepare serializes without deadlock; uncertain conserves window'
# Refusal commits after enqueue but before prepare gets its customer lock.
psql_task <<'SQL' >"$tmpdir/a" &
begin;
set application_name='preferences30_optout';
select public.revoke_whatsapp_promotion(repeat('6',64));
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep preferences30_optout
psql_task <<'SQL' >"$tmpdir/b" &
set statement_timeout='8s';
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000027',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000027'),1,1,null);
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^f$' "$tmpdir/b") == 1 ]] || { echo 'revoked contact posted';exit 1; }
assert_true "select posting_started_at is null and attempts=0 and error_code='consent_changed' from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000027'" 'opt-out won prepare race'
echo 'GREEN: opt-out after enqueue wins before prepare; zero attempts'
# Two identical confirmed opt-outs append only one new SQL revision.
psql_task <<'SQL' >/dev/null
insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values('30303030-0000-0000-0000-000000000002','30303030-0000-0000-0000-000000000013','promotional','opt_in','individual_proof','later-proof',clock_timestamp());
SQL
psql_task <<'SQL' >"$tmpdir/a" &
begin;
set application_name='preferences30_repeat';
select public.revoke_whatsapp_promotion(repeat('6',64));
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep preferences30_repeat
psql_task -c "select public.revoke_whatsapp_promotion(repeat('6',64))" >"$tmpdir/b" &
pid_b=$!;wait "$pid_a";wait "$pid_b"
assert_true "select count(*)=4 and max(revision)=4 from public.whatsapp_message_consent_events where customer_id='30303030-0000-0000-0000-000000000013'" 'idempotent concurrent opt-outs'
echo 'GREEN: concurrent explicit opt-outs create one revision'
# Anonymization owns customer before updating jobs; waiting prepare sees erasure.
psql_task -c "select public.requeue_whatsapp_automation('30303030-0000-0000-0000-000000000017');select public.claim_whatsapp_automation('30303030-0000-0000-0000-000000000017') is not null" >/dev/null
psql_task <<'SQL' >"$tmpdir/a" &
begin;
set application_name='preferences30_erasure';
update public.customers set deleted_at=clock_timestamp() where id='30303030-0000-0000-0000-000000000003';
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep preferences30_erasure
psql_task <<'SQL' >"$tmpdir/b" &
set statement_timeout='8s';
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000017',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000017'),1,1,null);
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^f$' "$tmpdir/b") == 1 ]] || { echo 'erased contact posted';exit 1; }
assert_true "select public.finish_whatsapp_automation('30303030-0000-0000-0000-000000000007',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000007'),'{\"outcome\":\"accepted\",\"reason\":\"provider_accepted\",\"provider_message_id\":\"erased-race30\"}')" 'late erased acknowledgement'
assert_true "select not exists(select from public.whatsapp_promotion_slots where unit_id='30303030-0000-0000-0000-000000000002') and not exists(select from public.whatsapp_automation_jobs where unit_id='30303030-0000-0000-0000-000000000002' and customer_erased_at is not null and safe_log_body is not null)" 'no restored personal slot or text'
echo 'GREEN: anonymization versus prepare; late acknowledgement preserves technical identity only'
# Atomically competing unknown capability requests share one bounded hash bucket.
psql_task -c "select public.check_whatsapp_preference_rate(repeat('0',64),1,60)" >"$tmpdir/a" &
pid_a=$!;psql_task -c "select public.check_whatsapp_preference_rate(repeat('0',64),1,60)" >"$tmpdir/b" &
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^t$') == 1 && $(cat "$tmpdir/a" "$tmpdir/b" | grep -c '^f$') == 1 ]] || { echo 'rate race exceeded bound';exit 1; }
echo 'GREEN: two requests, atomic private rate bound'
# Cost vigency must use the final SQL clock after waiting for the job, too.
psql_task <<'SQL' >/dev/null
begin;
insert into public.units(id,organization_id,name) values('30303030-0000-0000-0000-000000000032','30303030-0000-0000-0000-000000000001','Official concurrency');
insert into public.customers(id,organization_id,name,phone) values('30303030-0000-0000-0000-000000000033','30303030-0000-0000-0000-000000000001','Contact C','55999990033');
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('30303030-0000-0000-0000-000000000031','30303030-0000-0000-0000-000000000001','3030031',clock_timestamp());
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('30303030-0000-0000-0000-000000000034','30303030-0000-0000-0000-000000000032','datafy','connected',true,clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,account_id,verified_at) values('30303030-0000-0000-0000-000000000035','30303030-0000-0000-0000-000000000032','30303030-0000-0000-0000-000000000034','datafy','30303030-0000-0000-0000-000000000031',clock_timestamp());
select set_config('request.jwt.claims','{"role":"authenticated","sub":"30303030-0000-0000-0000-000000000009"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id='30303030-0000-0000-0000-000000000035';
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,observed_hash,requested_category,effective_category,binding_generation,remote_id,remote_status,local_status,sync_required,last_synced_at)
values('30303030-0000-0000-0000-000000000036','30303030-0000-0000-0000-000000000031','mkt_voucher_programado_v1',1,'pt_BR','mkt_voucher_programado_v1',repeat('b',64),repeat('b',64),'MARKETING','MARKETING',1,'cost30','APPROVED','usable',false,clock_timestamp());
insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values('30303030-0000-0000-0000-000000000032','30303030-0000-0000-0000-000000000033','promotional','opt_in','individual_proof','cost-proof',clock_timestamp());
insert into public.vouchers(id,unit_id,customer_id) values('30303030-0000-0000-0000-000000000037','30303030-0000-0000-0000-000000000032','30303030-0000-0000-0000-000000000033');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,voucher_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,safe_log_body)
values('30303030-0000-0000-0000-000000000038','30303030-0000-0000-0000-000000000032','30303030-0000-0000-0000-000000000001','voucher_issued','30303030-0000-0000-0000-000000000037','30303030-0000-0000-0000-000000000033','cost-time-race',clock_timestamp(),clock_timestamp()+interval '1 hour','30303030-0000-0000-0000-000000000034','datafy','30303030-0000-0000-0000-000000000035',1,'template','30303030-0000-0000-0000-000000000031','30303030-0000-0000-0000-000000000036',1,0,'Cost safe render');
select public.claim_whatsapp_automation('30303030-0000-0000-0000-000000000038') is not null;
insert into public.whatsapp_template_cost_authorizations(account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id)
values('30303030-0000-0000-0000-000000000031','30303030-0000-0000-0000-000000000035',1,'MARKETING',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '3 seconds','30303030-0000-0000-0000-000000000009');
commit;
SQL
psql_task <<'SQL' >"$tmpdir/lock" &
begin;
set application_name='preferences30_cost_job_lock';
select id from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000038' for update;
select pg_sleep(5);
commit;
SQL
pid_a=$!;wait_sleep preferences30_cost_job_lock
psql_task <<'SQL' >"$tmpdir/b" &
set application_name='preferences30_cost_wait';
set statement_timeout='9s';
select public.prepare_whatsapp_automation_post('30303030-0000-0000-0000-000000000038',(select claim_token from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000038'),1,1,0);
SQL
pid_b=$!
cost_wait_observed=false
for _ in {1..80}; do
  if [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='preferences30_cost_wait' and wait_event_type='Lock') and exists(select from public.whatsapp_template_cost_authorizations where account_id='30303030-0000-0000-0000-000000000031' and valid_until>clock_timestamp())") == t ]]; then cost_wait_observed=true;break;fi
done
wait "$pid_a";wait "$pid_b"
[[ "$cost_wait_observed" == true ]] || { echo 'cost lock-wait test did not observe live authorization before expiry';exit 1; }
[[ $(grep -c '^f$' "$tmpdir/b") == 1 ]] || { echo 'FAIL: expired cost authorized POST after job wait';exit 1; }
assert_true "select error_code='cost_not_authorized' and posting_started_at is null and attempts=0 and claimed_until>clock_timestamp() from public.whatsapp_automation_jobs where id='30303030-0000-0000-0000-000000000038'" 'cost expiry while lease remains live'
echo 'GREEN: cost expires during job wait with live lease; no promotional POST'

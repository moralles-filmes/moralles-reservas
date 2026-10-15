#!/usr/bin/env bash
# Actual independent PostgreSQL sessions; run only after MAIN declares the owned stack READY.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ -z ${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-} ]] || exit 1
[[ ${TASK_DB_CONTAINER:-} == supabase_db_moralles-templates-20261003 ]] || exit 1
task_docker=$(node "$(dirname "$0")/local-runtime-paths.mjs" --docker)
[[ ${TASK_DOCKER:-} == "$task_docker" ]] || exit 1
[[ $("$TASK_DOCKER" context inspect --format '{{ .Endpoints.docker.Host }}') == npipe:////./pipe/* ]] || exit 1
[[ $("$TASK_DOCKER" inspect --format '{{ .State.Running }}' "$TASK_DB_CONTAINER") == true ]] || exit 1
[[ $("$TASK_DOCKER" inspect --format '{{ index .Config.Labels "com.supabase.cli.project" }}' "$TASK_DB_CONTAINER") == moralles-templates-20261003 ]] || exit 1
[[ $("$TASK_DOCKER" inspect --format '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$TASK_DB_CONTAINER") == 55452 ]] || exit 1
psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_root=$(cd "$(dirname "$0")/../../.." && pwd)
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/acceptance39.XXXXXX")
o=$(psql_task -c 'select gen_random_uuid()')
u=$(psql_task -c 'select gen_random_uuid()')
c=$(psql_task -c 'select gen_random_uuid()')
ch=$(psql_task -c 'select gen_random_uuid()')
b=$(psql_task -c 'select gen_random_uuid()')
r=$(psql_task -c 'select gen_random_uuid()')
j=$(psql_task -c 'select gen_random_uuid()')
f=$(psql_task -c 'select gen_random_uuid()')
for value in "$o" "$u" "$c" "$ch" "$b" "$r" "$j" "$f"; do [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; done
# No flag writes: preserve both original absence and JSON value, including SQL/JSON null.
flags_before=$(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value) order by key),'[]') from public.platform_flags")
cleanup() {
  psql_task -c "update public.customers set deleted_at=clock_timestamp() where id='$c' and deleted_at is null; delete from public.conversations where unit_id='$u'; delete from public.notifications_sent where unit_id='$u'; delete from public.whatsapp_automation_jobs where unit_id='$u'; delete from public.whatsapp_template_bindings where id='$b'; delete from public.organizations where id='$o';" >/dev/null
  flags_after=$(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value) order by key),'[]') from public.platform_flags")
  [[ $flags_after == "$flags_before" ]] || { echo 'FAIL flag existence/value changed'; exit 1; }
}
trap cleanup EXIT
setup() {
  cleanup
  local kind=${1:-confirmation} resource_table=reservations resource_key=reservation_id
  if [[ $kind == voucher_issued ]]; then resource_table=vouchers; resource_key=voucher_id; fi
  psql_task <<SQL >"$task_tmp/setup"
begin;
insert into public.organizations(id,name) values('$o','Task39 synthetic');
insert into public.units(id,organization_id,name) values('$u','$o','Task39');
insert into public.customers(id,organization_id,name,phone) values('$c','$o','Synthetic','11999993939');
insert into public.$resource_table(id,unit_id,customer_id) values('$r','$u','$c');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$ch','$u','zapi','connected',true,clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider) values('$b','$u','$ch','zapi');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,$resource_key,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
values('$j','$u','$o','$kind','$r','$c','task39',clock_timestamp(),clock_timestamp()+interval '1 hour','$ch','zapi','$b',1,'text','posting','$f',clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Task39 frozen redacted');
select public.finish_whatsapp_automation('$j','$f','{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"task39-native"}');
commit;
SQL
  if [[ $kind == voucher_issued ]]; then
    psql_task -c "insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,state,claim_token,claimed_until,accepted_at,window_until) values('$u','$c','$j','accepted','$f',clock_timestamp()+interval '90 seconds',clock_timestamp(),clock_timestamp()+interval '7 days')" >"$task_tmp/slot-setup"
  fi
}
observe() {
  local observed
  for _ in {1..80}; do
    observed=$(psql_task -c "select jsonb_build_object('application',application_name,'pid',pid,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) from pg_stat_activity where application_name='$1' and $2")
    if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$3"; return; fi
  done
  echo "FAIL actual session not observed: $1"; exit 1
}
assert_true() { [[ $(psql_task -c "$1") == t ]] || { echo "FAIL $2"; exit 1; }; echo "GREEN $2"; }
race() {
  local label=$1 holder=$2 waiter=$3 before_commit=${4:-} after_sleep=${5:-}
  local wait_condition=${6:-"wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"}
  psql_task <<SQL >"$task_tmp/$label-holder" 2>&1 &
begin;
set local statement_timeout='15s';
set application_name='acceptance39_holder';
$holder
select pg_sleep(3);
$after_sleep
commit;
SQL
  local holder_pid=$!
  observe acceptance39_holder "wait_event='PgSleep'" "$task_tmp/$label-holder-observed"
  psql_task <<SQL >"$task_tmp/$label-waiter" 2>&1 &
set statement_timeout='15s';
set application_name='acceptance39_waiter';
$waiter
SQL
  local waiter_pid=$!
  observe acceptance39_waiter "$wait_condition" "$task_tmp/$label-waiter-observed"
  if [[ -n $before_commit ]]; then psql_task -c "$before_commit" >"$task_tmp/$label-lock-control"; fi
  wait "$holder_pid"; wait "$waiter_pid"
  echo "GREEN observed two-session $label; native exits 0/0"
}
setup
race repair_first "select public.reconcile_whatsapp_automation_acceptance('$j');" "update public.customers set deleted_at=clock_timestamp() where id='$c';"
assert_true "select customer_id is null and safe_log_body is null and provider_message_id='task39-native' from public.whatsapp_automation_jobs where id='$j'" 'repair then erasure retains only technical job evidence'
setup
race erasure_first "update public.customers set deleted_at=clock_timestamp() where id='$c';" "select public.reconcile_whatsapp_automation_acceptance('$j');"
assert_true "select not exists(select from public.conversations where unit_id='$u') and (select state='reconciled' and customer_id is null and safe_log_body is null from public.whatsapp_automation_jobs where id='$j')" 'erasure then repair never recreates personal history'
setup
# Lock only the customer first; the waiting repair must not hold the later job lock.
race customer_before_job "select id from public.customers where id='$c' for update;" "select public.reconcile_whatsapp_automation_acceptance('$j');" "begin; select id from public.whatsapp_automation_jobs where id='$j' for update nowait; rollback;" "update public.customers set deleted_at=clock_timestamp() where id='$c';"
assert_true "select not exists(select from public.conversations where unit_id='$u')" 'customer wait precedes job lock and erasure is reread'
setup
race double_repair "select public.reconcile_whatsapp_automation_acceptance('$j');" "select public.reconcile_whatsapp_automation_acceptance('$j');"
assert_true "select (select count(*) from public.notifications_sent where unit_id='$u')=1 and (select sum(jsonb_array_length(messages)) from public.conversations where unit_id='$u')=1" 'two repairs produce one notification and one event'
setup
psql_task -c "select public.reconcile_whatsapp_automation_acceptance('$j'); insert into public.conversations(unit_id,customer_id,messages,contact_name,updated_at) values('$u','$c','[]','Task39 newer B',clock_timestamp()+interval '1 minute');" >"$task_tmp/history-setup"
assert_true "select contact_name='Task39 newer B' from public.conversations where unit_id='$u' and customer_id='$c' order by updated_at desc,id limit 1" 'second legitimate conversation is actually newer'
history_before=$(psql_task -c "select jsonb_agg(to_jsonb(x) order by id) from public.conversations x where unit_id='$u' and customer_id='$c'")
notification_before=$(psql_task -c "select to_jsonb(x) from public.notifications_sent x where unit_id='$u'")
# B is committed before the holder starts: inserting it while holding the
# advisory lock would take a customer FK lock and obscure the intended wait.
race history_advisory "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('$u'||':'||'$c',0));" "select public.reconcile_whatsapp_automation_acceptance('$j');" '' '' "wait_event_type='Lock' and wait_event='advisory' and cardinality(pg_blocking_pids(pid))>0"
assert_true "select count(*)=1 from public.conversations x cross join lateral jsonb_array_elements(x.messages) e where x.unit_id='$u' and x.customer_id='$c' and e->>'event_id'='automation:$j:accepted'" 'observed advisory wait then repeat retains one event across conversations'
[[ $(psql_task -c "select jsonb_agg(to_jsonb(x) order by id) from public.conversations x where unit_id='$u' and customer_id='$c'") == "$history_before" ]] || { echo 'FAIL direct repeat mutated A/B history'; exit 1; }
psql_task -c "update public.notifications_sent set provider_message_id='task39-mismatch' where unit_id='$u';" >"$task_tmp/history-conflict"
assert_true "select public.reconcile_whatsapp_automation_acceptance('$j')->>'reason'='notification_conflict'" 'real mismatch defers a previously repaired job'
assert_true "select state='accepted' and reconcile_required from public.whatsapp_automation_jobs where id='$j'" 'deferral really returns to accepted'
psql_task -c "update public.notifications_sent set provider_message_id='task39-native' where unit_id='$u';" >"$task_tmp/history-restored"
race history_after_deferral "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('$u'||':'||'$c',0));" "select public.reconcile_whatsapp_automation_acceptance('$j');" '' '' "wait_event_type='Lock' and wait_event='advisory' and cardinality(pg_blocking_pids(pid))>0"
assert_true "select count(*)=1 from public.conversations x cross join lateral jsonb_array_elements(x.messages) e where x.unit_id='$u' and x.customer_id='$c' and e->>'event_id'='automation:$j:accepted'" 'repeat after real deferral retains one event across conversations'
[[ $(psql_task -c "select jsonb_agg(to_jsonb(x) order by id) from public.conversations x where unit_id='$u' and customer_id='$c'") == "$history_before" ]] || { echo 'FAIL deferral repeat mutated A/B history'; exit 1; }
[[ $(psql_task -c "select to_jsonb(x) from public.notifications_sent x where unit_id='$u'") == "$notification_before" ]] || { echo 'FAIL repeat mutated notification evidence'; exit 1; }
setup
psql_task <<SQL >"$task_tmp/rollback"
begin;
select public.reconcile_whatsapp_automation_acceptance('$j');
rollback;
SQL
assert_true "select (select state='accepted' and reconcile_required from public.whatsapp_automation_jobs where id='$j') and not exists(select from public.notifications_sent where unit_id='$u') and not exists(select from public.conversations where unit_id='$u')" 'repair rollback preserves committed acceptance without local projections'
setup voucher_issued
slot_before=$(psql_task -c "select to_jsonb(s) from public.whatsapp_promotion_slots s where job_id='$j'")
race slot_before_job "select id from public.whatsapp_promotion_slots where job_id='$j' for update;" "select public.reconcile_whatsapp_automation_acceptance('$j');" "begin; select id from public.whatsapp_automation_jobs where id='$j' for update nowait; rollback;"
[[ $(psql_task -c "select to_jsonb(s) from public.whatsapp_promotion_slots s where job_id='$j'") == "$slot_before" ]] || { echo 'FAIL repair mutated slot'; exit 1; }
assert_true "select state='reconciled' from public.whatsapp_automation_jobs where id='$j'" 'repair waits on existing slot before job and never mutates slot'
echo 'Task39 seven observed two-session races (including two advisory waits), cross-conversation repeats, rollback and slot immutability completed.'

#!/usr/bin/env bash
# Authoring/syntax is not evidence: ROOT runs these observed independent PostgreSQL sessions.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ $# == 0 && -z ${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-} ]] || exit 1
task_docker=$(node "$(dirname "$0")/local-runtime-paths.mjs" --docker)
task_container=supabase_db_moralles-templates-20261003
[[ -z ${TASK_DOCKER:-} || $TASK_DOCKER == "$task_docker" ]] || exit 1
[[ -z ${TASK_DB_CONTAINER:-} || $TASK_DB_CONTAINER == "$task_container" ]] || exit 1
[[ $("$task_docker" context inspect --format '{{ .Endpoints.docker.Host }}') == npipe:////./pipe/dockerDesktopLinuxEngine ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .State.Running }}' "$task_container") == true ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .Name }}' "$task_container") == /$task_container ]] || exit 1
[[ $("$task_docker" inspect --format '{{ index .Config.Labels "com.supabase.cli.project" }}' "$task_container") == moralles-templates-20261003 ]] || exit 1
[[ $("$task_docker" inspect --format '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$task_container") == 55452 ]] || exit 1
psql_task() { "$task_docker" exec -i "$task_container" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_root=$(cd "$(dirname "$0")/../../.." && pwd)
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/outbox46.XXXXXX")
for key in org unit customer actor channel binding; do value=$(psql_task -c 'select gen_random_uuid()'); [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; printf -v "$key" '%s' "$value"; done
[[ $(psql_task -c "select array_agg(attname::text order by attname)=array['key','value'] from pg_attribute where attrelid='public.platform_flags'::regclass and attnum>0 and not attisdropped") == t ]] || exit 1
flag_before=$(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'")
holder_pid='' waiter_pid=''
clean_fixture() {
 psql_task -c "update public.customers set deleted_at=clock_timestamp() where id='$customer' and deleted_at is null; delete from public.whatsapp_promotion_slots where unit_id='$unit'; delete from public.whatsapp_automation_jobs where unit_id='$unit'; delete from public.whatsapp_template_bindings where id='$binding'; delete from public.organizations where id='$org'; delete from auth.users where id='$actor';" >/dev/null
}
cleanup() {
 local original_exit=$?
 if [[ -n $holder_pid ]]; then wait "$holder_pid" || original_exit=1; fi
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || original_exit=1; fi
 clean_fixture || original_exit=1
 # Restore typed fields explicitly, including absence/JSON null/SQL NULL; never populate_recordset.
 psql_task -v outbox46_original_flag="$flag_before" >"$task_tmp/flag-restored" <<'SQL' || original_exit=1
begin;
set local standard_conforming_strings=on;
delete from public.platform_flags where key='whatsapp_automation_dispatch';
insert into public.platform_flags(key,value)
select row_data->>'key',case when (row_data->>'value_is_sql_null')::boolean then null::jsonb else row_data->'value' end
from jsonb_array_elements(:'outbox46_original_flag'::jsonb) as snapshot(row_data);
commit;
SQL
 [[ $(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'") == "$flag_before" ]] || original_exit=1
 echo "Task46 cleanup native exit $original_exit; exact flags restored"
 exit "$original_exit"
}
trap cleanup EXIT
observe() {
 local label=$1 predicate=$2
 for _ in {1..100}; do
  observed=$(psql_task -c "select jsonb_build_object('application',application_name,'pid',pid,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) from pg_stat_activity where application_name='$label' and $predicate")
  if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$task_tmp/$label-observed"; return; fi
 done
 echo "FAIL46 actual wait not observed $label"; exit 1
}
setup() {
 local count=$1 stale=$2 claim=$3
 clean_fixture
 psql_task >"$task_tmp/setup-$count-$stale-$claim" <<SQL
begin;
insert into auth.users(id) values('$actor'); insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$org','Task46');
insert into public.units(id,organization_id,name,slug,timezone) values('$unit','$org','Task46','task46-$unit','America/Sao_Paulo');
insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values('$customer','$org','Synthetic','55912345678',false,null);
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$channel','$unit','zapi','connected',true,clock_timestamp());
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values('$binding','$unit','$channel','zapi',clock_timestamp(),true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do \$\$
declare r uuid; j uuid; outbox uuid; o public.notification_outbox%rowtype; n public.notification_outbox%rowtype;
begin
 for i in 1..$count loop
  r:=gen_random_uuid(); j:=gen_random_uuid();
  insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent)
   values(r,'$unit','$customer',current_date+1,'23:59','confirmed',null,'web',4,'TASK46-'||r,null,null);
  select id into outbox from public.notification_outbox where reservation_id=r and kind='confirmation';
  insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state)
   values(j,'$unit','$org','confirmation',r,'$customer','task46',clock_timestamp(),clock_timestamp()+interval '1 day','$channel','zapi','$binding',1,'text','queued');
  update public.notification_outbox set status='processing',updated_at=clock_timestamp() where id=outbox and status='pending';
  if $claim then
   if public.claim_notification_outbox_initial(outbox) is null then raise exception 'fixture_claim_failed'; end if;
   if $stale then
    -- Owner-only fixture ages the first pin through an exact typed permit. This is not a service bypass or a recovery implementation.
    select * into o from public.notification_outbox where id=outbox for update; n:=o;
    n.automation_job_id:=j; n.updated_at:=clock_timestamp()-interval '3 minutes';
    insert into app_private.notification_outbox_mutation_permits values(txid_current(),outbox,'delegate',
     row(o.id,o.reservation_id,o.unit_id,o.kind,o.attempts,o.next_attempt_at,o.status,o.last_error,o.created_at,o.updated_at,o.automation_job_id,o.automation_initial_token)::app_private.notification_outbox_transition_tuple,
     row(n.id,n.reservation_id,n.unit_id,n.kind,n.attempts,n.next_attempt_at,n.status,n.last_error,n.created_at,n.updated_at,n.automation_job_id,n.automation_initial_token)::app_private.notification_outbox_transition_tuple);
    update public.notification_outbox set automation_job_id=n.automation_job_id,updated_at=n.updated_at where id=outbox;
   elsif not public.delegate_notification_outbox_automation(outbox,j) then raise exception 'fixture_pin_failed'; end if;
  end if;
 end loop;
end \$\$;
commit;
SQL
 outbox=$(psql_task -c "select id from public.notification_outbox where unit_id='$unit' order by id limit 1")
 job=$(psql_task -c "select j.id from public.whatsapp_automation_jobs j join public.notification_outbox o on o.reservation_id=j.reservation_id and o.unit_id=j.unit_id where o.id='$outbox'")
}
join_sessions() {
 local failed=0
 wait "$holder_pid" || failed=1; holder_pid=''
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || failed=1; waiter_pid=''; fi
 [[ $failed == 0 ]] || { echo 'FAIL46 native session exit'; exit 1; }
}
# One-use initial owner: the loser really waits on the independent winner's outbox transaction.
setup 1 false false
psql_task >"$task_tmp/winner-holder" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set application_name='outbox46_winner';
select public.claim_notification_outbox_initial('$outbox') is not null;
select pg_sleep(6); commit;
SQL
holder_pid=$!; observe outbox46_winner "wait_event='PgSleep'"
psql_task >"$task_tmp/winner-waiter" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set application_name='outbox46_loser';
select public.claim_notification_outbox_initial('$outbox') is null;
commit;
SQL
waiter_pid=$!; observe outbox46_loser "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
join_sessions
grep -qx t "$task_tmp/winner-holder"; grep -qx t "$task_tmp/winner-waiter"
echo 'GREEN46 independent initial winner/loser'
# Job SHARE precedes outbox: a third independent NOWAIT read can lock the outbox while poll waits for job.
setup 1 false true
psql_task >"$task_tmp/order-holder" 2>&1 <<SQL &
begin; set application_name='outbox46_job_holder'; select id from public.whatsapp_automation_jobs where id='$job' for update;
select pg_sleep(6); commit;
SQL
holder_pid=$!; observe outbox46_job_holder "wait_event='PgSleep'"
psql_task >"$task_tmp/order-waiter" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set application_name='outbox46_job_waiter';
select public.poll_notification_outbox_automation('$outbox')->>'reason'='automation_queued'; commit;
SQL
waiter_pid=$!; observe outbox46_job_waiter "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
psql_task -c "begin; select id from public.notification_outbox where id='$outbox' for update nowait; rollback;" >"$task_tmp/order-outbox-free"
join_sessions; grep -qx t "$task_tmp/order-waiter"
echo 'GREEN46 observed job-before-outbox lock order'
# Recovery must ignore a locked business job, preserve original token and permit original finish.
setup 1 true true
before=$(psql_task -c "select md5(automation_initial_token::text) from public.notification_outbox where id='$outbox'")
psql_task >"$task_tmp/recovery-job-holder" 2>&1 <<SQL &
begin; set application_name='outbox46_recovery_job'; select id from public.whatsapp_automation_jobs where id='$job' for update;
select pg_sleep(6); commit;
SQL
holder_pid=$!; observe outbox46_recovery_job "wait_event='PgSleep'"
[[ $(psql_task -c "set statement_timeout='2s'; select count(*)=1 from public.recover_delegated_notification_outbox(20)") == t ]] || exit 1
join_sessions
[[ $(psql_task -c "select md5(automation_initial_token::text) from public.notification_outbox where id='$outbox'") == "$before" ]] || exit 1
echo 'GREEN46 recovery without earlier business locks'
# Recovery transaction vs original finish: status is not a lease and token never changes.
setup 1 true true
before=$(psql_task -c "select md5(automation_initial_token::text) from public.notification_outbox where id='$outbox'")
psql_task >"$task_tmp/recover-holder" 2>&1 <<SQL &
begin; set application_name='outbox46_recover_holder'; select count(*)=1 from public.recover_delegated_notification_outbox(20);
select pg_sleep(6); commit;
SQL
holder_pid=$!; observe outbox46_recover_holder "wait_event='PgSleep'"
psql_task >"$task_tmp/finish-waiter" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set application_name='outbox46_finish_waiter';
select public.finish_notification_outbox_initial(id,automation_initial_token) from public.notification_outbox where id='$outbox'; commit;
SQL
waiter_pid=$!; observe outbox46_finish_waiter "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
join_sessions; grep -qx t "$task_tmp/finish-waiter"
[[ $(psql_task -c "select md5(automation_initial_token::text) from public.notification_outbox where id='$outbox'") == "$before" ]] || exit 1
echo 'GREEN46 original owner survives concurrent recovery'
setup 2 true true
psql_task >"$task_tmp/skip-holder" 2>&1 <<SQL &
begin; set application_name='outbox46_skip_holder'; select id from public.notification_outbox where id='$outbox' for update;
select pg_sleep(6); commit;
SQL
holder_pid=$!; observe outbox46_skip_holder "wait_event='PgSleep'"
[[ $(psql_task -c "set statement_timeout='2s'; select count(*)=1 and bool_and(id<>'$outbox'::uuid) from public.recover_delegated_notification_outbox(20) id") == t ]] || exit 1
join_sessions
echo 'GREEN46 real SKIP LOCKED progress'
setup 21 true true
[[ $(psql_task -c "select count(*)=0 from public.recover_delegated_notification_outbox(0)") == t ]] || exit 1
[[ $(psql_task -c "select count(*)=20 from public.recover_delegated_notification_outbox(999)") == t ]] || exit 1
[[ $(psql_task -c "select count(*)=1 from public.notification_outbox where unit_id='$unit' and status='processing'") == t ]] || exit 1
[[ $(psql_task -c "select count(*)=0 from app_private.notification_outbox_mutation_permits") == t ]] || exit 1
echo 'GREEN46 clamp0..20 and no orphan permits'

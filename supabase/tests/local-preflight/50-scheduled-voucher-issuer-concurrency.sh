#!/usr/bin/env bash
# ROOT only after frozen source review. Native independent sessions, observed
# blockers, real clocks. Same-day waits do NOT claim physical-midnight coverage.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ $# == 0 && -z ${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-} ]] || exit 1
task_docker='C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'
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
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-03-whatsapp-templates-programados/issuer50.XXXXXX")
for key in org unit customer other_customer actor channel binding rule; do
 value=$(psql_task -c 'select gen_random_uuid()'); [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; printf -v "$key" '%s' "$value"
done
[[ $(psql_task -c "select array_agg(attname::text order by attname)=array['key','value'] from pg_attribute where attrelid='public.platform_flags'::regclass and attnum>0 and not attisdropped") == t ]] || exit 1
flag_before=$(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'")
holder_pid='' waiter_pid=''
clean_fixture() {
 psql_task -c "begin; set local statement_timeout='10s'; update public.customers set deleted_at=clock_timestamp() where id in('$customer','$other_customer') and deleted_at is null;
 delete from public.whatsapp_promotion_slots where unit_id='$unit'; delete from public.whatsapp_automation_jobs where unit_id='$unit';
 delete from public.vouchers where unit_id='$unit'; delete from public.voucher_rules where unit_id='$unit';
 delete from public.whatsapp_template_bindings where id='$binding'; delete from public.organizations where id='$org'; delete from auth.users where id='$actor'; commit;" >/dev/null
}
cleanup() {
 local original_exit=$?
 if [[ -n $holder_pid ]]; then wait "$holder_pid" || original_exit=1; fi
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || original_exit=1; fi
 clean_fixture || original_exit=1
 psql_task -v task50_original_flag="$flag_before" >"$task_tmp/flag-restored" <<'SQL' || original_exit=1
begin;
delete from public.platform_flags where key='whatsapp_automation_dispatch';
insert into public.platform_flags(key,value)
select data->>'key',case when (data->>'value_is_sql_null')::boolean then null::jsonb else data->'value' end
from jsonb_array_elements(:'task50_original_flag'::jsonb) as snapshot(data);
commit;
SQL
 [[ $(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'") == "$flag_before" ]] || original_exit=1
 echo "Task50 cleanup native exit $original_exit; exact flags restored; raw sessions $task_tmp"
 exit "$original_exit"
}
trap cleanup EXIT
observe() {
 local label=$1 predicate=$2
 for _ in {1..50}; do
  observed=$(psql_task -c "select jsonb_build_object('application',application_name,'pid',pid,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid),'observed_at',clock_timestamp()) from pg_stat_activity where application_name='$label' and $predicate")
  if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$task_tmp/$label-observed"; return; fi
 done
 echo "FAIL50 actual wait not observed $label"; exit 1
}
setup() {
 clean_fixture
 psql_task >"$task_tmp/setup-$1" <<SQL
begin;
insert into auth.users(id) values('$actor'); insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$org','Task50');
insert into public.units(id,organization_id,name,slug,timezone) values('$unit','$org','Task50','task50-$unit','America/Sao_Paulo');
insert into public.customers(id,organization_id,name,phone,birthday,do_not_contact,deleted_at) values
 ('$customer','$org','Synthetic','55912345678','1990-01-01',false,null),('$other_customer','$org','Other','11912345678','1990-01-01',false,null);
insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at)
 values('$rule','$unit','Task50','birthday',15,30,null,null,null,true,clock_timestamp(),clock_timestamp());
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$channel','$unit','zapi','connected',true,clock_timestamp());
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,adopted_at,dispatch_enabled) values('$binding','$unit','$channel','zapi',clock_timestamp(),true);
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
commit;
SQL
 expected=$(psql_task -c "select jsonb_build_object('unit_id',unit_id,'trigger_type',trigger_type,'discount_percent',discount_percent,'validity_days',validity_days,'visits_required',visits_required,'days_window',days_window,'selected_brt_day',((clock_timestamp() at time zone 'UTC')-interval '3 hours')::date) from public.voucher_rules where id='$rule'")
 [[ $expected == \{*\} ]] || exit 1
}
start_holder() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-holder" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set local lock_timeout='12s'; set application_name='issuer50_${label}_holder';
$statement
select pg_sleep(8); commit;
SQL
 holder_pid=$!; observe "issuer50_${label}_holder" "wait_event='PgSleep'"
}
start_waiter() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-waiter" 2>&1 <<SQL &
begin; set local statement_timeout='20s'; set local lock_timeout='12s'; set application_name='issuer50_${label}_waiter';
$statement
commit;
SQL
 waiter_pid=$!; observe "issuer50_${label}_waiter" "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
}
join_sessions() {
 local failed=0 holder_exit=0 waiter_exit=0
 wait "$holder_pid" || holder_exit=$?; holder_pid=''
 wait "$waiter_pid" || waiter_exit=$?; waiter_pid=''
 printf 'holder_native=%s waiter_native=%s\n' "$holder_exit" "$waiter_exit" >"$task_tmp/$1-native-exits"
 [[ $holder_exit == 0 && $waiter_exit == 0 ]] || { echo 'FAIL50 native independent session exit'; exit 1; }
}
one_pair() {
 [[ $(psql_task -c "select (select count(*) from public.vouchers where unit_id='$unit')=1 and (select count(*) from public.whatsapp_automation_jobs where unit_id='$unit')=1 and exists(select from public.vouchers v join public.whatsapp_automation_jobs j on j.voucher_id=v.id where v.unit_id='$unit' and j.unit_id=v.unit_id and j.source_event_key=v.id::text and j.fact_at=v.created_at and extract(epoch from (j.expires_at-j.fact_at))*1000=604800000)") == t ]] || exit 1
}
no_pair() {
 [[ $(psql_task -c "select not exists(select from public.vouchers where unit_id='$unit') and not exists(select from public.whatsapp_automation_jobs where unit_id='$unit')") == t ]] || exit 1
}
negative() {
 # Execute an actual issuer call and validate the native exception, not a fake response.
 printf "do \$\$ declare caught text; begin begin perform * from public.issue_scheduled_whatsapp_voucher('%s','%s','NEG','%s'::jsonb); exception when others then get stacked diagnostics caught=RETURNED_SQLSTATE; end; if caught is distinct from '%s' then raise exception 'FAIL50 expected %s got %%',caught; end if; end \$\$;" "$rule" "$customer" "$expected" "$1" "$1"
}
setup competing
start_holder competing "select count(*)=1 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-A','$expected'::jsonb);"
start_waiter competing "select count(*)=0 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-B','$expected'::jsonb);"
join_sessions competing; grep -qx t "$task_tmp/competing-holder"; grep -qx t "$task_tmp/competing-waiter"; one_pair
echo 'GREEN50 actual competing issuer winner + unknown loser; one pair'
# A committed response need not reach the producer. Re-running cannot rediscover
# the previous winner; durability/retry is the existing ledger, not reissuance.
[[ $(psql_task -c "select count(*)=0 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-LOST','$expected'::jsonb)") == t ]] || exit 1
one_pair; echo 'GREEN50 committed pair survives response omission; no heuristic winner recovery'

setup code
start_holder code "select count(*)=1 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-CODE','$expected'::jsonb);"
start_waiter code "select count(*)=0 from public.issue_scheduled_whatsapp_voucher('$rule','$other_customer','RACE50-CODE','$expected'::jsonb);"
join_sessions code; grep -qx t "$task_tmp/code-holder"; grep -qx t "$task_tmp/code-waiter"; one_pair
echo 'GREEN50 actual global-code index conflict, independent customers, no second ledger'

setup clock
start_holder clock "select id from public.customers where id='$customer' for update;"
start_waiter clock "select count(*)=1 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-CLOCK','$expected'::jsonb);"
observed_clock=$(psql_task -c "select clock_timestamp()")
join_sessions clock; one_pair
[[ $(psql_task -c "select created_at>'$observed_clock'::timestamptz and issued_at=created_at from public.vouchers where unit_id='$unit'") == t ]] || exit 1
echo 'GREEN50 issue clock is after observed initial customer wait, same day'

setup erasure_before
start_holder erasure_before "update public.customers set deleted_at=clock_timestamp() where id='$customer';"
start_waiter erasure_before "$(negative 42501)"
join_sessions erasure_before; no_pair
echo 'GREEN50 erasure wins customer lock; issuance refuses with no artifacts'

setup erasure_after
start_holder erasure_after "select count(*)=1 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-ERASE','$expected'::jsonb);"
start_waiter erasure_after "update public.customers set deleted_at=clock_timestamp() where id='$customer';"
join_sessions erasure_after
[[ $(psql_task -c "select count(*)=1 and bool_and(customer_id is null and customer_erased_at is not null and safe_log_body is null) from public.whatsapp_automation_jobs where unit_id='$unit'") == t ]] || exit 1
echo 'GREEN50 issuer wins customer lock; later actual erasure sanitizes committed ledger'

setup rule_update
start_holder rule_update "update public.voucher_rules set discount_percent=16 where id='$rule';"
start_waiter rule_update "$(negative 22023)"
join_sessions rule_update; no_pair
echo 'GREEN50 stored rule drift after observed SHARE wait refuses both'

setup rule_delete
start_holder rule_delete "delete from public.voucher_rules where id='$rule';"
start_waiter rule_delete "$(negative 42501)"
join_sessions rule_delete; no_pair
echo 'GREEN50 actual rule deletion after observed SHARE wait refuses both'

setup config
start_holder config "select id from public.whatsapp_template_bindings where id='$binding' for update;"
start_waiter config "select count(*)=1 from public.issue_scheduled_whatsapp_voucher('$rule','$customer','RACE50-CONFIG','$expected'::jsonb);"
observed_clock=$(psql_task -c "select clock_timestamp()")
# The waiter really holds the earlier customer and rule while blocked in enqueue.
psql_task >"$task_tmp/config-earlier-locks" <<SQL
do \$\$ declare blocked boolean:=false; begin
 begin perform 1 from public.customers where id='$customer' for update nowait; exception when lock_not_available then blocked:=true; end;
 if not blocked then raise exception 'FAIL50 expected customer held'; end if; blocked:=false;
 begin perform 1 from public.voucher_rules where id='$rule' for update nowait; exception when lock_not_available then blocked:=true; end;
 if not blocked then raise exception 'FAIL50 expected rule held'; end if;
end \$\$;
SQL
join_sessions config; one_pair
[[ $(psql_task -c "select created_at<'$observed_clock'::timestamptz from public.vouchers where unit_id='$unit'") == t ]] || exit 1
echo 'GREEN50 enqueue config wait occurs after issue clock, earlier locks held; final day source check separate'
echo 'Physical BRT midnight crossing NOT exercised by this same-day gate.'

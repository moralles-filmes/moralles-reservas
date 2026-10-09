#!/usr/bin/env bash
# ROOT-only independent sessions. Every wait is observed in pg_stat_activity.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ $# == 0 && -z ${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-} ]] || exit 1
task_docker='C:/Users/Yuri/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'
task_container=supabase_db_moralles-templates-20261003
[[ $("$task_docker" context inspect --format '{{ .Endpoints.docker.Host }}') == npipe:////./pipe/dockerDesktopLinuxEngine ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .State.Running }}' "$task_container") == true ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .Name }}' "$task_container") == /$task_container ]] || exit 1
[[ $("$task_docker" inspect --format '{{ index .Config.Labels "com.supabase.cli.project" }}' "$task_container") == moralles-templates-20261003 ]] || exit 1
[[ $("$task_docker" inspect --format '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$task_container") == 55452 ]] || exit 1
psql_task() { "$task_docker" exec -i "$task_container" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
[[ $(psql_task -c "select not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) and not exists(select from net.http_request_queue)") == t ]] || exit 1
task_root=$(cd "$(dirname "$0")/../../.." && pwd)
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-03-whatsapp-templates-programados/management58.XXXXXX")
for key in org unit unit2 customer replacement_customer actor owner channel channel2 reservation job account dch1 dch2 db1 db2 template catalog_job initial_job initial_res; do
 value=$(psql_task -c 'select gen_random_uuid()'); [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; printf -v "$key" '%s' "$value"
done
holder_pid='' waiter_pid=''
cleanup() {
 local result=$?
 if [[ -n $holder_pid ]]; then wait "$holder_pid" || result=1; fi
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || result=1; fi
 psql_task -c "begin;set local statement_timeout='15s';delete from public.audit_log where actor_id in('$actor','$owner');delete from public.conversations where unit_id in(select id from public.units where organization_id='$org');delete from public.notifications_sent where unit_id in('$unit','$unit2');delete from public.organizations where id='$org';delete from auth.users where id in('$actor','$owner');commit;" >"$task_tmp/cleanup" 2>&1 || result=1
 [[ $(psql_task -c "select not exists(select from public.organizations where id='$org') and not exists(select from auth.users where id in('$actor','$owner')) and not exists(select from public.audit_log where actor_id in('$actor','$owner')) and not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))") == t ]] || result=1
 echo "Task58 cleanup native $result; raw sessions $task_tmp"; exit "$result"
}
trap cleanup EXIT
observe() {
 local label=$1 predicate=$2 observed
 for _ in {1..60}; do
  observed=$(psql_task -c "select jsonb_build_object('application',application_name,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid),'observed_at',clock_timestamp()) from pg_stat_activity where application_name='$label' and $predicate")
  if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$task_tmp/$label-observed"; return; fi
 done
 echo "FAIL58 actual wait not observed $label"; exit 1
}
holder() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-holder" 2>&1 <<SQL &
begin;set local statement_timeout='25s';set local lock_timeout='15s';set application_name='management58_${label}_holder';
$statement
select pg_sleep(8);commit;
SQL
 holder_pid=$!;observe "management58_${label}_holder" "wait_event='PgSleep'"
}
waiter() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-waiter" 2>&1 <<SQL &
begin;set local statement_timeout='25s';set local lock_timeout='15s';set application_name='management58_${label}_waiter';
$statement
commit;
SQL
 waiter_pid=$!;observe "management58_${label}_waiter" "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
}
join_pair() {
 local h=0 w=0
 wait "$holder_pid" || h=$?;holder_pid='';wait "$waiter_pid" || w=$?;waiter_pid=''
 printf 'holder_native=%s waiter_native=%s\n' "$h" "$w" >"$task_tmp/$1-native"
 [[ $h == 0 && $w == 0 ]] || { echo "FAIL58 native $1";exit 1; };echo "GREEN58 observed $1"
}
check() { [[ $(psql_task -c "$1") == t ]] || { echo "FAIL58 $2";exit 1; };echo "GREEN58 $2"; }
fast_prepare_refusal() {
 local label=$1 owned_job=$2 generation=$3
 psql_task >"$task_tmp/$label-fast" 2>&1 <<SQL
begin;set local statement_timeout='2s';set local lock_timeout='1s';set application_name='management58_${label}_fast';
do \$\$ declare before_row jsonb;started timestamptz:=clock_timestamp();begin
 select to_jsonb(j) into before_row from public.whatsapp_automation_jobs j where id='$owned_job';
 if before_row is null then raise exception 'FAIL58 fast control missing fixture';end if;
 if public.prepare_whatsapp_automation_post('$owned_job',gen_random_uuid(),$generation,null,null) then raise exception 'FAIL58 invalid fence accepted';end if;
 if (select to_jsonb(j) from public.whatsapp_automation_jobs j where id='$owned_job') is distinct from before_row then raise exception 'FAIL58 fast refusal changed row';end if;
 raise notice 'GREEN58 fast refusal with no effect; elapsed_ms=%',extract(epoch from clock_timestamp()-started)*1000;
end \$\$;rollback;
SQL
 echo "GREEN58 fast refusal $label (no blocking claim)"
}
claim_prepare_waiter() {
 local label=$1 owned_job=$2 generation=$3
 # The observed wait is in claim's real FOR UPDATE. Retain its returned fence
 # across COMMIT; prepare runs in a new transaction with the committed claim.
 waiter "$label" "create temp table task58_claim_result as select public.claim_whatsapp_automation('$owned_job') as result;
do \$\$ declare claimed jsonb;begin select result into claimed from task58_claim_result;
 if claimed->>'id' is distinct from '$owned_job' or claimed->>'state' is distinct from 'claimed' or claimed->>'claim_token' is null then raise exception 'FAIL58 real claim did not win after management writer';end if;end \$\$;
commit;begin;set local statement_timeout='25s';set local lock_timeout='15s';
create temp table task58_dispatch_before on commit drop as select value from public.platform_flags where key='whatsapp_automation_dispatch';
update public.platform_flags set value='true'::jsonb where key='whatsapp_automation_dispatch';
do \$\$ declare claimed jsonb;f uuid;consent_revision bigint;begin
 select result into claimed from task58_claim_result;f:=(claimed->>'claim_token')::uuid;
 select revision into consent_revision from public.whatsapp_message_consent_events where unit_id='$unit' and customer_id='$customer' and purpose='operational' order by revision desc limit 1;
 update public.whatsapp_automation_jobs set safe_log_body='Task58 synthetic frozen render' where id='$owned_job' and claim_token=f;
 if not found then raise exception 'FAIL58 real claim fence changed';end if;
 if not public.prepare_whatsapp_automation_post('$owned_job',f,$generation,consent_revision,null) then raise exception 'FAIL58 real fence prepare after management writer';end if;
 update public.platform_flags set value='false'::jsonb where key='whatsapp_automation_dispatch';
 if not public.finish_whatsapp_automation('$owned_job',f,'{\"outcome\":\"local_preflight_refused\",\"reason\":\"final_gate_paused\"}') then raise exception 'FAIL58 actual zero-POST finisher';end if;
end \$\$;
update public.platform_flags set value=(select value from task58_dispatch_before) where key='whatsapp_automation_dispatch';"
}
admin="select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"$actor\"}',true);"
manager="select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"sub\":\"$owner\"}',true);"
catalog_on="create temp table task58_flag_before on commit drop as select value from public.platform_flags where key='whatsapp_template_catalog';update public.platform_flags set value='true'::jsonb where key='whatsapp_template_catalog';"
catalog_restore="update public.platform_flags set value=(select value from task58_flag_before) where key='whatsapp_template_catalog';"
psql_task >"$task_tmp/setup" <<SQL
begin;
insert into auth.users(id) values('$actor'),('$owner');insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$org','Task58');
insert into public.units(id,organization_id,name) values('$unit','$org','Task58'),('$unit2','$org','Task58 bootstrap');
insert into public.unit_members(user_id,unit_id,role) values('$owner','$unit','owner');
insert into public.customers(id,organization_id,name,phone) values('$customer','$org','Synthetic','11999995858'),('$replacement_customer','$org','Synthetic replacement','11999995859');
insert into public.reservations(id,unit_id,customer_id) values('$initial_res','$unit','$customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,pin_phase,initial_catalog_key,state,error_code)
 values('$initial_job','$unit','$org','confirmation','$initial_res','$customer','task58-initial',clock_timestamp(),clock_timestamp()+interval '1 hour','preconfiguration','res_confirmacao_v1','blocked','channel_unconfigured');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,webhook_secret) values('$channel','$unit','zapi','connected',true,clock_timestamp(),'synthetic-task58'),('$channel2','$unit2','zapi','connected',true,clock_timestamp(),'synthetic-task58');
$admin
select public.release_whatsapp_template_channel('$channel','dispatch',true,0,null);
insert into public.reservations(id,unit_id,customer_id) values('$reservation','$unit','$customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,error_code)
select '$job','$unit','$org','confirmation','$reservation','$customer','task58:$reservation',clock_timestamp(),clock_timestamp()+interval '1 hour','$channel','zapi',id,generation,'text','blocked','binding_changed' from public.whatsapp_template_bindings where channel_id='$channel';
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values('$dch1','$unit','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"5801"}','synthetic-task58-d1'),('$dch2','$unit','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"5802"}','synthetic-task58-d2');
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('$account','$org','5800000000001',clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('$db1','$unit','$dch1','$account','datafy',clock_timestamp()),('$db2','$unit','$dch2','$account','datafy',clock_timestamp());
select public.release_whatsapp_template_channel('$dch1','catalog',true,0,1);
select public.release_whatsapp_template_channel('$dch2','catalog',true,0,1);
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('$template','$account','res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('c',64),'UTILITY',1);
commit;
SQL
# Invalid-fence refusal is fast; the actual claim waits for initialization.
fast_prepare_refusal initialize_prepare "$initial_job" 1
holder initialize_prepare "$admin do \$\$ begin if not public.initialize_whatsapp_automation_job('$initial_job','$channel',1) then raise exception 'FAIL58 initializer';end if;end \$\$;"
claim_prepare_waiter initialize_prepare "$initial_job" 1
join_pair initialize_prepare
check "select pin_phase='bound' and posting_started_at is null and attempts=0 and fact_at<expires_at from public.whatsapp_automation_jobs where id='$initial_job'" 'initializer one completion with original facts'
# Actual consent writer takes customer lock; opt-out revision must follow it.
holder consent "$manager select public.record_whatsapp_message_consent('$unit','$customer','promotional','opt_in','in_person',clock_timestamp(),'synthetic optin');"
waiter consent "$manager select public.record_whatsapp_message_consent('$unit','$customer','promotional','opt_out','customer_message',clock_timestamp(),'synthetic refusal');"
join_pair consent
check "select count(*)=2 and max(revision)=2 and (select decision='opt_out' from public.whatsapp_message_consent_events where unit_id='$unit' and customer_id='$customer' order by revision desc limit 1) from public.whatsapp_message_consent_events where unit_id='$unit' and customer_id='$customer'" 'serialized consent latest optout'
# Actual channel writer increments revision while enable is blocked on its lock.
psql_task -c "begin;$admin select public.release_whatsapp_template_channel('$channel','dispatch',false,0,1);commit;" >"$task_tmp/pause"
holder rotate "update public.whatsapp_channels set webhook_secret=null where id='$channel';"
waiter rotate "$admin do \$\$ begin begin perform public.release_whatsapp_template_channel('$channel','dispatch',true,0,1);raise exception 'FAIL58 old revision accepted';exception when sqlstate 'PT409' then null;end;end \$\$;"
join_pair rotate
check "select not dispatch_enabled from public.whatsapp_template_bindings where channel_id='$channel'" 'rotation did not enable'
# Restore only own fixture through the production revision/reconcile/release APIs.
psql_task >"$task_tmp/restore" <<SQL
begin;update public.whatsapp_channels set webhook_secret='synthetic-task58-current',last_health_check_at=clock_timestamp() where id='$channel';
select public.reconcile_whatsapp_template_credentials('$channel');$admin
select public.release_whatsapp_template_channel('$channel','dispatch',true,2,2);commit;
SQL
# Stop after an actual health writer wait still succeeds; no secret/flag gate.
holder health_stop "update public.whatsapp_channels set status='disconnected',last_health_check_at=null where id='$channel';"
waiter health_stop "$admin do \$\$ begin if not public.release_whatsapp_template_channel('$channel','dispatch',false,2,2) then raise exception 'FAIL58 health blocked stop';end if;end \$\$;"
join_pair health_stop
check "select not dispatch_enabled and adopted_at is not null from public.whatsapp_template_bindings where channel_id='$channel'" 'unhealthy stop retained adoption'
# Two genuine release writers race on UNIQUE(channel); no second bootstrap.
holder bootstrap "$admin select public.release_whatsapp_template_channel('$channel2','dispatch',true,0,null);"
waiter bootstrap "$admin do \$\$ begin begin perform public.release_whatsapp_template_channel('$channel2','dispatch',true,0,null);raise exception 'FAIL58 second bootstrap';exception when sqlstate 'PT409' then null;end;end \$\$;"
join_pair bootstrap
check "select count(*)=1 and bool_and(dispatch_enabled) from public.whatsapp_template_bindings where channel_id='$channel2'" 'single bootstrap winner'
# A consent writer forces revalidation to wait beyond the ORIGINAL deadline.
psql_task >"$task_tmp/expiry-setup" <<SQL
begin;update public.whatsapp_channels set status='connected',last_health_check_at=clock_timestamp() where id='$channel';$admin
select public.release_whatsapp_template_channel('$channel','dispatch',true,2,2);
-- A new short-lived intent avoids any forbidden deadline rewrite.
insert into public.reservations(id,unit_id,customer_id) values(gen_random_uuid(),'$unit','$customer') returning id \gset
insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,error_code)
select '$unit','$org','confirmation',:'id','$customer','task58-expiry',clock_timestamp(),clock_timestamp()+interval '5 seconds','$channel','zapi',id,generation,'text','blocked','binding_changed' from public.whatsapp_template_bindings where channel_id='$channel';commit;
SQL
expiry_job=$(psql_task -c "select id from public.whatsapp_automation_jobs where unit_id='$unit' and source_event_key='task58-expiry'")
holder expiry "$manager select public.record_whatsapp_message_consent('$unit','$customer','operational','opt_in','in_person',clock_timestamp(),'synthetic lock');"
waiter expiry "$manager do \$\$ begin if public.revalidate_whatsapp_automation_job('$expiry_job','$channel',2) then raise exception 'FAIL58 renewed expiry';end if;end \$\$;"
join_pair expiry
check "select state='blocked' and attempts=0 and expires_at<clock_timestamp() from public.whatsapp_automation_jobs where id='$expiry_job'" 'postwait SQL clock preserves original expiry'
# Separate the invalid-fence control from claim waiting on real revalidation.
fast_prepare_refusal revalidate_prepare "$job" 2
holder revalidate_prepare "$manager select public.revalidate_whatsapp_automation_job('$job','$channel',2);"
claim_prepare_waiter revalidate_prepare "$job" 2
join_pair revalidate_prepare
check "select posting_started_at is null and attempts=0 and initial_credential_revision=0 and binding_generation=2 from public.whatsapp_automation_jobs where id='$job'" 'prepare retained original authority and no POST'

# Selected sync may delegate to an earlier eligible sibling in the SAME account.
earlier_binding=$(psql_task -c "select id from public.whatsapp_template_bindings where account_id='$account' order by id limit 1")
later_channel=$(psql_task -c "select channel_id from public.whatsapp_template_bindings where account_id='$account' order by id desc limit 1")
psql_task >"$task_tmp/sync-positive" <<SQL
begin;$manager $catalog_on
do \$\$ declare j uuid;begin j:=public.request_whatsapp_template_sync_for_channel('$later_channel',1);
 if j is null or not exists(select from public.whatsapp_template_jobs where id=j and binding_id='$earlier_binding') then raise exception 'FAIL58 delegate earlier sibling';end if;end \$\$;
$catalog_restore commit;
SQL
echo 'GREEN58 original sync selects earlier eligible sibling from later selected request'
holder sync_rotation "update public.whatsapp_channels set webhook_secret='synthetic-task58-rotated' where id='$later_channel';"
waiter sync_rotation "$manager $catalog_on do \$\$ begin begin perform public.request_whatsapp_template_sync_for_channel('$later_channel',1);raise exception 'FAIL58 selected stale revision';exception when sqlstate 'PT409' then null;end;end \$\$; $catalog_restore"
join_pair sync_rotation
check "select count(*)=1 from public.whatsapp_template_jobs where account_id='$account' and operation='sync'" 'changed selected channel cannot rely on healthy sibling'
earlier_channel=$(psql_task -c "select channel_id from public.whatsapp_template_bindings where id='$earlier_binding'")
# A genuine cost writer waits for the account lock, then checks its final clock.
holder cost_clock "select public.request_whatsapp_template_sync('$account');"
waiter cost_clock "$admin do \$\$ declare stamp timestamptz:=transaction_timestamp();begin begin perform public.authorize_whatsapp_marketing_cost('$earlier_channel',1,'MARKETING',stamp,stamp+interval '4 seconds');raise exception 'FAIL58 expired cost';exception when sqlstate '22023' then null;end;end \$\$;"
join_pair cost_clock
check "select not exists(select from public.whatsapp_template_cost_authorizations where account_id='$account')" 'cost final clock expires while awaiting actual sync writer'

# Generate durable zero-POST proof through actual prepare/finish, never by INSERT.
catalog_binding=$(psql_task -c "select id from public.whatsapp_template_bindings where account_id='$account' order by id limit 1")
catalog_channel=$(psql_task -c "select channel_id from public.whatsapp_template_bindings where id='$catalog_binding'")
catalog_generation=$(psql_task -c "select generation from public.whatsapp_template_bindings where id='$catalog_binding'")
psql_task >"$task_tmp/catalog-proof" <<SQL
begin;$catalog_on
update public.whatsapp_template_accounts set sync_capture_id=gen_random_uuid(),last_sync_published_at=clock_timestamp(),sync_binding_id='$catalog_binding',sync_binding_generation=$catalog_generation,sync_credential_revision=(select template_credential_revision from public.whatsapp_channels where id='$catalog_channel') where id='$account';
update public.whatsapp_remote_templates set sync_required=false,last_synced_at=clock_timestamp(),binding_generation=(select binding_generation from public.whatsapp_template_accounts where id='$account') where id='$template';
insert into public.whatsapp_template_jobs(id,organization_id,account_id,binding_id,binding_generation,operation,target_key) values('$catalog_job','$org','$account','$catalog_binding',$catalog_generation,'provision','res_confirmacao_v1');
do \$\$ declare f uuid;begin f:=(public.claim_whatsapp_template_job('$catalog_job')->>'claim_token')::uuid;
 if not public.prepare_whatsapp_template_provision('$catalog_job',f,$catalog_generation) then raise exception 'FAIL58 original catalog prepare';end if;
 if not public.finish_whatsapp_template_job('$catalog_job',f,'{"outcome":"local_preflight_refused","reason":"final_channel_changed"}') then raise exception 'FAIL58 original catalog refusal';end if;end \$\$;
$catalog_restore commit;
SQL
holder catalog_correction "$admin do \$\$ begin if not public.revalidate_whatsapp_template_job('$catalog_job','$catalog_channel',$catalog_generation) then raise exception 'FAIL58 catalog correction';end if;end \$\$;"
waiter catalog_correction "select public.claim_whatsapp_template_job('$catalog_job');"
join_pair catalog_correction
catalog_fence=$(psql_task -c "select claim_token from public.whatsapp_template_jobs where id='$catalog_job'")
holder catalog_prepare "$catalog_on do \$\$ begin if not public.prepare_whatsapp_template_provision('$catalog_job','$catalog_fence',$catalog_generation) then raise exception 'FAIL58 authorized prepare';end if;end \$\$; $catalog_restore"
waiter catalog_prepare "do \$\$ begin if public.prepare_whatsapp_template_provision('$catalog_job','$catalog_fence',$catalog_generation) then raise exception 'FAIL58 double prepare';end if;end \$\$;"
join_pair catalog_prepare
check "select count(*)=1 and bool_and(consumed_at is not null and consumed_claim_token='$catalog_fence') from app_private.whatsapp_template_revalidation_authorizations where job_id='$catalog_job'" 'one catalog authorization consumed by one prepare'

# Bound template correction locks both original and destination accounts before job.
for key in shift_unit shift_old_channel shift_channel shift_old_binding shift_binding shift_account shift_template shift_res shift_job; do
 value=$(psql_task -c 'select gen_random_uuid()');printf -v "$key" '%s' "$value"
done
psql_task >"$task_tmp/account-shift-setup" <<SQL
begin;$admin
insert into public.units(id,organization_id,name) values('$shift_unit','$org','Task58 account shift');
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('$shift_account','$org','5800000000002',clock_timestamp());
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret) values('$shift_old_channel','$shift_unit','datafy','connected',true,clock_timestamp(),'{"phone_number_id":"5803"}','synthetic-task58-old'),('$shift_channel','$shift_unit','datafy','connected',false,clock_timestamp(),'{"phone_number_id":"5804"}','synthetic-task58-new');
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('$shift_old_binding','$shift_unit','$shift_old_channel','$account','datafy',clock_timestamp()),('$shift_binding','$shift_unit','$shift_channel','$shift_account','datafy',clock_timestamp());
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('$shift_template','$shift_account','res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('d',64),'UTILITY',1);
insert into public.reservations(id,unit_id,customer_id) values('$shift_res','$shift_unit','$customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,state,error_code)
 values('$shift_job','$shift_unit','$org','confirmation','$shift_res','$customer','task58-account-shift',clock_timestamp(),clock_timestamp()+interval '1 hour','$shift_old_channel','datafy','$shift_old_binding',1,'template','$account','$template',1,0,'needs_review','binding_changed');
update public.whatsapp_channels set is_active=false where id='$shift_old_channel';update public.whatsapp_channels set is_active=true where id='$shift_channel';
select public.release_whatsapp_template_channel('$shift_channel','dispatch',true,0,1);commit;
SQL
holder account_shift "select public.request_whatsapp_template_sync('$account');"
waiter account_shift "$admin do \$\$ begin if not public.revalidate_whatsapp_automation_job('$shift_job','$shift_channel',1) then raise exception 'FAIL58 same transport correction';end if;end \$\$;"
join_pair account_shift
check "select account_id='$shift_account' and channel_id='$shift_channel' and transport='template' and attempts=0 and posting_started_at is null and initial_credential_revision=0 from public.whatsapp_automation_jobs where id='$shift_job'" 'old and new account locks preserve transport and insertion history'

# A resource reassignment observed after a blocked customer lock cannot retarget.
psql_task -c "update public.whatsapp_automation_jobs set state='needs_review',error_code='reservation_changed' where id='$job';" >"$task_tmp/resource-setup"
holder resource_change "select id from public.customers where id='$customer' for update;update public.reservations set customer_id='$replacement_customer' where id='$reservation';"
waiter resource_change "$manager do \$\$ begin begin perform public.revalidate_whatsapp_automation_job('$job','$channel',2);raise exception 'FAIL58 resource retarget';exception when sqlstate '42501' then null;end;end \$\$;"
join_pair resource_change
check "select customer_id='$customer' and attempts=0 and posting_started_at is null from public.whatsapp_automation_jobs where id='$job'" 'resource change preserves immutable recipient'
# Actual soft erasure writer acquires customer lock; waiting manual opt-in refuses.
holder erasure "update public.customers set deleted_at=clock_timestamp(),do_not_contact=true where id='$customer';"
waiter erasure "$manager do \$\$ begin begin perform public.record_whatsapp_message_consent('$unit','$customer','operational','opt_in','signed_form',clock_timestamp(),'synthetic after erasure');raise exception 'FAIL58 erased consent';exception when sqlstate '42501' then null;end;end \$\$;"
join_pair erasure
check "select deleted_at is not null from public.customers where id='$customer'" 'erasure remains authoritative after wait'
echo 'GREEN58 real writers, observed waits, original clock and local cleanup only'

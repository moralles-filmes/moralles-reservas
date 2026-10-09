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
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-03-whatsapp-templates-programados/receipts54.XXXXXX")
[[ $(psql_task -c "select not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers')) and not exists(select from net.http_request_queue)") == t ]] || exit 1
for key in org unit customer actor channel binding reservation job vault_channel vault_claim; do
 value=$(psql_task -c 'select gen_random_uuid()'); [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; printf -v "$key" '%s' "$value"
done
holder_pid='' waiter_pid='' flag_restore=''
cleanup() {
 local result=$?
 if [[ -n $holder_pid ]]; then wait "$holder_pid" || result=1; fi
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || result=1; fi
 if [[ -n $flag_restore ]]; then psql_task -c "$flag_restore" >"$task_tmp/flag-restored" 2>&1 || result=1; fi
 psql_task -c "begin;set local statement_timeout='10s';delete from public.conversations where unit_id in(select id from public.units where organization_id='$org');delete from public.notifications_sent where unit_id='$unit';delete from public.whatsapp_channel_lifecycle_events where channel_ref='$vault_channel' and organization_id='$org';delete from public.organizations where id='$org';delete from vault.secrets where name='whatsapp-channel-$vault_channel-uazapi-token';delete from auth.users where id='$actor';commit;" >"$task_tmp/cleanup" 2>&1 || result=1
 [[ $(psql_task -c "select not exists(select from public.whatsapp_automation_jobs where unit_id='$unit') and not exists(select from public.whatsapp_automation_receipt_events where unit_id='$unit') and not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))") == t ]] || result=1
 echo "Task54 cleanup native $result; raw sessions $task_tmp"; exit "$result"
}
trap cleanup EXIT
observe() {
 local label=$1 predicate=$2 observed
 for _ in {1..60}; do
  observed=$(psql_task -c "select jsonb_build_object('application',application_name,'pid',pid,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid),'observed_at',clock_timestamp()) from pg_stat_activity where application_name='$label' and $predicate")
  if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$task_tmp/$label-observed"; return; fi
 done
 echo "FAIL54 wait not observed $label"; exit 1
}
holder() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-holder" 2>&1 <<SQL &
begin;set local statement_timeout='20s';set local lock_timeout='12s';set application_name='receipts54_${label}_holder';
$statement
select pg_sleep(8);commit;
SQL
 holder_pid=$!;observe "receipts54_${label}_holder" "wait_event='PgSleep'"
}
waiter() {
 local label=$1 statement=$2
 psql_task >"$task_tmp/$label-waiter" 2>&1 <<SQL &
begin;set local statement_timeout='20s';set local lock_timeout='12s';set application_name='receipts54_${label}_waiter';
$statement
commit;
SQL
 waiter_pid=$!;observe "receipts54_${label}_waiter" "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
}
join_pair() {
 local h=0 w=0
 wait "$holder_pid" || h=$?;holder_pid=''
 if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || w=$?;waiter_pid='';fi
 printf 'holder_native=%s waiter_native=%s\n' "$h" "$w" >"$task_tmp/$1-native"
 [[ $h == 0 && $w == 0 ]] || { echo "FAIL54 native $1";exit 1; }
 echo "GREEN54 observed $1"
}
check() { [[ $(psql_task -c "$1") == t ]] || { echo "FAIL54 $2";exit 1; };echo "GREEN54 $2"; }
psql_task >"$task_tmp/setup" <<SQL
begin;
insert into auth.users(id) values('$actor');insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$org','Task54');
insert into public.units(id,organization_id,name) values('$unit','$org','Task54');
insert into public.customers(id,organization_id,name,phone) values('$customer','$org','Synthetic','11999995454');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$channel','$unit','zapi','connected',true,clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation) values('$binding','$unit','$channel','zapi',1);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
insert into public.whatsapp_automation_adoptions(unit_id) values('$unit');
insert into public.reservations(id,unit_id,customer_id) values('$reservation','$unit','$customer');
insert into public.waitlist(id,unit_id,customer_id,customer_name,customer_phone) values('$reservation','$unit','$customer','Synthetic','11999995454');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,waitlist_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
 values('$job','$unit','$org','waitlist_feedback','$reservation','$customer','task54:$reservation',clock_timestamp(),clock_timestamp()+interval '1 hour','$channel','zapi','$binding',1,'text','posting',gen_random_uuid(),clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Synthetic acceptance');
insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,claimed_until,window_until,window_days)
 select unit_id,customer_id,id,claim_token,claimed_until,clock_timestamp()+interval '7 days',7 from public.whatsapp_automation_jobs where id='$job';
select public.finish_whatsapp_automation(id,claim_token,'{"outcome":"accepted","reason":"provider_accepted","provider_message_id":"task54-native"}') from public.whatsapp_automation_jobs where id='$job';
select public.reconcile_whatsapp_automation_acceptance('$job');
commit;
SQL
slot_snapshot=$(psql_task -c "select to_jsonb(s) from public.whatsapp_promotion_slots s where job_id='$job'")
revision=$(psql_task -c "select template_credential_revision from public.whatsapp_channels where id='$channel'")
receipt="select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"task54-native\",\"status\":\"read\",\"provider_timestamp\":null}]');"
# Recorder-first channel SHARE blocks an actual credential rotation.
holder recorder_rotation "$receipt"
waiter recorder_rotation "update public.whatsapp_channels set webhook_secret='synthetic-task54-rotated' where id='$channel';"
join_pair recorder_rotation
check "select count(*)=1 from public.whatsapp_automation_receipt_events where unit_id='$unit'" 'receipt survived rotation after admission'
# Rotation-first original capture is stale after the actual wait.
revision=$(psql_task -c "select template_credential_revision from public.whatsapp_channels where id='$channel'")
holder rotation_recorder "update public.whatsapp_channels set webhook_secret='synthetic-task54-next' where id='$channel';"
waiter rotation_recorder "do \$\$ begin if public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"stale\",\"status\":\"read\",\"provider_timestamp\":null}]')->>'state'<>'authority_changed' then raise exception 'stale admitted';end if;end \$\$;"
join_pair rotation_recorder
check "select not exists(select from public.whatsapp_automation_receipt_events where unit_id='$unit' and provider_message_id='stale')" 'stale body no effects'
# External anchor uses exact nullable equality, independently of the revision.
revision=$(psql_task -c "select template_credential_revision from public.whatsapp_channels where id='$channel'")
holder external_recorder "update public.whatsapp_channels set external_instance_id='synthetic-task54-anchor' where id='$channel';"
waiter external_recorder "do \$\$ begin if public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"anchor\",\"status\":\"read\",\"provider_timestamp\":null}]')->>'state'<>'authority_changed' then raise exception 'external stale admitted';end if;end \$\$;"
join_pair external_recorder
# Actual same-pointer Vault writer, not a direct synthetic revision UPDATE.
psql_task >"$task_tmp/vault-setup" <<SQL
begin;
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,provisioning_claim_id)
 values('$vault_channel','$unit','uazapi','provisioning',false,'$vault_claim');
do \$\$ begin perform public.store_whatsapp_channel_instance_token('$vault_channel','$vault_claim',repeat('x',32),null,'task54-first');end \$\$;
commit;
SQL
vault_revision=$(psql_task -c "select template_credential_revision from public.whatsapp_channels where id='$vault_channel'")
vault_pointer=$(psql_task -c "select instance_token_secret_id from public.whatsapp_channels where id='$vault_channel'")
holder vault_recorder "do \$\$ begin perform public.store_whatsapp_channel_instance_token('$vault_channel','$vault_claim',repeat('y',32),null,'task54-second');end \$\$;"
waiter vault_recorder "do \$\$ begin if public.record_whatsapp_automation_receipts('$vault_channel','$unit','uazapi',$vault_revision,null,'[{\"provider_message_id\":\"stale-vault\",\"status\":\"read\",\"provider_timestamp\":null}]')->>'state'<>'authority_changed' then raise exception 'stale Vault authority admitted';end if;end \$\$;"
join_pair vault_recorder
check "select instance_token_secret_id='$vault_pointer'::uuid and template_credential_revision=$vault_revision+1 and not exists(select from public.whatsapp_automation_receipt_events where channel_id='$vault_channel') from public.whatsapp_channels where id='$vault_channel'" 'same Vault pointer advances authority; stale receipt zero effects'
psql_task -c "update public.whatsapp_channels set external_instance_id=null where id='$channel';select public.reconcile_whatsapp_automation_receipts('$job',20);update public.whatsapp_automation_jobs set finished_at=clock_timestamp()-interval '91 days' where id='$job';" >"$task_tmp/prepare-retention"
revision=$(psql_task -c "select template_credential_revision from public.whatsapp_channels where id='$channel'")
# Recorder and repair never invert customer/job/receipt into a later channel lock.
holder recorder_repair "select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"task54-native\",\"status\":\"sent\",\"provider_timestamp\":null}]');"
psql_task -c "set statement_timeout='3s';do \$\$ begin if public.reconcile_whatsapp_automation_receipts('$job',20)->>'processed'<>'0' then raise exception 'saw uncommitted receipt';end if;end \$\$;" >"$task_tmp/recorder-repair-fast"
join_pair recorder_repair
check "select public.reconcile_whatsapp_automation_receipts('$job',20)->>'processed'='1'" 'receipt becomes repairable after recorder commit'
holder repair_recorder "select public.reconcile_whatsapp_automation_receipts('$job',20);"
psql_task -c "set statement_timeout='3s';select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"task54-native\",\"status\":\"sent\",\"provider_timestamp\":\"2020-01-01T00:00:00Z\"}]');" >"$task_tmp/repair-recorder-fast"
join_pair repair_recorder
check "select public.reconcile_whatsapp_automation_receipts('$job',20)->>'processed'='1'" 'repair holds no later channel admission lock'
receipt="select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"task54-native\",\"status\":\"delivered\",\"provider_timestamp\":null}]');"
# Recorder-first: SKIP LOCKED is observed as fast retention, not a claimed wait.
holder recorder_purge "$receipt"
psql_task -c "select public.purge_whatsapp_automation_workers(0,20);" >"$task_tmp/recorder-purge-fast"
check "select exists(select from public.whatsapp_automation_jobs where id='$job')" 'busy admission parent retained job'
join_pair recorder_purge
psql_task -c "select public.purge_whatsapp_automation_workers(0,20);" >"$task_tmp/recorder-purge-committed"
check "select exists(select from public.whatsapp_automation_jobs where id='$job')" 'fresh child read sees committed pending receipt'
psql_task -c "select public.reconcile_whatsapp_automation_receipts('$job',20);" >"$task_tmp/repair-before-purge"
# Purge-first: deletion holds parent until commit; a legitimate late receipt is kept unmatched.
holder purge_recorder "select public.purge_whatsapp_automation_workers(0,20);"
waiter purge_recorder "select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,'[{\"provider_message_id\":\"task54-native\",\"status\":\"failed\",\"provider_timestamp\":null}]');"
join_pair purge_recorder
check "select not exists(select from public.whatsapp_automation_jobs where id='$job') and exists(select from public.whatsapp_automation_receipt_events where unit_id='$unit' and status='failed' and processing_state='pending') and exists(select from public.notifications_sent where unit_id='$unit')" 'late unmatched retained; legacy notification survives'
[[ $(psql_task -c "select to_jsonb(s) from public.whatsapp_promotion_slots s where job_id='$job'") == "$slot_snapshot" ]] || exit 1
echo 'GREEN54 captured promotion slot unchanged through receipt repair and purge'
# Positive old unmatched receipt + terminal job make isolation refusal meaningful.
job=$(psql_task -c 'select gen_random_uuid()')
psql_task >"$task_tmp/isolation-fixture" <<SQL
begin;
insert into public.whatsapp_automation_receipt_events(unit_id,provider,channel_id,provider_message_id,status,provider_timestamp,digest,received_at)
 values('$unit','zapi','$channel','old-unmatched','sent',null,repeat('a',64),clock_timestamp()-interval '91 days');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,finished_at)
 values('$job','$unit','$org','confirmation','$reservation','$customer','task54:expired',clock_timestamp()-interval '100 days',clock_timestamp()-interval '99 days','$channel','zapi','$binding',1,'text','expired',clock_timestamp()-interval '91 days');
commit;
SQL
before=$(psql_task -c "select jsonb_build_array((select jsonb_agg(to_jsonb(j) order by id) from public.whatsapp_automation_jobs j where unit_id='$unit'),(select jsonb_agg(to_jsonb(r) order by id) from public.whatsapp_automation_receipt_events r where unit_id='$unit'),(select jsonb_agg(to_jsonb(n) order by id) from public.notifications_sent n where unit_id='$unit'),(select to_jsonb(c) from public.customers c where id='$customer'),(select jsonb_agg(to_jsonb(s) order by id) from public.whatsapp_promotion_slots s where unit_id='$unit'))")
for isolation in 'repeatable read' 'serializable' 'read uncommitted'; do
 psql_task >"$task_tmp/isolation-${isolation// /-}" <<SQL
begin isolation level $isolation;
do \$\$ declare caught text; msg text; begin
 begin perform public.purge_whatsapp_automation_workers(500,20);exception when others then get stacked diagnostics caught=returned_sqlstate,msg=message_text;end;
 if caught is distinct from '0A000' or msg is distinct from 'automation_purge_isolation_unsupported' then raise exception 'isolation refusal mismatch';end if;
 if current_setting('transaction_isolation')<>'$isolation' then raise exception 'isolation changed';end if;
end \$\$;
commit;
SQL
 after=$(psql_task -c "select jsonb_build_array((select jsonb_agg(to_jsonb(j) order by id) from public.whatsapp_automation_jobs j where unit_id='$unit'),(select jsonb_agg(to_jsonb(r) order by id) from public.whatsapp_automation_receipt_events r where unit_id='$unit'),(select jsonb_agg(to_jsonb(n) order by id) from public.notifications_sent n where unit_id='$unit'),(select to_jsonb(c) from public.customers c where id='$customer'),(select jsonb_agg(to_jsonb(s) order by id) from public.whatsapp_promotion_slots s where unit_id='$unit'))")
 [[ $before == "$after" ]] || exit 1;echo "GREEN54 $isolation exact refusal and zero effects"
done
psql_task -c "select public.purge_whatsapp_automation_workers(500,20);" >"$task_tmp/read-committed-positive"
check "select not exists(select from public.whatsapp_automation_jobs where id='$job') and not exists(select from public.whatsapp_automation_receipt_events where unit_id='$unit' and provider_message_id='old-unmatched')" 'READ COMMITTED deletes eligible positive controls'

# Two concurrent allocators: the first holds selected rows; the second SKIPs
# those locks and can only pace the other five. No unreturned row is reserved.
psql_task >"$task_tmp/selector-setup" <<SQL
begin;
do \$\$ declare r uuid; i integer; begin for i in 1..10 loop
 r:=gen_random_uuid();insert into public.reservations(id,unit_id,customer_id) values(r,'$unit','$customer');
 insert into public.whatsapp_automation_jobs(unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,due_at)
 values('$unit','$org','confirmation',r,'$customer','selector54:'||r,clock_timestamp(),clock_timestamp()+interval '1 hour','$channel','zapi','$binding',1,'text','blocked',clock_timestamp()-interval '1 minute');
end loop;end \$\$;commit;
SQL
holder selectors "do \$\$ declare result jsonb;begin result:=public.maintain_and_select_whatsapp_automation_work(20);if jsonb_array_length(result->'rechecks')<>5 then raise exception 'first allocator did not choose five';end if;end \$\$;"
psql_task >"$task_tmp/selectors-fast" <<SQL
begin;set local statement_timeout='3s';
do \$\$ declare result jsonb;begin result:=public.maintain_and_select_whatsapp_automation_work(20);
 if jsonb_array_length(result->'rechecks')<>5 or jsonb_array_length(result->'normal')<>0 then raise exception 'second allocator did not SKIP locked five';end if;
end \$\$;commit;
SQL
join_pair selectors
check "select count(*)=10 and bool_and(next_eligibility_check_at>clock_timestamp()+interval '4 minutes') from public.whatsapp_automation_jobs where unit_id='$unit' and source_event_key like 'selector54:%'" 'concurrent disjoint selection paces exactly ten'
check "select jsonb_array_length(public.maintain_and_select_whatsapp_automation_work(20)->'rechecks')=0" 'subsequent allocation cannot bypass five-minute pacing'

# Live claimed work survives maintenance; a real blocker waits for the job and
# observes an original TTL that expires during the wait, while its lease is live.
for phase in block lease; do
 clock_job=$(psql_task -c 'select gen_random_uuid()');clock_res=$(psql_task -c 'select gen_random_uuid()');clock_fence=$(psql_task -c 'select gen_random_uuid()')
 psql_task >"$task_tmp/clock-$phase-setup" <<SQL
begin;
insert into public.reservations(id,unit_id,customer_id) values('$clock_res','$unit','$customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until)
 values('$clock_job','$unit','$org','confirmation','$clock_res','$customer','clock54:$phase',clock_timestamp(),clock_timestamp()+interval '5 seconds','$channel','zapi','$binding',1,'text','claimed','$clock_fence',clock_timestamp()+interval '30 seconds');
commit;
SQL
 if [[ $phase == block ]]; then
  holder block_clock "select id from public.whatsapp_automation_jobs where id='$clock_job' for update;"
  waiter block_clock "do \$\$ begin if not public.block_whatsapp_automation_preflight('$clock_job','$clock_fence','reservation_pending') then raise exception 'live fence refused';end if;
   if not exists(select from public.whatsapp_automation_jobs where id='$clock_job' and state='expired' and finished_at>expires_at and finished_at>transaction_timestamp()+interval '3 seconds' and claim_token is null and claimed_until is null) then raise exception 'block used pre-wait clock';end if;end \$\$;"
  join_pair block_clock
 else
  holder live_claim "select id from public.whatsapp_automation_jobs where id='$clock_job' for update;"
  psql_task -c "set statement_timeout='3s';select public.maintain_and_select_whatsapp_automation_work(0);" >"$task_tmp/live-claim-maintenance"
  join_pair live_claim
  psql_task -c "select public.maintain_and_select_whatsapp_automation_work(0);" >"$task_tmp/live-claim-after-wait"
  check "select state='claimed' and finished_at is null and claim_token='$clock_fence'::uuid from public.whatsapp_automation_jobs where id='$clock_job'" 'expired TTL does not expire live claimed ownership'
 fi
done

# The new expiry SET in the current seven-argument authority body is measured
# through its real prepare wrapper. Temporary local flag state is restored
# exactly (absence, SQL NULL and JSON null remain distinct), including on failure.
flag_restore=$(psql_task -c "select case when exists(select from public.platform_flags where key='whatsapp_automation_dispatch') then (select 'insert into public.platform_flags(key,value) values(''whatsapp_automation_dispatch'','||quote_nullable(value::text)||'::jsonb) on conflict(key) do update set value=excluded.value;' from public.platform_flags where key='whatsapp_automation_dispatch') else 'delete from public.platform_flags where key=''whatsapp_automation_dispatch'';' end")
for key in prep_unit prep_channel prep_binding; do value=$(psql_task -c 'select gen_random_uuid()');printf -v "$key" '%s' "$value";done
psql_task >"$task_tmp/prepare-clock-authority" <<SQL
begin;
insert into public.units(id,organization_id,name) values('$prep_unit','$org','Task54 prepare clock');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$prep_channel','$prep_unit','zapi','connected',true,clock_timestamp());
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,generation,dispatch_enabled,adopted_at) values('$prep_binding','$prep_unit','$prep_channel','zapi',1,true,clock_timestamp());
insert into public.whatsapp_automation_adoptions(unit_id) values('$prep_unit') on conflict do nothing;
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
commit;
SQL
for phase in prepare confirm; do
 prep_job=$(psql_task -c 'select gen_random_uuid()');prep_res=$(psql_task -c 'select gen_random_uuid()');prep_fence=$(psql_task -c 'select gen_random_uuid()')
 psql_task >"$task_tmp/$phase-clock-setup" <<SQL
begin;
insert into public.reservations(id,unit_id,customer_id) values('$prep_res','$prep_unit','$customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,safe_log_body,initial_catalog_key,initial_credential_revision)
 values('$prep_job','$prep_unit','$org','confirmation','$prep_res','$customer','prepare54:$phase',clock_timestamp(),clock_timestamp()+interval '5 seconds','$prep_channel','zapi','$prep_binding',1,'text','claimed','$prep_fence',clock_timestamp()+interval '90 seconds','Synthetic frozen text','res_confirmacao_v1',0);
commit;
SQL
 if [[ $phase == prepare ]]; then
  holder prepare_clock "select id from public.customers where id='$customer' for update;"
  waiter prepare_clock "do \$\$ begin if public.prepare_whatsapp_automation_post('$prep_job','$prep_fence',1,null,null) then raise exception 'expired prepare posted';end if;
   if not exists(select from public.whatsapp_automation_jobs where id='$prep_job' and state='expired' and finished_at>expires_at and finished_at>transaction_timestamp()+interval '3 seconds' and posting_started_at is null and attempts=0) then raise exception 'prepare expiry used pre-wait time';end if;end \$\$;"
  psql_task -c "set statement_timeout='3s';select public.maintain_and_select_whatsapp_automation_work(0);" >"$task_tmp/expiry-while-prepare-waits"
  join_pair prepare_clock
 else
  check "select public.prepare_whatsapp_automation_post('$prep_job','$prep_fence',1,null,null)" 'positive prepare before TTL proves authority fixture'
  prepared_snapshot=$(psql_task -c "select to_jsonb(j) from public.whatsapp_automation_jobs j where id='$prep_job'")
  holder confirm_clock "select id from public.customers where id='$customer' for update;"
  waiter confirm_clock "do \$\$ begin if public.confirm_whatsapp_automation_post('$prep_job','$prep_fence',1,null,null) then raise exception 'expired confirm allowed';end if;end \$\$;"
  join_pair confirm_clock
  [[ $(psql_task -c "select to_jsonb(j) from public.whatsapp_automation_jobs j where id='$prep_job'") == "$prepared_snapshot" ]] || exit 1
  echo 'GREEN54 final confirm after actual TTL wait remains entirely read-only'
 fi
done
psql_task -c "$flag_restore" >"$task_tmp/flag-restored-before-erasure"
flag_restore=''

# Erasure competes at the acceptance writer's actual customer lock. Its child
# scrub must stay final; technical delivery reconciliation cannot recreate PII.
for phase in repair_first erase_first; do
 erase_customer=$(psql_task -c 'select gen_random_uuid()');erase_res=$(psql_task -c 'select gen_random_uuid()');erase_job=$(psql_task -c 'select gen_random_uuid()')
 psql_task >"$task_tmp/erasure-$phase-setup" <<SQL
begin;
insert into public.customers(id,organization_id,name,phone) values('$erase_customer','$org','Synthetic',case when '$phase'='repair_first' then '11999995451' else '11999995452' end);
insert into public.reservations(id,unit_id,customer_id) values('$erase_res','$unit','$erase_customer');
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,reservation_id,customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body)
 values('$erase_job','$unit','$org','confirmation','$erase_res','$erase_customer','erase54:$phase',clock_timestamp(),clock_timestamp()+interval '1 hour','$channel','zapi','$binding',1,'text','posting',gen_random_uuid(),clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Synthetic privacy body');
select public.finish_whatsapp_automation(id,claim_token,jsonb_build_object('outcome','accepted','reason','provider_accepted','provider_message_id','erase54:$phase')) from public.whatsapp_automation_jobs where id='$erase_job';
select public.record_whatsapp_automation_receipts('$channel','$unit','zapi',$revision,null,jsonb_build_array(jsonb_build_object('provider_message_id','erase54:$phase','status','read','provider_timestamp',null)));
commit;
SQL
 if [[ $phase == repair_first ]]; then
  holder repair_erasure "select public.reconcile_whatsapp_automation_receipts('$erase_job',20);"
  waiter repair_erasure "update public.customers set deleted_at=clock_timestamp() where id='$erase_customer';"
  join_pair repair_erasure
 else
  holder erasure_repair "update public.customers set deleted_at=clock_timestamp() where id='$erase_customer';"
  waiter erasure_repair "select public.reconcile_whatsapp_automation_receipts('$erase_job',20);"
  join_pair erasure_repair
 fi
 check "select customer_id is null and customer_erased_at is not null and safe_log_body is null and state='reconciled' and exists(select from public.notifications_sent where id=j.notification_id and read_at is not null) from public.whatsapp_automation_jobs j where id='$erase_job'" "$phase preserves scrub and original technical acceptance"
done

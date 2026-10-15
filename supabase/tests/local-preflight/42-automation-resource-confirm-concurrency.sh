#!/usr/bin/env bash
# Real observed independent sessions. Authoring/syntax is NOT execution evidence.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ $# == 0 && -z ${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-} ]] || exit 1
task_docker=$(node "$(dirname "$0")/local-runtime-paths.mjs" --docker)
task_container=supabase_db_moralles-templates-20261003
[[ -z ${TASK_DOCKER:-} || $TASK_DOCKER == "$task_docker" ]] || exit 1
[[ -z ${TASK_DB_CONTAINER:-} || $TASK_DB_CONTAINER == "$task_container" ]] || exit 1
[[ $("$task_docker" context inspect --format '{{ .Endpoints.docker.Host }}') == npipe:////./pipe/* ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .State.Running }}' "$task_container") == true ]] || exit 1
[[ $("$task_docker" inspect --format '{{ .Name }}' "$task_container") == /$task_container ]] || exit 1
[[ $("$task_docker" inspect --format '{{ index .Config.Labels "com.supabase.cli.project" }}' "$task_container") == moralles-templates-20261003 ]] || exit 1
[[ $("$task_docker" inspect --format '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$task_container") == 55452 ]] || exit 1
psql_task() { "$task_docker" exec -i "$task_container" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_root=$(cd "$(dirname "$0")/../../.." && pwd)
task_tmp=$(mktemp -d "$task_root/.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime/resource42.XXXXXX")
for key in o u c ch a b t r actor rule cost j f; do
  value=$(psql_task -c 'select gen_random_uuid()'); [[ $value =~ ^[0-9a-f-]{36}$ ]] || exit 1; printf -v "$key" '%s' "$value"
done
# The inherited local fixture has exactly key/value. Refuse a surprise richer
# flags schema instead of restoring only part of a row while claiming fidelity.
[[ $(psql_task -c "select array_agg(attname::text order by attname) = array['key','value'] from pg_attribute where attrelid='public.platform_flags'::regclass and attnum>0 and not attisdropped") == t ]] || exit 1
flag_before=$(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'")
holder_pid='' waiter_pid=''
clean_fixture() {
  # Cost evidence may only be deleted by the now-absent account's FK cascade.
  psql_task -c "update public.customers set deleted_at=clock_timestamp() where id='$c' and deleted_at is null; delete from public.whatsapp_promotion_slots where unit_id='$u'; delete from public.whatsapp_automation_jobs where unit_id='$u'; delete from public.whatsapp_template_jobs where account_id='$a'; delete from public.whatsapp_remote_templates where account_id='$a'; delete from public.whatsapp_template_bindings where id='$b'; delete from public.whatsapp_template_accounts where id='$a'; delete from public.organizations where id='$o'; delete from auth.users where id='$actor';" >/dev/null
}
cleanup() {
  local original_exit=$?
  # Do not clean beneath live sessions: both native exits must be collected.
  if [[ -n $holder_pid ]]; then wait "$holder_pid" || original_exit=1; fi
  if [[ -n $waiter_pid ]]; then wait "$waiter_pid" || original_exit=1; fi
  clean_fixture || original_exit=1
  psql_task -v resource42_original_flag="$flag_before" >"$task_tmp/flag-restored" <<'SQL' || original_exit=1
begin;
set local standard_conforming_strings=on;
delete from public.platform_flags where key='whatsapp_automation_dispatch';
insert into public.platform_flags(key,value)
select row_data->>'key',case when (row_data->>'value_is_sql_null')::boolean then null::jsonb else row_data->'value' end
from jsonb_array_elements(:'resource42_original_flag'::jsonb) as snapshot(row_data);
commit;
SQL
  [[ $(psql_task -c "select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'value_is_sql_null',value is null)),'[]') from public.platform_flags where key='whatsapp_automation_dispatch'") == "$flag_before" ]] || original_exit=1
  echo "Task42 cleanup native exit $original_exit; original flag absence/exact JSON checked"
  exit "$original_exit"
}
trap cleanup EXIT
observe() {
  local label=$1 predicate=$2
  for _ in {1..100}; do
    observed=$(psql_task -c "select jsonb_build_object('application',application_name,'pid',pid,'wait_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid)) from pg_stat_activity where application_name='$label' and $predicate")
    if [[ -n $observed ]]; then printf '%s\n' "$observed" >"$task_tmp/$label-observed"; return; fi
  done
  echo "FAIL42 actual wait not observed $label"; exit 1
}
setup() {
  local mode=$1
  clean_fixture
  local provider=zapi transport=text kind=confirmation category=UTILITY logical=res_confirmacao_v1
  if [[ $mode == freshness || $mode == cost ]]; then provider=datafy; transport=template; fi
  if [[ $mode == cost ]]; then kind=voucher_issued; category=MARKETING; logical=mkt_voucher_programado_v1; fi
  psql_task <<SQL >"$task_tmp/$mode-setup"
begin;
insert into auth.users(id) values('$actor'); insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$o','Task42');
insert into public.units(id,organization_id,name,slug,timezone) values('$u','$o','Task42','task42-$u','America/Sao_Paulo');
insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at) values('$c','$o','Synthetic','55912345678',false,null);
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$ch','$u','$provider','connected',true,clock_timestamp());
$(if [[ $transport == template ]]; then printf "insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('%s','%s','4242424242',clock_timestamp());" "$a" "$o"; fi)
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,provider,account_id,verified_at,adopted_at,dispatch_enabled)
 values('$b','$u','$ch','$provider',$(if [[ $transport == template ]]; then printf "'%s'" "$a"; else printf null; fi),clock_timestamp(),clock_timestamp(),true);
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
$(if [[ $transport == template ]]; then cat <<TEMPLATE
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('$t','$a','$logical',1,'pt_BR','$logical',repeat('a',64),'$category',1);
select public.publish_whatsapp_template_sync('$a',1,public.begin_whatsapp_template_sync('$a'),jsonb_build_array(jsonb_build_object('id','$t','remote_id','task42','name','$logical','language','pt_BR','observed_hash',repeat('a',64),'effective_category','$category','remote_status','APPROVED','quality','GREEN')));
TEMPLATE
fi)
$(if [[ $kind == voucher_issued ]]; then cat <<BENEFIT
insert into public.voucher_rules(id,unit_id,name,trigger_type,discount_percent,validity_days,min_rating,visits_required,days_window,active,created_at,updated_at) values('$rule','$u','Task42','birthday',15,30,null,null,null,true,clock_timestamp(),clock_timestamp());
insert into public.vouchers(id,unit_id,customer_id,rule_id,code,discount_percent,status,issued_at,created_at,expires_at) values('$r','$u','$c','$rule','TASK42-$r',15,'active',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '30 days');
insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values('$u','$c','promotional','opt_in','fixture','task42',clock_timestamp());
-- Immutable evidence starts short-lived; no later UPDATE bypasses its guard.
insert into public.whatsapp_template_cost_authorizations(id,account_id,binding_id,binding_generation,category,valid_from,valid_until,actor_id) values('$cost','$a','$b',1,'MARKETING',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '10 seconds','$actor');
BENEFIT
else cat <<RESERVATION
insert into public.reservations(id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,satisfaction_rating,applied_discount_percent) values('$r','$u','$c',(clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'23:59','confirmed',null,'web',4,'TASK42-$r',null,null);
RESERVATION
fi)
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.whatsapp_automation_jobs(id,unit_id,organization_id,kind,$(if [[ $kind == voucher_issued ]]; then printf voucher_id; else printf reservation_id; fi),customer_id,source_event_key,fact_at,expires_at,channel_id,provider,binding_id,binding_generation,transport,account_id,remote_template_id,template_version,sync_epoch,state,claim_token,claimed_until,posting_started_at,attempts,safe_log_body,consent_revision,cost_authorization_id)
 values('$j','$u','$o','$kind','$r','$c','task42',$(if [[ $mode == ttl ]]; then printf "clock_timestamp()+interval '6 seconds'"; else printf 'clock_timestamp()'; fi),$(if [[ $mode == ttl ]]; then printf "clock_timestamp()+interval '6 seconds'"; else printf "clock_timestamp()+interval '7 days'"; fi),'$ch','$provider','$b',1,'$transport',$(if [[ $transport == template ]]; then printf "'%s','%s',1,(select sync_epoch from public.whatsapp_remote_templates where id='%s')" "$a" "$t" "$t"; else printf 'null,null,null,null'; fi),'posting','$f',clock_timestamp()+interval '90 seconds',clock_timestamp(),1,'Task42 frozen redacted',$(if [[ $kind == voucher_issued ]]; then printf "(select max(revision) from public.whatsapp_message_consent_events where unit_id='%s' and customer_id='%s' and purpose='promotional'),'%s'" "$u" "$c" "$cost"; else printf 'null,null'; fi));
$(if [[ $kind == voucher_issued ]]; then printf "insert into public.whatsapp_promotion_slots(unit_id,customer_id,job_id,claim_token,state,claimed_until,window_until,window_days) select unit_id,customer_id,id,claim_token,'reserved',claimed_until,posting_started_at+interval '7 days',7 from public.whatsapp_automation_jobs where id='%s';" "$j"; fi)
commit;
SQL
  e=$(psql_task -c "select coalesce(sync_epoch::text,'null') from public.whatsapp_automation_jobs where id='$j'")
  rev=$(psql_task -c "select coalesce(consent_revision::text,'null') from public.whatsapp_automation_jobs where id='$j'")
  expected=$(psql_task -c "select jsonb_build_object('version',1,'kind',j.kind,'unit',jsonb_build_object('id',u.id,'organization_id',u.organization_id,'name',u.name,'slug',u.slug,'timezone',u.timezone),'customer',jsonb_build_object('id',c.id,'organization_id',c.organization_id,'name',c.name,'phone',c.phone,'do_not_contact',c.do_not_contact,'deleted_at',c.deleted_at),'rule',case when j.voucher_id is not null then jsonb_build_object('id',vr.id,'unit_id',vr.unit_id,'trigger_type',vr.trigger_type) else 'null'::jsonb end,'setting',jsonb_build_object('key',case when j.kind='voucher_issued' then 'giftback_whatsapp_enabled' else null end,'present',false,'value',null),'resource',case when j.voucher_id is not null then jsonb_build_object('id',v.id,'unit_id',v.unit_id,'customer_id',v.customer_id,'rule_id',v.rule_id,'code',v.code,'discount_percent',v.discount_percent,'status',v.status,'issued_at',v.issued_at,'created_at',v.created_at,'expires_at',v.expires_at) else jsonb_build_object('id',r.id,'unit_id',r.unit_id,'customer_id',r.customer_id,'date',r.date,'time',r.time,'status',r.status,'payment_status',r.payment_status,'source',r.source,'party_size',r.party_size,'reservation_code',r.reservation_code,'applied_discount_percent',r.applied_discount_percent,'satisfaction_rating',r.satisfaction_rating) end) from public.whatsapp_automation_jobs j join public.units u on u.id=j.unit_id join public.customers c on c.id=j.customer_id left join public.reservations r on r.id=j.reservation_id left join public.vouchers v on v.id=j.voucher_id left join public.voucher_rules vr on vr.id=v.rule_id where j.id='$j'")
  # Preserve the captured JSON exactly while quoting it as a SQL string literal.
  expected_literal=${expected//\'/\'\'}
  confirm="public.confirm_whatsapp_automation_resource_post('$j','$f',1,$rev,$e,'$expected_literal'::jsonb)"
  [[ $(psql_task -c "select $confirm = '{\"allowed\":true}'::jsonb") == t ]] || { echo "FAIL42 baseline $mode (deadline may have elapsed before wait)"; exit 1; }
}
race() {
  local label=$1 holder=$2 reason=$3 before_job=${4:-false}
  before=$(psql_task -c "select to_jsonb(j) from public.whatsapp_automation_jobs j where id='$j'")
  psql_task <<SQL >"$task_tmp/$label-holder" 2>&1 &
begin; set local statement_timeout='25s'; set application_name='resource42_holder';
$holder;
select pg_sleep(12); commit;
SQL
  holder_pid=$!; observe resource42_holder "wait_event='PgSleep'"
  psql_task <<SQL >"$task_tmp/$label-waiter" 2>&1 &
set statement_timeout='25s'; set application_name='resource42_waiter';
do \$\$ begin if $confirm is distinct from '{"allowed":false,"reason":"$reason"}'::jsonb then raise exception 'FAIL42 $label allowed/wrong refusal'; end if; end \$\$;
SQL
  waiter_pid=$!; observe resource42_waiter "wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0"
  if [[ $label == parent_cost ]]; then
    [[ $(psql_task -c "select ca.valid_until>clock_timestamp() and ca.valid_until<=clock_timestamp()+interval '12 seconds' and j.claimed_until>clock_timestamp()+interval '12 seconds' and j.expires_at>clock_timestamp()+interval '12 seconds' and t.last_synced_at>clock_timestamp()-interval '40 seconds' and a.last_sync_published_at>clock_timestamp()-interval '40 seconds' from public.whatsapp_template_cost_authorizations ca join public.whatsapp_automation_jobs j on j.cost_authorization_id=ca.id join public.whatsapp_remote_templates t on t.id=j.remote_template_id join public.whatsapp_template_accounts a on a.id=j.account_id where ca.id='$cost' and j.id='$j'") == t ]] || { echo 'FAIL42 cost must be live during observed wait with lease/TTL/GET margin'; exit 1; }
  elif [[ $label == relation_freshness ]]; then
    [[ $(psql_task -c "select t.last_synced_at>=clock_timestamp()-interval '60 seconds' and a.last_sync_published_at>=clock_timestamp()-interval '60 seconds' from public.whatsapp_remote_templates t join public.whatsapp_template_accounts a on a.id=t.account_id where t.id='$t'") == t ]] || { echo 'FAIL42 GET must still be fresh during observed wait'; exit 1; }
  fi
  if [[ $before_job == true ]]; then psql_task -c "begin; select id from public.whatsapp_automation_jobs where id='$j' for update nowait; rollback;" >"$task_tmp/$label-job-nowait"; fi
  local holder_exit=0 waiter_exit=0
  wait "$holder_pid" || holder_exit=$?; holder_pid=''
  wait "$waiter_pid" || waiter_exit=$?; waiter_pid=''
  [[ $holder_exit == 0 && $waiter_exit == 0 ]] || { echo "FAIL42 native exits $holder_exit/$waiter_exit"; exit 1; }
  if [[ $label == parent_cost ]]; then
    [[ $(psql_task -c "select ca.valid_until<=clock_timestamp() and j.claimed_until>clock_timestamp() and j.expires_at>clock_timestamp() and t.last_synced_at>=clock_timestamp()-interval '60 seconds' and a.last_sync_published_at>=clock_timestamp()-interval '60 seconds' from public.whatsapp_template_cost_authorizations ca join public.whatsapp_automation_jobs j on j.cost_authorization_id=ca.id join public.whatsapp_remote_templates t on t.id=j.remote_template_id join public.whatsapp_template_accounts a on a.id=j.account_id where ca.id='$cost' and j.id='$j'") == t ]] || { echo 'FAIL42 cost expiry must be isolated from live lease/TTL/GET'; exit 1; }
  elif [[ $label == relation_freshness ]]; then
    [[ $(psql_task -c "select t.last_synced_at<clock_timestamp()-interval '60 seconds' and a.last_sync_published_at<clock_timestamp()-interval '60 seconds' and j.claimed_until>clock_timestamp() and j.expires_at>clock_timestamp() from public.whatsapp_remote_templates t join public.whatsapp_template_accounts a on a.id=t.account_id join public.whatsapp_automation_jobs j on j.remote_template_id=t.id where t.id='$t' and j.id='$j'") == t ]] || { echo 'FAIL42 GET expiry must be isolated from live lease/TTL'; exit 1; }
  fi
  [[ $(psql_task -c "select to_jsonb(j) from public.whatsapp_automation_jobs j where id='$j'") == "$before" ]] || { echo 'FAIL42 confirm mutated job'; exit 1; }
  echo "GREEN42 $label; observed real lock wait, exits0/0, final false readonly"
}
setup lease
psql_task -c "update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()+interval '6 seconds' where id='$j'" >"$task_tmp/lease-tightened"
race parent_lease "select id from public.customers where id='$c' for update" authority_changed true
setup ttl
race relation_ttl 'lock table public.reservations in access exclusive mode' authority_changed
setup cost
race parent_cost "select id from public.whatsapp_template_cost_authorizations where id='$cost' for update" authority_changed true
setup freshness
psql_task -c "update public.whatsapp_remote_templates set last_synced_at=clock_timestamp()-interval '54 seconds' where id='$t'; update public.whatsapp_template_accounts set last_sync_published_at=clock_timestamp()-interval '54 seconds' where id='$a'" >"$task_tmp/freshness-tightened"
[[ $(psql_task -c "select $confirm = '{\"allowed\":true}'::jsonb") == t ]] || { echo 'FAIL42 tightened GET baseline must still be live'; exit 1; }
race relation_freshness 'lock table public.units in access exclusive mode' authority_changed
setup snapshot
race parent_then_current_read "select id from public.customers where id='$c' for update; update public.reservations set source='whatsapp' where id='$r'" resource_changed true
echo 'Task42 five observed waits; no provider POST, no claim/fence renewal, no snapshot row locks.'

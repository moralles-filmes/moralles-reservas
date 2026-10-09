#!/usr/bin/env bash
# Real independent sessions. No provider calls; only this disposable project.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ "${TASK_DB_CONTAINER:-}" == 'supabase_db_moralles-templates-20261003' ]] || { echo 'wrong disposable DB'; exit 1; }
[[ $("$TASK_DOCKER" inspect --format '{{ index .Config.Labels "com.supabase.cli.project" }}' "$TASK_DB_CONTAINER") == 'moralles-templates-20261003' ]] || exit 1
[[ $("$TASK_DOCKER" inspect --format '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$TASK_DB_CONTAINER") == 55452 ]] || exit 1
psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_tmp=$(mktemp -d)
o=36363636-0000-0000-0000-000000000001
u=36363636-0000-0000-0000-000000000002
c=36363636-0000-0000-0000-000000000003
ch=36363636-0000-0000-0000-000000000004
a=36363636-0000-0000-0000-000000000005
b=36363636-0000-0000-0000-000000000006
t=36363636-0000-0000-0000-000000000007
r=36363636-0000-0000-0000-000000000008
actor=36363636-0000-0000-0000-000000000009
[[ $(psql_task -c "select attnotnull from pg_attribute where attrelid='public.platform_flags'::regclass and attname='value' and not attisdropped") == t ]] || { echo 'platform_flags.value NOT NULL invariant missing'; exit 1; }
old_flag_exists=$(psql_task -c "select exists(select from public.platform_flags where key='whatsapp_automation_dispatch')")
old_flag_literal=$(psql_task -c "select quote_literal(value::text) from public.platform_flags where key='whatsapp_automation_dispatch'")
task_pids=()
clean_fixture() {
  psql_task -c "delete from public.whatsapp_automation_jobs where unit_id='$u'; delete from public.whatsapp_template_jobs where account_id='$a'; delete from public.whatsapp_template_bindings where id='$b'; delete from public.whatsapp_template_accounts where id='$a'; delete from public.organizations where id='$o'; delete from auth.users where id='$actor';" >/dev/null
}
cleanup() {
  local original_status=$? cleanup_status=0
  trap - EXIT
  # Drain only processes started here BEFORE deleting their FK parents, including
  # assertion/observation failures. Native timeouts remain failures, never proof.
  for pid in "${task_pids[@]}"; do wait "$pid" || cleanup_status=1; done
  clean_fixture || cleanup_status=1
  if [[ "$old_flag_exists" == t ]]; then
    psql_task -c "insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch',$old_flag_literal::jsonb) on conflict(key) do update set value=excluded.value" >/dev/null || cleanup_status=1
  else
    psql_task -c "delete from public.platform_flags where key='whatsapp_automation_dispatch'" >/dev/null || cleanup_status=1
  fi
  rm -f "$task_tmp/a" "$task_tmp/b" || cleanup_status=1
  rmdir "$task_tmp" || cleanup_status=1
  if [[ "$original_status" != 0 ]]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
setup() {
  clean_fixture
  psql_task <<SQL >/dev/null
begin;
insert into auth.users(id) values('$actor'); insert into public.platform_admins values('$actor');
insert into public.organizations(id,name) values('$o','Task36 isolated');
insert into public.units(id,organization_id,name) values('$u','$o','Task36');
insert into public.customers(id,organization_id,name,phone) values('$c','$o','Synthetic','11999993636');
insert into public.reservations(id,unit_id,customer_id) values('$r','$u','$c');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at) values('$ch','$u','datafy','connected',true,clock_timestamp());
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at) values('$a','$o','3636363636',clock_timestamp());
insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('$b','$u','$ch','$a','datafy',clock_timestamp());
select set_config('request.jwt.claims','{"role":"authenticated","sub":"$actor"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where id='$b';
insert into public.platform_flags(key,value) values('whatsapp_automation_dispatch','true') on conflict(key) do update set value=excluded.value;
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation) values('$t','$a','res_lembrete_dia_v1',1,'pt_BR','res_lembrete_dia_v1',repeat('a',64),'UTILITY',1);
select public.publish_whatsapp_template_sync('$a',1,public.begin_whatsapp_template_sync('$a'),jsonb_build_array(jsonb_build_object('id','$t','remote_id','task36','name','res_lembrete_dia_v1','language','pt_BR','observed_hash',repeat('a',64),'effective_category','UTILITY','remote_status','APPROVED','quality','GREEN')));
select public.enqueue_whatsapp_automation(jsonb_build_object('unit_id','$u','kind','reminder_d1','reservation_id','$r','source_event_key','task36','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour'));
commit;
SQL
  j=$(psql_task -c "select id from public.whatsapp_automation_jobs where unit_id='$u'")
  f=$(psql_task -c "select public.claim_whatsapp_automation('$j')->>'claim_token'")
  e=$(psql_task -c "select sync_epoch from public.whatsapp_remote_templates where id='$t'")
  psql_task -c "update public.whatsapp_automation_jobs set safe_log_body='Task36 synthetic render' where id='$j'" >/dev/null
  prepare="public.prepare_whatsapp_automation_post('$j','$f',1,null,$e)"
  confirm="public.confirm_whatsapp_automation_post('$j','$f',1,null,$e)"
}
observe() {
  for _ in {1..100}; do
    if [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='$1' and $2)") == t ]]; then return; fi
  done
  echo "FAIL: actual session state not observed: $1"; exit 1
}
race() {
  local label=$1 holder=$2 waiter=$3
  psql_task <<SQL >"$task_tmp/a" &
begin;
set statement_timeout='12s';
set application_name='task36_holder';
$holder;
select pg_sleep(4);
commit;
SQL
  local pid_a=$!
  task_pids+=("$pid_a")
  observe task36_holder "query like 'select pg_sleep%'"
  psql_task <<SQL >"$task_tmp/b" &
set application_name='task36_waiter';
set statement_timeout='10s';
do \$\$ begin $waiter; end \$\$;
SQL
  local pid_b=$!
  task_pids+=("$pid_b")
  observe task36_waiter "wait_event_type='Lock'"
  wait "$pid_a" || { cat "$task_tmp/a"; exit 1; }
  wait "$pid_b" || { cat "$task_tmp/b"; exit 1; }
  task_pids=()
  echo "GREEN: $label (holder and actual lock waiter observed; both sessions exit0)"
}
setup
race 'double prepare has exactly one winner' "select $prepare" "if $prepare then raise exception 'second prepare allowed'; end if; if (select attempts<>1 or state<>'posting' from public.whatsapp_automation_jobs where id='$j') then raise exception 'double prepare effects'; end if"
setup
race 'prepare waits for credential rotation and refuses' "update public.whatsapp_channels set credentials='{\"fixture_revision\":1}' where id='$ch'" "if $prepare then raise exception 'stale prepare allowed'; end if; if (select attempts<>0 from public.whatsapp_automation_jobs where id='$j') then raise exception 'refusal consumed attempt'; end if"
for scenario in lease rotation optout erasure sync; do
  setup
  [[ $(psql_task -c "select $prepare") == t ]] || { echo 'positive prepare failed'; exit 1; }
  [[ $(psql_task -c "select $confirm") == t ]] || { echo 'positive confirm failed'; exit 1; }
  case "$scenario" in
    lease)
      psql_task -c "update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()+interval '2 seconds' where id='$j'" >/dev/null
      holder="select id from public.customers where id='$c' for update";;
    rotation) holder="update public.whatsapp_channels set credentials='{\"fixture_revision\":2}' where id='$ch'";;
    optout) holder="insert into public.whatsapp_message_consent_events(unit_id,customer_id,purpose,decision,source_code,evidence_reference,observed_at) values('$u','$c','operational','opt_out','fixture','task36',clock_timestamp())";;
    erasure) holder="update public.customers set deleted_at=clock_timestamp() where id='$c'";;
    sync) holder="select public.begin_whatsapp_template_sync('$a')";;
  esac
  race "final confirm after $scenario refuses" "$holder" "if $confirm then raise exception 'stale confirm allowed'; end if; if (select attempts<>1 or state<>'posting' from public.whatsapp_automation_jobs where id='$j') then raise exception 'confirm mutated attempt/state'; end if"
done
setup
psql_task -c "update public.whatsapp_automation_jobs set claimed_until=clock_timestamp()+interval '2 seconds' where id='$j'" >/dev/null
race 'initial block uses SQL clock after job lock' "select id from public.whatsapp_automation_jobs where id='$j' for update" "if public.block_whatsapp_automation_preflight('$j','$f','reservation_pending') then raise exception 'expired ownership allowed'; end if; if (select state<>'claimed' or attempts<>0 or claim_token<>'$f'::uuid from public.whatsapp_automation_jobs where id='$j') then raise exception 'expired block wrote'; end if"
setup
psql_task -c "delete from public.whatsapp_automation_jobs where id='$j'" >/dev/null
race 'enqueue captures coherent post-rotation pins and needs_review' "update public.whatsapp_channels set credentials='{\"fixture_revision\":3}' where id='$ch'" "perform public.enqueue_whatsapp_automation(jsonb_build_object('unit_id','$u','kind','reminder_d1','reservation_id','$r','source_event_key','task36-race','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour')); if not exists(select from public.whatsapp_automation_jobs where unit_id='$u' and initial_credential_revision=1 and state='needs_review' and error_code='binding_changed') then raise exception 'mixed enqueue authority'; end if"
setup
psql_task -c "delete from public.whatsapp_automation_jobs where id='$j'; delete from public.whatsapp_template_bindings where id='$b'" >/dev/null
race 'enqueue missing binding capture refuses newly appeared binding' "select id from public.whatsapp_channels where id='$ch' for update; insert into public.whatsapp_template_bindings(id,unit_id,channel_id,account_id,provider,verified_at) values('$b','$u','$ch','$a','datafy',clock_timestamp())" "begin perform public.enqueue_whatsapp_automation(jsonb_build_object('unit_id','$u','kind','reminder_d1','reservation_id','$r','source_event_key','task36-binding-race','fact_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 hour')); raise exception 'mixed missing binding inserted'; exception when sqlstate 'PT503' then null; end; if exists(select from public.whatsapp_automation_jobs where unit_id='$u') then raise exception 'refused capture wrote a job'; end if"

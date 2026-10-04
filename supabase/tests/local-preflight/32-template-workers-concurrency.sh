#!/usr/bin/env bash
# Actual independent PostgreSQL sessions; only the named disposable runtime.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ "${TASK_DB_CONTAINER:-}" == 'supabase_db_moralles-templates-20261003' ]] || { echo 'wrong disposable DB'; exit 1; }
psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_tmp=$(mktemp -d)
flag_before=$(psql_task -c "select value::text from public.platform_flags where key='whatsapp_automation_dispatch'")
cleanup() {
  psql_task <<'SQL' >/dev/null
delete from vault.secrets where id in(select instance_token_secret_id from public.whatsapp_channels where id='32323232-0000-0000-0000-000000000024');
delete from public.organizations where id in('32323232-0000-0000-0000-000000000001','32323232-0000-0000-0000-000000000011');
delete from auth.users where id='32323232-0000-0000-0000-000000000009';
SQL
  psql_task -v previous="$flag_before" <<'SQL' >/dev/null
update public.platform_flags set value=:'previous'::jsonb where key='whatsapp_automation_dispatch';
SQL
  rm -f "$task_tmp/a" "$task_tmp/b"; rmdir "$task_tmp"
}
trap cleanup EXIT
wait_sleep() {
  for _ in {1..80}; do
    if [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='$1' and query like 'select pg_sleep%')") == t ]]; then return; fi
  done
  echo 'lock holder not observed'; exit 1
}
assert_true() { [[ $(psql_task -c "$1") == t ]] || { echo "FAIL: $2"; exit 1; }; }
psql_task <<'SQL' >/dev/null
insert into public.organizations(id,name) values('32323232-0000-0000-0000-000000000001','Worker A'),('32323232-0000-0000-0000-000000000011','Worker B');
insert into public.units(id,organization_id,name) values('32323232-0000-0000-0000-000000000002','32323232-0000-0000-0000-000000000001','A'),('32323232-0000-0000-0000-000000000012','32323232-0000-0000-0000-000000000011','B');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials,last_health_check_at) values('32323232-0000-0000-0000-000000000004','32323232-0000-0000-0000-000000000002','datafy','connected',true,'{"phone_number_id":"321"}',clock_timestamp()),('32323232-0000-0000-0000-000000000014','32323232-0000-0000-0000-000000000012','datafy','connected',true,'{"phone_number_id":"322"}',clock_timestamp());
SQL
psql_task <<'SQL' >"$task_tmp/a" &
begin;
set application_name='workers32_waba';
select public.bind_whatsapp_template_account('32323232-0000-0000-0000-000000000004','32323232-0000-0000-0000-000000000002','datafy',0,'321','32320001') is not null;
select pg_sleep(3);
commit;
SQL
pid_a=$!; wait_sleep workers32_waba
psql_task <<'SQL' >"$task_tmp/b" &
set statement_timeout='8s';
do $$begin
  begin perform public.bind_whatsapp_template_account('32323232-0000-0000-0000-000000000014','32323232-0000-0000-0000-000000000012','datafy',0,'322','32320001');
  exception when insufficient_privilege then return; end;
  raise exception 'cross org race allowed';
end$$;
SQL
pid_b=$!; wait "$pid_a"; wait "$pid_b"
assert_true "select count(*)=1 and min(organization_id::text)='32323232-0000-0000-0000-000000000001' from public.whatsapp_template_accounts where waba_id='32320001'" 'single organization globally owns WABA'
assert_true "select not exists(select from public.whatsapp_template_bindings where channel_id='32323232-0000-0000-0000-000000000014')" 'no foreign mixed pins'
echo 'GREEN: concurrent cross-org WABA discovery refuses uniformly'
psql_task <<'SQL' >/dev/null
begin;
insert into auth.users(id) values('32323232-0000-0000-0000-000000000009');
insert into public.platform_admins values('32323232-0000-0000-0000-000000000009');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"32323232-0000-0000-0000-000000000009"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where channel_id='32323232-0000-0000-0000-000000000004';
update public.platform_flags set value='true' where key='whatsapp_automation_dispatch';
insert into public.customers(id,organization_id,name,phone) values('32323232-0000-0000-0000-000000000003','32323232-0000-0000-0000-000000000001','Fake contact','11999990032');
insert into public.reservations(id,unit_id,customer_id) values('32323232-0000-0000-0000-000000000006','32323232-0000-0000-0000-000000000002','32323232-0000-0000-0000-000000000003');
insert into public.whatsapp_remote_templates(id,account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation,remote_id,remote_status,observed_hash,effective_category,local_status,sync_required,last_synced_at)
 select '32323232-0000-0000-0000-000000000008',id,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',repeat('a',64),'UTILITY',1,'32320008','APPROVED',repeat('a',64),'UTILITY','usable',false,clock_timestamp() from public.whatsapp_template_accounts where waba_id='32320001';
select public.enqueue_whatsapp_automation(jsonb_build_object('unit_id','32323232-0000-0000-0000-000000000002','kind','confirmation','reservation_id','32323232-0000-0000-0000-000000000006','source_event_key','rotation-race','fact_at',clock_timestamp()+interval '1 hour','expires_at',clock_timestamp()+interval '1 hour'));
update public.whatsapp_automation_jobs set safe_log_body='Fake local render' where unit_id='32323232-0000-0000-0000-000000000002';
select public.claim_whatsapp_automation(id) is not null from public.whatsapp_automation_jobs where unit_id='32323232-0000-0000-0000-000000000002';
commit;
SQL
# B owns only channel; A owns account/binding then waits for it. Parent locks in
# the channel trigger would reverse A's order. Current trigger cannot do so.
psql_task <<'SQL' >"$task_tmp/a" &
begin;
set application_name='workers32_rotation';
set statement_timeout='8s';
update public.whatsapp_channels set credentials=credentials||'{"access_token":"fake-new"}' where id='32323232-0000-0000-0000-000000000004';
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep workers32_rotation
psql_task <<'SQL' >"$task_tmp/b" &
set statement_timeout='8s';
select public.prepare_whatsapp_automation_post(id,claim_token,1,null,0) from public.whatsapp_automation_jobs where unit_id='32323232-0000-0000-0000-000000000002';
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^f$' "$task_tmp/b") == 1 ]] || { echo 'rotation permitted POST'; exit 1; }
assert_true "select state='needs_review' and attempts=0 and posting_started_at is null from public.whatsapp_automation_jobs where unit_id='32323232-0000-0000-0000-000000000002'" 'rotation blocks before followup'
assert_true "select generation=1 and channel_credential_revision=0 from public.whatsapp_template_bindings where channel_id='32323232-0000-0000-0000-000000000004'" 'followup deliberately has not run'
echo 'GREEN: rotation versus actual automation prepare blocks before followup without reverse-lock deadlock'
psql_task <<'SQL' >/dev/null
select public.reconcile_whatsapp_template_credentials('32323232-0000-0000-0000-000000000004');
select public.bind_whatsapp_template_account('32323232-0000-0000-0000-000000000004','32323232-0000-0000-0000-000000000002','datafy',1,'321','32320001');
select public.enqueue_whatsapp_template_job(id,'sync','first',11),public.enqueue_whatsapp_template_job(id,'sync','second',12) from public.whatsapp_template_bindings where channel_id='32323232-0000-0000-0000-000000000004';
SQL
psql_task <<'SQL' >"$task_tmp/a" &
begin;
set application_name='workers32_claim';
select public.claim_whatsapp_template_job(id) is not null from public.whatsapp_template_jobs where target_key='first' and revision=11;
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep workers32_claim
psql_task <<'SQL' >"$task_tmp/b" &
set statement_timeout='8s';
select public.claim_whatsapp_template_job(id) is null from public.whatsapp_template_jobs where target_key='second' and revision=12;
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^t$' "$task_tmp/b") == 1 ]] || { echo 'concurrent account work allowed';exit 1; }
echo 'GREEN: separate jobs cannot own the same account concurrently'

# Actual same-pointer Vault write: revision advances before replacing the secret.
psql_task <<'SQL' >/dev/null
begin;
update public.whatsapp_channels set is_active=false where id='32323232-0000-0000-0000-000000000014';
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,provisioning_claim_id,last_health_check_at)
 values('32323232-0000-0000-0000-000000000024','32323232-0000-0000-0000-000000000012','uazapi','connected',true,'32323232-0000-0000-0000-000000000025',clock_timestamp());
select public.store_whatsapp_channel_instance_token('32323232-0000-0000-0000-000000000024','32323232-0000-0000-0000-000000000025',repeat('x',32),null,'local-concurrency') is not null;
insert into public.whatsapp_template_bindings(unit_id,channel_id,provider,generation,channel_credential_revision)
 values('32323232-0000-0000-0000-000000000012','32323232-0000-0000-0000-000000000024','uazapi',1,1);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"32323232-0000-0000-0000-000000000009"}',true);
update public.whatsapp_template_bindings set adopted_at=clock_timestamp(),dispatch_enabled=true where channel_id='32323232-0000-0000-0000-000000000024';
insert into public.customers(id,organization_id,name,phone) values('32323232-0000-0000-0000-000000000023','32323232-0000-0000-0000-000000000011','Fake contact','11999990033');
insert into public.reservations(id,unit_id,customer_id) values('32323232-0000-0000-0000-000000000026','32323232-0000-0000-0000-000000000012','32323232-0000-0000-0000-000000000023');
select public.enqueue_whatsapp_automation(jsonb_build_object('unit_id','32323232-0000-0000-0000-000000000012','kind','confirmation','reservation_id','32323232-0000-0000-0000-000000000026','source_event_key','vault-race','fact_at',clock_timestamp()+interval '1 hour','expires_at',clock_timestamp()+interval '1 hour'));
update public.whatsapp_automation_jobs set safe_log_body='Fake local Vault render' where reservation_id='32323232-0000-0000-0000-000000000026';
select public.claim_whatsapp_automation(id) is not null from public.whatsapp_automation_jobs where reservation_id='32323232-0000-0000-0000-000000000026';
commit;
SQL
vault_pointer=$(psql_task -c "select instance_token_secret_id from public.whatsapp_channels where id='32323232-0000-0000-0000-000000000024'")
psql_task <<'SQL' >"$task_tmp/a" &
begin;
set application_name='workers32_vault';
set statement_timeout='8s';
select public.store_whatsapp_channel_instance_token('32323232-0000-0000-0000-000000000024','32323232-0000-0000-0000-000000000025',repeat('y',32),null,'local-concurrency') is not null;
select pg_sleep(3);
commit;
SQL
pid_a=$!;wait_sleep workers32_vault
psql_task <<'SQL' >"$task_tmp/b" &
set statement_timeout='8s';
select public.prepare_whatsapp_automation_post(id,claim_token,1,null,null) from public.whatsapp_automation_jobs where reservation_id='32323232-0000-0000-0000-000000000026';
SQL
pid_b=$!;wait "$pid_a";wait "$pid_b"
[[ $(grep -c '^f$' "$task_tmp/b") == 1 ]] || { echo 'Vault rotation permitted POST';exit 1; }
assert_true "select instance_token_secret_id='$vault_pointer'::uuid and template_credential_revision=2 from public.whatsapp_channels where id='32323232-0000-0000-0000-000000000024'" 'same pointer revision changed'
assert_true "select state='needs_review' and attempts=0 and posting_started_at is null from public.whatsapp_automation_jobs where reservation_id='32323232-0000-0000-0000-000000000026'" 'Vault rotation blocks before followup'
echo 'GREEN: actual same-reference Vault replacement versus prepare, no deadlock or POST'
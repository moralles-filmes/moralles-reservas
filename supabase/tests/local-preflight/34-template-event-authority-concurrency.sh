#!/usr/bin/env bash
# Independent PostgreSQL sessions in the named disposable local runtime only.
set -euo pipefail
export PGCLIENTENCODING=UTF8
[[ "${TASK_DB_CONTAINER:-}" == 'supabase_db_moralles-templates-20261003' ]] || { echo 'wrong disposable DB'; exit 1; }
psql_task() { "$TASK_DOCKER" exec -i "$TASK_DB_CONTAINER" psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
task_tmp=$(mktemp -d)
cleanup() {
  psql_task <<'SQL' >/dev/null
delete from public.whatsapp_template_jobs where account_id in(select id from public.whatsapp_template_accounts where waba_id='34340001');
delete from public.whatsapp_template_bindings where account_id in(select id from public.whatsapp_template_accounts where waba_id='34340001');
delete from public.whatsapp_template_accounts where waba_id='34340001';
delete from public.organizations where id='34343434-0000-0000-0000-000000000001';
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
capture() {
  psql_task <<'SQL'
select jsonb_build_object('accountId',a.id,'wabaId',a.waba_id,'organizationId',a.organization_id,'unitOrganizationId',u.organization_id,
'channelId',c.id,'unitId',c.unit_id,'provider',c.provider,'phoneNumberId',c.credentials->>'phone_number_id','verifiedAt',b.verified_at,
'credentialRevision',c.template_credential_revision,'bindingCredentialRevision',b.channel_credential_revision,
'bindingId',b.id,'bindingGeneration',b.generation,'accountGeneration',a.binding_generation)
from public.whatsapp_channels c join public.units u on u.id=c.unit_id join public.whatsapp_template_bindings b on b.channel_id=c.id
join public.whatsapp_template_accounts a on a.id=b.account_id where c.id='34343434-0000-0000-0000-000000000003';
SQL
}
state() { psql_task -c "select (select count(*) from public.whatsapp_template_events where account_id=a.id)||':'||a.reconciliation_revision||':'||(select count(*) from public.whatsapp_template_jobs where account_id=a.id)||':'||(select sync_epoch from public.whatsapp_remote_templates where account_id=a.id) from public.whatsapp_template_accounts a where waba_id='34340001'"; }
psql_task <<'SQL' >/dev/null
insert into public.organizations(id,name) values('34343434-0000-0000-0000-000000000001','Event authority race');
insert into public.units(id,organization_id,name) values('34343434-0000-0000-0000-000000000002','34343434-0000-0000-0000-000000000001','Race');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,credentials) values('34343434-0000-0000-0000-000000000003','34343434-0000-0000-0000-000000000002','datafy','connected',false,'{"phone_number_id":"341"}');
select public.bind_whatsapp_template_account('34343434-0000-0000-0000-000000000003','34343434-0000-0000-0000-000000000002','datafy',0,'341','34340001') is not null;
insert into public.whatsapp_remote_templates(account_id,logical_id,version,language,name,remote_id,desired_hash,requested_category,binding_generation)
select id,'res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1','341',repeat('a',64),'UTILITY',1 from public.whatsapp_template_accounts where waba_id='34340001';
SQL
cap=$(capture); before=$(state)
psql_task <<'SQL' >"$task_tmp/a" &
begin;
set application_name='event34_rotation';
update public.whatsapp_channels set credentials=credentials||'{"access_token":"local-race-1"}' where id='34343434-0000-0000-0000-000000000003';
select pg_sleep(3);
commit;
SQL
pid_a=$!; wait_sleep event34_rotation
psql_task -v capture="$cap" <<'SQL' >"$task_tmp/b" &
set statement_timeout='8s';
select set_config('event34.capture',:'capture',false);
do $$begin
  begin perform public.record_whatsapp_template_events_fenced(current_setting('event34.capture')::jsonb,jsonb_build_array(jsonb_build_object('field','message_template_status_update','remote_id','341','event_time',clock_timestamp(),'digest',repeat('1',64),'remote_status','PAUSED')));
  exception when sqlstate 'PT503' then return; end;
  raise exception 'stale authority allowed';
end$$;
SQL
pid_b=$!; wait "$pid_a"; wait "$pid_b"
[[ $(state) == "$before" ]] || { echo 'stale event changed state';exit 1; }
echo 'GREEN: event waits for rotation and refuses current stale authority, zero effects'
psql_task <<'SQL' >/dev/null
select public.reconcile_whatsapp_template_credentials('34343434-0000-0000-0000-000000000003');
select public.bind_whatsapp_template_account('34343434-0000-0000-0000-000000000003','34343434-0000-0000-0000-000000000002','datafy',1,'341','34340001') is not null;
SQL
cap=$(capture)
psql_task -v capture="$cap" <<'SQL' >"$task_tmp/a" &
begin;
set application_name='event34_writer';
select public.record_whatsapp_template_events_fenced(:'capture'::jsonb,jsonb_build_array(jsonb_build_object('field','message_template_status_update','remote_id','341','event_time',clock_timestamp(),'digest',repeat('2',64),'remote_status','PAUSED')))=1;
select pg_sleep(3);
commit;
SQL
pid_a=$!; wait_sleep event34_writer
psql_task <<'SQL' >"$task_tmp/b" &
set application_name='event34_blocked_rotation';
set statement_timeout='8s';
update public.whatsapp_channels set credentials=credentials||'{"access_token":"local-race-2"}' where id='34343434-0000-0000-0000-000000000003';
SQL
pid_b=$!
blocked=false
for _ in {1..60}; do
  if [[ $(psql_task -c "select exists(select from pg_stat_activity where application_name='event34_blocked_rotation' and wait_event_type='Lock')") == t ]]; then blocked=true; break; fi
done
wait "$pid_a";wait "$pid_b"
[[ "$blocked" == true ]] || { echo 'rotation was not blocked by writer';exit 1; }
[[ $(state) == '1:1:1:2' ]] || { echo 'positive event state mismatch';exit 1; }
[[ $(psql_task -c "select template_credential_revision=2 from public.whatsapp_channels where id='34343434-0000-0000-0000-000000000003'") == t ]] || { echo 'rotation did not complete';exit 1; }
echo 'GREEN: channel SHARE lock holds authority until event commit; rotation resumes, no deadlock'

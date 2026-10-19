// Two real sessions per race, only against the networkless disposable fixture.
import { execFileSync, spawn } from 'node:child_process';

const container = process.env.TEMPLATE74_CONTAINER || 'margin-template-v2-sql-pg';
const image = execFileSync('docker', ['inspect', '--format',
  '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}', container],
{ encoding: 'utf8' }).trim();
if (image !== 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') {
  throw new Error('template_v2_concurrency_quarantine_required');
}

const id = n => `74000000-0000-4000-8000-000000000${String(n).padStart(3, '0')}`;
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
  '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
const query = sql => execFileSync('docker', args, { input: sql,
  encoding: 'utf8', timeout: 15_000 }).trim();
function start(sql, marker) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const reached = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`marker_timeout ${stdout} ${stderr}`)), 15_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', code => {
      if (!stdout.includes(marker)) { clearTimeout(timeout); reject(new Error(`early_exit ${code} ${stderr}`)); }
    });
  });
  const done = new Promise((resolve, reject) => child.on('exit', code =>
    code === 0 ? resolve(stdout) : reject(new Error(`psql_exit ${code} ${stderr}`))));
  child.stdin.end(sql);
  return { reached, done };
}
async function waitForLock(application) {
  for (let i = 0; i < 30; i++) {
    const count = Number(query(`select count(*) from pg_stat_activity where datname='postgres'
      and application_name='${application}' and wait_event_type='Lock';`));
    if (count === 1) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`expected_lock_wait_not_observed ${application}`);
}
function refresh() {
  query(`update public.whatsapp_channels set last_health_check_at=clock_timestamp()
    where id in('${id(41)}','${id(42)}','${id(43)}','${id(44)}');`);
}
const authorize = (onboarding, binding) =>
  `select public.authorize_whatsapp_template_v2_channel('${id(onboarding)}','${id(binding)}',1,0);`;
const worker = (application, body, hold = 6) => `set application_name='${application}'; begin;
  select set_config('request.jwt.claim.role','service_role',true);
  ${body}
  \\echo RACE_REACHED
  ${hold ? `select pg_sleep(${hold});` : ''} commit;`;
const v1Seed = account => `do $$ begin
  begin
    insert into public.whatsapp_remote_templates
      (account_id,logical_id,version,language,name,desired_hash,requested_category,binding_generation)
    values('${id(account)}','res_confirmacao_v1',1,'pt_BR','res_confirmacao_v1',
      'ce487eeff4d968250f3f9e66c4cc68ff2ae5bbef7dc5fc2589c63089240893c1',
      'UTILITY',1);
    raise exception 'unexpected_v1_seed_success';
  exception when check_violation then
    raise notice 'V1_SEED_REJECTED';
  end;
end $$;`;

// v2 account lock first: old v1 seed waits, then fails closed.
refresh();
const grantA = start(worker('template74_grant_a', authorize(31, 61)), 'RACE_REACHED');
await grantA.reached;
const seedA = start(worker('template74_seed_a', v1Seed(51), false), 'RACE_REACHED');
await waitForLock('template74_seed_a');
const [grantAOut] = await Promise.all([grantA.done, seedA.done]);
if (!grantAOut.split(/\r?\n/).includes('t') || query(`select
  (select count(*) from app_private.whatsapp_template_account_cohorts where account_id='${id(51)}')::text||'|'||
  (select count(*) from public.whatsapp_remote_templates where account_id='${id(51)}' and version=1)::text;`) !== '1|0') {
  throw new Error('grant_first_cohort_or_v1_seed_failed');
}
console.log('GREEN74B v2-first: v1 seed waited on account and was rejected; one v2 cohort');

// Even when old sync reaches the account first, pending v2 enrollment denies a
// v1 seed. The v2 grant can then establish the sole cohort.
refresh();
const seedB = start(worker('template74_seed_b',
  `select 1 from public.whatsapp_template_accounts where id='${id(52)}' for share;\n${v1Seed(52)}`, 10),
  'RACE_REACHED');
await seedB.reached;
const grantB = start(worker('template74_grant_b', authorize(32, 62), false), 'RACE_REACHED');
await waitForLock('template74_grant_b');
const [, grantBOut] = await Promise.all([seedB.done, grantB.done]);
if (!grantBOut.split(/\r?\n/).includes('t') || query(`select
  (select count(*) from app_private.whatsapp_template_account_cohorts where account_id='${id(52)}')::text||'|'||
  (select count(*) from public.whatsapp_remote_templates where account_id='${id(52)}' and version=1)::text;`) !== '1|0') {
  throw new Error('seed_first_pending_v2_fence_failed');
}
console.log('GREEN74B v1-first: pending v2 enrollment rejected old seed; v2 grant waited and won');

// Two units can grant one shared WABA, but cannot create two cohorts.
refresh();
const sharedA = start(worker('template74_shared_a', authorize(33, 63)), 'RACE_REACHED');
await sharedA.reached;
const sharedB = start(worker('template74_shared_b', authorize(34, 64), false), 'RACE_REACHED');
await waitForLock('template74_shared_b');
const [sharedOutA, sharedOutB] = await Promise.all([sharedA.done, sharedB.done]);
if (![sharedOutA, sharedOutB].every(out => out.split(/\r?\n/).includes('t')) ||
  query(`select
    (select count(*) from app_private.whatsapp_template_account_cohorts where account_id='${id(53)}')::text||'|'||
    (select count(*) from app_private.whatsapp_template_v2_grants where account_id='${id(53)}' and revoked_at is null)::text||'|'||
    (select count(distinct unit_id) from app_private.whatsapp_template_v2_grants where account_id='${id(53)}')::text;`) !== '1|2|2') {
  throw new Error('shared_waba_cohort_or_grants_failed');
}
console.log('GREEN74B shared WABA: second unit waited; one account cohort and two tenant-pinned grants');

// Datafy mutates channel before onboarding. Replaying the automatic grant
// must follow that lock order in both interleavings, without a deadlock.
const datafy = (application, hold = 6) => `set application_name='${application}'; begin;
  select 1 from public.whatsapp_channels where id='${id(42)}' for update;
  select 1 from public.whatsapp_datafy_onboardings where id='${id(32)}' for update;
  \\echo RACE_REACHED
  ${hold ? `select pg_sleep(${hold});` : ''} commit;`;
refresh();
const datafyFirst = start(datafy('template74_datafy_first'), 'RACE_REACHED');
await datafyFirst.reached;
const grantAfterDatafy = start(worker('template74_grant_after_datafy', authorize(32, 62), 0), 'RACE_REACHED');
await waitForLock('template74_grant_after_datafy');
const [, afterDatafyOut] = await Promise.all([datafyFirst.done, grantAfterDatafy.done]);
if (!afterDatafyOut.split(/\r?\n/).includes('t')) throw new Error('datafy_first_regrant_failed');
console.log('GREEN74B Datafy-first: v2 grant waited on channel, then replayed without deadlock');
refresh();
const grantBeforeDatafy = start(worker('template74_grant_before_datafy', authorize(32, 62)), 'RACE_REACHED');
await grantBeforeDatafy.reached;
const datafyAfterGrant = start(datafy('template74_datafy_after_grant', 0), 'RACE_REACHED');
await waitForLock('template74_datafy_after_grant');
const [beforeDatafyOut] = await Promise.all([grantBeforeDatafy.done, datafyAfterGrant.done]);
if (!beforeDatafyOut.split(/\r?\n/).includes('t')) throw new Error('grant_first_datafy_lock_failed');
console.log('GREEN74B grant-first: Datafy writer waited on channel, then completed without deadlock');

// An existing v1 account may be selected manually only after its in-flight
// provision has a durable terminal result. This uses the real claim/finish
// RPCs around a synthetic posting transition, with no provider call.
const digest = '74512848434a9be4b89916aea5b047f15ddcffc801dba9cb23e41f6f73dcad55';
const manualAction = `select public.select_whatsapp_template_v2_existing_account(
  '${id(65)}',1,0,'${digest}');`;
const admin = (application, body, hold = 6) => `set application_name='${application}'; begin;
  select set_config('request.jwt.claim.role','authenticated',true);
  select set_config('request.jwt.claim.sub','${id(1)}',true);
  ${body}
  \\echo RACE_REACHED
  ${hold ? `select pg_sleep(${hold});` : ''} commit;`;
refresh();
const posting = start(`set application_name='template74_v1_posting'; begin;
  select 1 from public.whatsapp_template_accounts where id='${id(54)}' for share;
  select public.claim_whatsapp_template_job('${id(75)}');
  update public.whatsapp_template_jobs set state='posting',attempts=1,
    posting_started_at=clock_timestamp() where id='${id(75)}';
  \\echo RACE_REACHED
  select pg_sleep(6); commit;`, 'RACE_REACHED');
await posting.reached;
const manualAgainstPosting = start(admin('template74_manual_vs_v1', manualAction, 0), 'RACE_REACHED');
await waitForLock('template74_manual_vs_v1');
const [, manualDeniedOut] = await Promise.all([posting.done, manualAgainstPosting.done]);
if (!manualDeniedOut.split(/\r?\n/).includes('f') ||
  query(`select count(*) from app_private.whatsapp_template_account_cohorts where account_id='${id(54)}';`) !== '0') {
  throw new Error('manual_selected_during_unresolved_v1_post');
}
const v1Finished = query(`select public.finish_whatsapp_template_job('${id(75)}',
  (select claim_token from public.whatsapp_template_jobs where id='${id(75)}'),
  '{"outcome":"accepted","reason":"provider_accepted"}'::jsonb);`);
if (v1Finished !== 't' || query(`select state from public.whatsapp_template_jobs where id='${id(75)}';`) !== 'accepted') {
  throw new Error('synthetic_v1_post_not_reconciled');
}
console.log('GREEN74B v1 posting-first: manual selection waited, refused unresolved v1, then v1 finish reconciled');

const manualGrant = start(admin('template74_manual_grant', manualAction, 0), 'RACE_REACHED');
const manualGrantOut = await manualGrant.done;
if (!manualGrantOut.split(/\r?\n/).includes('t')) throw new Error('manual_grant_after_v1_reconcile_failed');
const manualStop = start(admin('template74_manual_stop',
  `select public.release_whatsapp_template_v2_channel('${id(65)}',1,0);`), 'RACE_REACHED');
await manualStop.reached;
const manualReplay = start(admin('template74_manual_replay', manualAction, 0), 'RACE_REACHED');
await waitForLock('template74_manual_replay');
const [manualStopOut, manualReplayOut] = await Promise.all([manualStop.done, manualReplay.done]);
if (!manualStopOut.split(/\r?\n/).includes('t') || !manualReplayOut.split(/\r?\n/).includes('f') ||
  query(`select (select count(*) from app_private.whatsapp_template_v2_grants
    where binding_id='${id(65)}' and revoked_at is null)::text||'|'||
    (select state from public.whatsapp_template_jobs where id='${id(75)}');`) !== '0|accepted') {
  throw new Error('manual_stop_race_or_v1_history_failed');
}
console.log('GREEN74B manual stop-first: replay waited on account and could not resurrect grant; v1 job retained');

// A platform stop racing the first grant follows the same lock order and
// leaves no active grant. No external API is called by this test.
refresh();
const stopSql = `set application_name='template74_stop'; begin;
  select set_config('request.jwt.claim.role','authenticated',true);
  select set_config('request.jwt.claim.sub','${id(1)}',true);
  select public.release_whatsapp_template_v2_channel('${id(61)}',1,0);
  \\echo RACE_REACHED
  select pg_sleep(6); commit;`;
const stop = start(stopSql, 'RACE_REACHED');
await stop.reached;
const regrant = start(worker('template74_regrant', authorize(31, 61), false), 'RACE_REACHED');
await waitForLock('template74_regrant');
const [stopOut, regrantOut] = await Promise.all([stop.done, regrant.done]);
if (!stopOut.split(/\r?\n/).includes('t') || !regrantOut.split(/\r?\n/).includes('f') ||
  query(`select count(*) from app_private.whatsapp_template_v2_grants
    where binding_id='${id(61)}' and revoked_at is null;`) !== '0') {
  throw new Error('stop_regrant_lock_or_revocation_failed');
}
console.log('GREEN74B stop-first: regrant waited on enrollment and was denied; zero active grants');

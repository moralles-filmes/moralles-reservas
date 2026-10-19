// Two real psql sessions per case, on isolated clones of the disposable fixture.
// Run only in an isolated networkless Postgres 17 container after 73a setup and safe pg_dump
// restore into the six auto73_* databases used below.
import { execFileSync, spawn } from 'node:child_process';
import { resolveLocalDocker } from './local-runtime-paths.mjs';

const docker = resolveLocalDocker();
const container = process.env.AUTO73_CONTAINER || 'margin-template-auto-sql-pg';
const fixture = {
  job: '73000000-0000-4000-8000-000000000061',
  fence: '73000000-0000-4000-8000-000000000071',
  admin: '73000000-0000-4000-8000-000000000021',
  hash: '4ab2cdd4711c9b95b122a23a773088bfa8b6d3d15a6eac04cb234d4f8d0ac114',
};
const identity = execFileSync(docker, ['inspect', '--format', '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}', container], { encoding: 'utf8' }).trim();
if (identity !== 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') throw new Error('nonquarantined_postgres');

function args(db) { return ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']; }
function query(db, sql) {
  const output = execFileSync(docker, args(db), { input: sql, encoding: 'utf8', timeout: 10_000 });
  return output.trim();
}
function start(db, sql, marker) {
  const child = spawn(docker, args(db), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const reached = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`marker_timeout ${db} ${stdout} ${stderr}`)), 10_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (marker && stdout.includes(marker)) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', code => { if (marker && !stdout.includes(marker)) { clearTimeout(timeout); reject(new Error(`early_exit ${code} ${stderr}`)); } });
    if (!marker) { clearTimeout(timeout); resolve(); }
  });
  const done = new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`psql_exit ${code}: ${stderr}`))));
  child.stdin.end(sql);
  return { reached, done };
}
async function waitForLock(db, application) {
  for (let i = 0; i < 20; i++) {
    const count = Number(query(db, `select count(*) from pg_stat_activity where datname='${db}' and application_name='${application}' and wait_event_type='Lock';`));
    if (count === 1) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`expected_lock_wait_not_observed ${db} ${application}`);
}
function refresh(db) {
  query(db, `update public.whatsapp_channels set last_health_check_at=clock_timestamp()
      where id in('73000000-0000-4000-8000-000000000041','73000000-0000-4000-8000-000000000042',
        '73000000-0000-4000-8000-000000000043');
    update public.whatsapp_remote_templates set last_synced_at=clock_timestamp() where account_id='73000000-0000-4000-8000-000000000051';
    update public.whatsapp_template_jobs set claimed_until=clock_timestamp()+interval '5 minutes' where id='${fixture.job}';`);
}
const confirm = `select public.confirm_whatsapp_template_post('${fixture.job}','${fixture.fence}',1,'${fixture.hash}');`;
const revoke = `select public.configure_whatsapp_template_auto_policy(false,1)->>'revision';`;
const adminSession = `set application_name='auto73_admin'; begin;
  select set_config('request.jwt.claim.role','authenticated',true);
  select set_config('request.jwt.claim.sub','${fixture.admin}',true);
  ${revoke}
  \\echo LOCK_HELD
  select pg_sleep(3); commit;`;
const workerSession = `set application_name='auto73_worker'; begin;
  select set_config('request.jwt.claim.role','service_role',true);
  ${confirm}
  \\echo LOCK_HELD
  select pg_sleep(3); commit;`;

// Revocation commits first: the worker waits on policy row and is denied.
refresh('auto73_revoke_first');
const adminA = start('auto73_revoke_first', adminSession, 'LOCK_HELD');
await adminA.reached;
const workerA = start('auto73_revoke_first', workerSession.replace('\\echo LOCK_HELD\n  select pg_sleep(3); ', ''), null);
await waitForLock('auto73_revoke_first', 'auto73_worker');
const [adminOutA, workerOutA] = await Promise.all([adminA.done, workerA.done]);
if (!workerOutA.split(/\r?\n/).includes('f') || query('auto73_revoke_first', 'select count(*) from app_private.whatsapp_template_post_confirmations;') !== '0') {
  throw new Error(`revoke_first_failed ${adminOutA} ${workerOutA}`);
}
console.log('GREEN73B revoke-first: worker waited on policy lock; confirm=false; zero durable confirmations');

// Confirmation commits first: policy update waits; one durable confirmation survives.
refresh('auto73_confirm_first');
const workerB = start('auto73_confirm_first', workerSession, 'LOCK_HELD');
await workerB.reached;
const adminB = start('auto73_confirm_first', adminSession.replace('\\echo LOCK_HELD\n  select pg_sleep(3); ', ''), null);
await waitForLock('auto73_confirm_first', 'auto73_admin');
const [workerOutB, adminOutB] = await Promise.all([workerB.done, adminB.done]);
if (!workerOutB.split(/\r?\n/).includes('t') || query('auto73_confirm_first', 'select count(*) from app_private.whatsapp_template_post_confirmations;') !== '1') {
  throw new Error(`confirm_first_failed ${workerOutB} ${adminOutB}`);
}
console.log('GREEN73B confirm-first: admin waited on policy lock; confirm=true; one durable confirmation');

// The same enrollment→binding lock order serializes a manual stop against the
// first auto grant. Channel 042 has a verified binding and no preexisting grant.
function grantStopSql(db) {
  const binding = query(db, `select id from public.whatsapp_template_bindings where channel_id='73000000-0000-4000-8000-000000000042';`);
  if (!/^[0-9a-f-]{36}$/.test(binding)) throw new Error(`binding_missing ${db}`);
  const existing = query(db, `select count(*) from app_private.whatsapp_template_submission_grants where binding_id='${binding}';`);
  if (existing !== '0') throw new Error(`preexisting_grant ${db} ${existing}`);
  const grant = `select public.authorize_whatsapp_template_auto_channel('73000000-0000-4000-8000-000000000032','${binding}',1,0);`;
  const stop = `select public.release_whatsapp_template_channel('73000000-0000-4000-8000-000000000042','catalog',false,0,1);`;
  return {
    grant: `set application_name='auto73_grant'; begin;
      select set_config('request.jwt.claim.role','service_role',true);
      ${grant}
      \\echo LOCK_HELD
      select pg_sleep(3); commit;`,
    stop: `set application_name='auto73_stop'; begin;
      select set_config('request.jwt.claim.role','authenticated',true);
      select set_config('request.jwt.claim.sub','${fixture.admin}',true);
      ${stop}
      \\echo LOCK_HELD
      select pg_sleep(3); commit;`,
  };
}
function assertStopped(db) {
  const result = query(db, `select (e.excluded_at is not null)::text||'|'||(b.submission_authorized_at is null)::text||'|'||
    (select count(*) from app_private.whatsapp_template_submission_grants g where g.binding_id=b.id and g.revoked_at is null)::text
    from app_private.whatsapp_template_auto_enrollments e
    join public.whatsapp_template_bindings b on b.channel_id=e.channel_id
    where e.onboarding_id='73000000-0000-4000-8000-000000000032';`);
  if (result !== 'true|true|0') throw new Error(`stop_not_durable ${db} ${result}`);
}

refresh('auto73_grant_first');
const grantFirst = grantStopSql('auto73_grant_first');
const workerC = start('auto73_grant_first', grantFirst.grant, 'LOCK_HELD');
await workerC.reached;
const adminC = start('auto73_grant_first', grantFirst.stop.replace('\\echo LOCK_HELD\n      select pg_sleep(3); ', ''), null);
await waitForLock('auto73_grant_first', 'auto73_stop');
const [workerOutC, adminOutC] = await Promise.all([workerC.done, adminC.done]);
if (!workerOutC.split(/\r?\n/).includes('t') || !adminOutC.split(/\r?\n/).includes('t')) {
  throw new Error(`grant_first_failed ${workerOutC} ${adminOutC}`);
}
assertStopped('auto73_grant_first');
const grantedThenRevoked = query('auto73_grant_first', `select count(*) from app_private.whatsapp_template_submission_grants g
  join public.whatsapp_template_bindings b on b.id=g.binding_id
  where b.channel_id='73000000-0000-4000-8000-000000000042' and g.origin='auto' and g.revoked_at is not null;`);
if (grantedThenRevoked !== '1' || query('auto73_grant_first', 'select count(*) from app_private.whatsapp_template_auto_permits;') !== '0') {
  throw new Error(`first_grant_not_revoked_or_permit_leaked ${grantedThenRevoked}`);
}
console.log('GREEN73B first-grant-first: stop waited, revoked the newly created grant, and excluded the enrollment');

refresh('auto73_stop_first');
const stopFirst = grantStopSql('auto73_stop_first');
const adminD = start('auto73_stop_first', stopFirst.stop, 'LOCK_HELD');
await adminD.reached;
const workerD = start('auto73_stop_first', stopFirst.grant.replace('\\echo LOCK_HELD\n      select pg_sleep(3); ', ''), null);
await waitForLock('auto73_stop_first', 'auto73_grant');
const [adminOutD, workerOutD] = await Promise.all([adminD.done, workerD.done]);
if (!adminOutD.split(/\r?\n/).includes('t') || !workerOutD.split(/\r?\n/).includes('f')) {
  throw new Error(`stop_first_failed ${adminOutD} ${workerOutD}`);
}
assertStopped('auto73_stop_first');
if (query('auto73_stop_first', `select count(*) from app_private.whatsapp_template_submission_grants g
  join public.whatsapp_template_bindings b on b.id=g.binding_id
  where b.channel_id='73000000-0000-4000-8000-000000000042';`) !== '0') {
  throw new Error('stop_first_created_grant');
}
console.log('GREEN73B stop-first: first grant waited on enrollment lock and was denied after exclusion');

// Two new channels in separate units share one account/WABA. SKIP LOCKED must
// select different enrollments while both transactions remain open; both typed
// permits must be consumed, with one grant per channel and no new POST job.
refresh('auto73_shared_waba');
const sharedSql = application => `set application_name='${application}'; begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select x.channel_id::text||'|'||
    public.authorize_whatsapp_template_auto_channel(x.onboarding_id,b.id,b.generation,x.credential_revision)::text
    from public.claim_due_whatsapp_template_preparations(1) x
    join public.whatsapp_template_bindings b on b.channel_id=x.channel_id;
  \\echo CLAIMED
  select pg_sleep(5); commit;`;
const sharedA = start('auto73_shared_waba', sharedSql('auto73_shared_a'), 'CLAIMED');
await sharedA.reached;
const sharedB = start('auto73_shared_waba', sharedSql('auto73_shared_b'), 'CLAIMED');
await sharedB.reached;
const concurrentSessions = query('auto73_shared_waba', `select count(*) from pg_stat_activity
  where datname='auto73_shared_waba' and application_name in('auto73_shared_a','auto73_shared_b')
    and state='active' and wait_event='PgSleep';`);
if (concurrentSessions !== '2') throw new Error(`shared_claims_not_concurrent ${concurrentSessions}`);
const [sharedOutA, sharedOutB] = await Promise.all([sharedA.done, sharedB.done]);
const sharedChannels = [sharedOutA, sharedOutB].map(output => {
  const match = output.match(/(73000000-0000-4000-8000-00000000004[23])\|t/);
  if (!match) throw new Error(`shared_grant_failed ${output}`);
  return match[1];
});
if (new Set(sharedChannels).size !== 2) throw new Error(`shared_claim_duplicate ${sharedChannels}`);
const sharedState = query('auto73_shared_waba', `select
  (select count(*) from app_private.whatsapp_template_submission_grants g
    join public.whatsapp_template_bindings b on b.id=g.binding_id
    where b.channel_id in('73000000-0000-4000-8000-000000000042','73000000-0000-4000-8000-000000000043')
      and g.origin='auto' and g.revoked_at is null)::text||'|'||
  (select count(distinct g.unit_id) from app_private.whatsapp_template_submission_grants g
    join public.whatsapp_template_bindings b on b.id=g.binding_id
    where b.channel_id in('73000000-0000-4000-8000-000000000042','73000000-0000-4000-8000-000000000043')
      and g.origin='auto' and g.revoked_at is null)::text||'|'||
  (select count(*) from app_private.whatsapp_template_auto_permits)::text||'|'||
  (select count(*) from public.whatsapp_template_jobs where operation='provision')::text;`);
if (sharedState !== '2|2|0|1') throw new Error(`shared_grant_or_post_duplicate ${sharedState}`);
console.log('GREEN73B shared WABA: concurrent claims chose distinct units; two channel grants, zero permits, one existing provision job');

// A single provision job/fence permits one durable POST intention even when
// two workers confirm concurrently. No provider call is performed here.
refresh('auto73_double_confirm');
const confirmFirst = start('auto73_double_confirm', workerSession, 'LOCK_HELD');
await confirmFirst.reached;
const confirmSecond = start('auto73_double_confirm', workerSession
  .replace("application_name='auto73_worker'", "application_name='auto73_worker_second'")
  .replace('\\echo LOCK_HELD\n  select pg_sleep(3); ', ''), null);
await waitForLock('auto73_double_confirm', 'auto73_worker_second');
const [firstConfirmOut, secondConfirmOut] = await Promise.all([confirmFirst.done, confirmSecond.done]);
const outcomes = [firstConfirmOut, secondConfirmOut].map(output => output.split(/\r?\n/).find(line => line === 't' || line === 'f'));
if (outcomes.sort().join('|') !== 'f|t' ||
  query('auto73_double_confirm', 'select count(*) from app_private.whatsapp_template_post_confirmations;') !== '1') {
  throw new Error(`double_confirm_not_one_use ${outcomes} ${firstConfirmOut} ${secondConfirmOut}`);
}
console.log('GREEN73B double confirm: one worker won the fence, one lost; exactly one durable POST intention');

// Real two-session regression for Datafy channel -> onboarding lock order.
// Run after bootstrap 73 and fixture 73a in an exclusive networkless PG 17
// container. Only synthetic database clones below are mutated and removed.
import { execFileSync, spawn } from 'node:child_process';
import { resolveLocalDocker } from './local-runtime-paths.mjs';

const docker = resolveLocalDocker();
const container = 'margin-template-lock-order-pg';
const identity = execFileSync(docker, ['inspect', '--format',
  '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}', container],
{ encoding: 'utf8' }).trim();
if (identity !== 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') throw new Error('nonquarantined_postgres');

const channel = '73000000-0000-4000-8000-000000000042';
const onboarding = '73000000-0000-4000-8000-000000000032';
const signature = 'public.authorize_whatsapp_template_auto_channel(uuid,uuid,bigint,bigint)';
const databases = ['auto73d_writer_first', 'auto73d_stale_onboarding', 'auto73d_old_order'];
const created = [];
function args(db) {
  return ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db,
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
}
function query(db, sql) {
  return execFileSync(docker, args(db), { input: sql, encoding: 'utf8', timeout: 15_000 }).trim();
}
function start(db, sql, marker) {
  const child = spawn(docker, args(db), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', reached = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { child.kill(); rejectReady(new Error(`session_timeout ${db}`)); }, 20_000);
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    if (marker && stdout.includes(marker)) { reached = true; resolveReady(); }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const done = new Promise(resolve => child.on('exit', code => {
    clearTimeout(timer);
    if (marker && !reached) rejectReady(new Error(`marker_missing ${db} ${stderr}`));
    resolve({ code, stdout, stderr });
  }));
  if (marker) child.stdin.write(sql); else { child.stdin.end(sql); resolveReady(); }
  return { ready, done, finish: tail => child.stdin.end(tail) };
}
async function waitForChannelLock(db) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (query(db, `select count(*) from pg_stat_activity worker
      where worker.datname='${db}' and worker.application_name='auto73d_authorize'
        and worker.wait_event_type='Lock'
        and exists(select from pg_stat_activity writer
          where writer.datname='${db}' and writer.application_name='auto73d_writer'
            and writer.pid=any(pg_blocking_pids(worker.pid)));`) === '1') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`channel_lock_wait_not_observed ${db}`);
}
const sessionSettings = `\n\\set VERBOSITY verbose
  set deadlock_timeout='100ms'; set lock_timeout='8s'; set statement_timeout='12s';`;
async function race(db, changeOnboarding, expectDeadlock = false) {
  const binding = query(db, `select id from public.whatsapp_template_bindings where channel_id='${channel}';`);
  if (!/^[0-9a-f-]{36}$/.test(binding)) throw new Error(`fixture_binding_missing ${db}`);
  query(db, `update public.whatsapp_channels set last_health_check_at=clock_timestamp() where id='${channel}';`);
  const writer = start(db, `${sessionSettings}
    set application_name='auto73d_writer'; begin;
    select id from public.whatsapp_channels where id='${channel}' for update;
    \\echo CHANNEL_LOCK_HELD
`, 'CHANNEL_LOCK_HELD');
  await writer.ready;
  const authorize = start(db, `${sessionSettings}
    set application_name='auto73d_authorize'; begin;
    select set_config('request.jwt.claim.role','service_role',true);
    select public.authorize_whatsapp_template_auto_channel('${onboarding}','${binding}',1,0);
    commit;`, null);
  try {
    await waitForChannelLock(db);
  } catch (error) {
    writer.finish('rollback;\n');
    await Promise.all([writer.done, authorize.done]);
    throw error;
  }
  // This is the channel -> onboarding edge used by real Datafy identity
  // writers/finalizers. The writer proceeds only after the wait was observed.
  writer.finish(`update public.whatsapp_datafy_onboardings
    set ${changeOnboarding ? "state='abandoned',abandoned_at=clock_timestamp()" : 'updated_at=clock_timestamp()'}
    where id='${onboarding}'; commit;\n`);
  const outcomes = await Promise.all([writer.done, authorize.done]);
  if (expectDeadlock) {
    if (!outcomes.some(result => result.code !== 0 && result.stderr.includes('40P01')) ||
        outcomes.some(result => result.code !== 0 && !result.stderr.includes('40P01'))) {
      throw new Error(`old_order_control_did_not_deadlock ${JSON.stringify(outcomes)}`);
    }
    console.log('CONTROL73D old onboarding -> channel order: observed channel wait followed by SQLSTATE 40P01');
    return;
  }
  const expected = changeOnboarding ? 'f' : 't';
  if (outcomes.some(result => result.code !== 0) || !outcomes[1].stdout.split(/\r?\n/).includes(expected)) {
    throw new Error(`writer_first_failed ${db} ${JSON.stringify(outcomes)}`);
  }
  const state = query(db, `select
    (select count(*) from app_private.whatsapp_template_submission_grants where binding_id='${binding}' and revoked_at is null)::text||'|'||
    (select count(*) from app_private.whatsapp_template_auto_permits)::text;`);
  if (state !== `${changeOnboarding ? '0' : '1'}|0`) throw new Error(`grant_or_permit_leaked ${db} ${state}`);
  console.log(changeOnboarding
    ? 'GREEN73D stale completion: authorize waited on channel, reread abandoned onboarding, returned false with zero grants/permits'
    : 'GREEN73D writer-first: observed channel wait, writer updated onboarding and committed, authorize granted exactly once');
}

if (query('postgres', `select
  (not exists(select from cron.job where jobname in('whatsapp-automation-worker','whatsapp-template-workers'))
    and not exists(select from net.http_request_queue)
    and current_setting('server_version_num')::integer>=170000)::text;`) !== 'true') {
  throw new Error('local_fixture_quarantine_required');
}
try {
  // pg_cron/pg_net keep background sessions in postgres. Clone the synthetic
  // fixture by dump instead of terminating those sessions or copying workers.
  // Reserved extension ownership/ACL cannot be restored as postgres. These
  // clones prove row-lock behavior only; preflight 73 measures the original ACL.
  const fixtureDump = execFileSync(docker, ['exec', container, 'pg_dump', '-U', 'postgres',
    '-d', 'postgres', '--no-owner', '--no-privileges', '--exclude-extension=pg_cron', '--exclude-extension=pg_net',
    '--exclude-table-data=vault.secrets'],
  { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  for (const db of databases) {
    if (query('template1', `select count(*) from pg_database where datname='${db}';`) !== '0') {
      throw new Error(`database_already_exists ${db}`);
    }
    query('template1', `create database ${db} template template0;`);
    created.push(db);
    query(db, fixtureDump);
  }
  await race(databases[0], false);
  await race(databases[1], true);

  const controlDb = databases[2];
  const original = query(controlDb, `select pg_get_functiondef('${signature}'::regprocedure);`);
  const lockBlock = `  select * into o from public.whatsapp_datafy_onboardings where id=e.onboarding_id for share;
  if not found or o.state<>'completed' or (o.organization_id,o.unit_id,o.reserved_channel_id)
    is distinct from (e.organization_id,e.unit_id,e.channel_id) then return false; end if;`;
  const discovery = '  select * into b from public.whatsapp_template_bindings where id=p_binding_id;';
  if (original.split(lockBlock).length !== 2 || original.split(discovery).length !== 2) {
    throw new Error('positive_control_anchor_changed');
  }
  const broken = original.replace(lockBlock, '').replace(discovery, `${lockBlock}\n${discovery}`);
  query(controlDb, broken);
  try { await race(controlDb, false, true); }
  finally {
    query(controlDb, original);
    if (query(controlDb, `select pg_get_functiondef('${signature}'::regprocedure);`) !== original) {
      throw new Error('positive_control_restore_failed');
    }
  }
} finally {
  for (const db of created.reverse()) {
    query('template1', `select pg_terminate_backend(pid) from pg_stat_activity
      where datname='${db}' and application_name in('auto73d_writer','auto73d_authorize');`);
    query('template1', `drop database ${db};`);
  }
}

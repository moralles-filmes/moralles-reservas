// Two sessions prove that an old Datafy /me result cannot refresh health after
// credential rotation. Run after 73a setup in a disposable networkless PG 17.
import { execFileSync, spawn } from 'node:child_process';

const container = process.env.AUTO73_CONTAINER || 'margin-template-auto-sql-pg';
const identity = execFileSync('docker', ['inspect', '--format', '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}', container], { encoding: 'utf8' }).trim();
if (identity !== 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') throw new Error('nonquarantined_postgres');
const db = 'postgres';
const unit = '73000000-0000-4000-8000-000000000011';
const channel = '73000000-0000-4000-8000-000000000041';
const args = () => ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
function query(sql) {
  return execFileSync('docker', args(), { input: sql, encoding: 'utf8', timeout: 10_000 }).trim();
}
function start(sql, marker) {
  const child = spawn('docker', args(), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const reached = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`marker_timeout ${stdout} ${stderr}`)), 10_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', code => {
      if (!stdout.includes(marker)) { clearTimeout(timeout); reject(new Error(`early_exit ${code} ${stderr}`)); }
    });
  });
  const done = new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`psql_exit ${code}: ${stderr}`))));
  child.stdin.end(sql);
  return { reached, done };
}
async function waitForLock() {
  for (let i = 0; i < 30; i++) {
    if (query(`select count(*) from pg_stat_activity where datname='postgres'
      and application_name='auto73_heartbeat' and wait_event_type='Lock';`) === '1') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('heartbeat_did_not_wait_for_rotation_lock');
}

if (query(`select template_credential_revision::text||'|'||(credentials->>'phone_number_id')
  from public.whatsapp_channels where id='${channel}';`) !== '0|7391') throw new Error('fixture_not_fresh');
query(`update public.whatsapp_channels set status='provider_error',
  last_health_check_at='2026-01-01T00:00:00Z' where id='${channel}';`);
const rotation = start(`set application_name='auto73_rotation'; begin;
  update public.whatsapp_channels
    set credentials=jsonb_set(credentials,'{access_token}','"local-rotated"'::jsonb)
    where id='${channel}';
  \\echo LOCK_HELD
  select pg_sleep(3); commit;`, 'LOCK_HELD');
await rotation.reached;
const heartbeat = start(`set application_name='auto73_heartbeat'; begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select public.record_whatsapp_template_heartbeat('${unit}','${channel}',0,'7391');
  commit;`, 'service_role');
await heartbeat.reached;
await waitForLock();
const [, heartbeatOut] = await Promise.all([rotation.done, heartbeat.done]);
if (!heartbeatOut.split(/\r?\n/).includes('f')) throw new Error(`stale_heartbeat_not_refused ${heartbeatOut}`);
const state = query(`select template_credential_revision::text||'|'||status||'|'||
  (last_health_check_at='2026-01-01T00:00:00Z'::timestamptz)::text
  from public.whatsapp_channels where id='${channel}';`);
if (state !== '1|provider_error|true') throw new Error(`stale_heartbeat_wrote_health ${state}`);
const fresh = query(`begin;
  select set_config('request.jwt.claim.role','service_role',true);
  select public.record_whatsapp_template_heartbeat('${unit}','${channel}',1,'7391');
  commit;`);
if (!fresh.split(/\r?\n/).includes('t') || query(`select status from public.whatsapp_channels where id='${channel}';`) !== 'connected') {
  throw new Error(`fresh_identity_not_recovered ${fresh}`);
}
console.log('GREEN73C rotation-first: old /me proof refused after row-lock wait; new revision can recover');

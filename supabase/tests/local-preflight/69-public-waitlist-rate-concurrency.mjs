// Disposable two-session+ race: proves the serialized limiter, then restores
// a deliberately unsafe count-then-insert body and proves the gate catches it.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalDocker } from './local-runtime-paths.mjs';

const docker = resolveLocalDocker();
const container = 'margin-phase4-rate-pg';
const image = 'public.ecr.aws/supabase/postgres:17.11.0.004';
const unit = '69000000-0000-4000-8000-000000000011';
const key = (digit) => `public-waitlist-ip:${digit.repeat(64)}`;
const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../../migrations/20261017173000_public_waitlist_serial_rate_limit.sql'), 'utf8');

function dockerText(args, input) {
  return execFileSync(docker, args, { input, encoding: 'utf8', timeout: 30_000 }).trim();
}
function psqlSync(sql) {
  return dockerText(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
}
function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`psql exit ${code}: ${error}`)));
    child.stdin.end(sql);
  });
}
async function observed(sql, label) {
  for (let i = 0; i < 70; i++) {
    if (psqlSync(sql) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FAIL69 ${label} not observed`);
}
function check(condition, label) { if (!condition) throw new Error(`FAIL69 ${label}`); }
function resultBooleans(output) { return output.split(/\r?\n/).filter((line) => line === 't' || line === 'f'); }

async function race(digit, requireLock) {
  const ip = key(digit);
  psqlSync(`delete from public.rate_limit_events where unit_id='${unit}' and phone='${ip}';`);
  const call = `select public.check_public_waitlist_rate_limit('${unit}','${ip}');`;
  const holder = psqlAsync(`begin;\nset application_name='phase4_rate_holder';\n${call}\nselect pg_sleep(7);\ncommit;`);
  await observed("select exists(select from pg_stat_activity where application_name='phase4_rate_holder' and query ilike '%pg_sleep%' and state='active')", 'holder');
  const waiters = Array.from({ length: 6 }, (_, i) =>
    psqlAsync(`set application_name='phase4_rate_waiter_${i}';\nset statement_timeout='15s';\n${call}`));
  if (requireLock) {
    await observed("select exists(select from pg_stat_activity where application_name like 'phase4_rate_waiter_%' and wait_event_type='Lock')", 'advisory lock waiter');
  }
  const [holderOutput, ...waiterOutput] = await Promise.all([holder, ...waiters]);
  const results = [holderOutput, ...waiterOutput].flatMap(resultBooleans);
  check(results.length === 7, 'all independent sessions returned');
  return { accepted: results.filter((value) => value === 't').length,
    persisted: Number(psqlSync(`select count(*) from public.rate_limit_events where unit_id='${unit}' and phone='${ip}'`)) };
}

const actualImage = dockerText(['inspect', '--format', '{{.Config.Image}}', container]);
const actualPort = dockerText(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]);
const actualHostIp = dockerText(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp}}', container]);
check(actualImage === image && actualPort === '55469' && actualHostIp === '127.0.0.1', 'disposable container identity and loopback port');

psqlSync(readFileSync(join(here, '69a-public-waitlist-rate-bootstrap.sql'), 'utf8'));
for (let i = 0; i < 3; i++) {
  psqlSync(migration);
  psqlSync(readFileSync(join(here, '69-public-waitlist-rate-limit.sql'), 'utf8'));
}
const safe = await race('a', true);
check(safe.accepted === 5 && safe.persisted === 5, 'serialized five-of-seven limit');
console.log('GREEN69 serialized race: actual lock waiter; 5 accepted, 2 refused');

// Positive control: restore the old vulnerable count-then-insert shape in this
// disposable DB only. The exact same race must exceed five, then restore the
// migration body even when the assertion fails.
const unsafe = `
create or replace function public.check_public_waitlist_rate_limit(p_unit_id uuid,p_ip_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  select count(*) into v_count from public.rate_limit_events
   where unit_id=p_unit_id and phone=p_ip_hash and created_at>=clock_timestamp()-interval '60 seconds';
  perform pg_sleep(4);
  if v_count>=5 then return false; end if;
  insert into public.rate_limit_events(phone,unit_id,created_at) values(p_ip_hash,p_unit_id,clock_timestamp());
  return true;
end $$;`;
try {
  psqlSync(unsafe);
  const control = await race('b', false);
  check(control.accepted > 5 && control.persisted > 5, 'positive control exposes count-then-insert race');
  console.log(`GREEN69 positive control: unsafe body accepted ${control.accepted}/7`);
} finally {
  psqlSync(migration);
}

// Real two-session race in the disposable, network-isolated Supabase PG image.
// Run from repository root after starting `margin-ops-alert-pg` with --network none.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalDocker } from './local-runtime-paths.mjs';

const docker = resolveLocalDocker();
const container = 'margin-ops-alert-pg';
const image = 'public.ecr.aws/supabase/postgres:17.11.0.004';
const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../../migrations/20261017190000_whatsapp_ops_email_attempts.sql'), 'utf8');
const inspect = spawnSync(docker, ['inspect', container, '--format',
  '{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{.State.Running}}|{{json .HostConfig.PortBindings}}'], { encoding: 'utf8' });
if (inspect.status !== 0 || ![`${image}|none|true|null`, `${image}|none|true|{}`].includes(inspect.stdout.trim())) {
  throw new Error('Refusing test: disposable container identity, network, or published ports do not match');
}
const db = `opsalert71c_${process.pid}`;
const run = (args, input) => {
  const result = spawnSync(docker, ['exec', ...(input === undefined ? [] : ['-i']), container, ...args],
    { input, encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const psql = (sql) => run(['psql', '-U', 'postgres', '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], sql);
const reserve = (unit, event = 'inbound_backlog_stalled') =>
  `SELECT public.reserve_whatsapp_ops_email_attempt('${unit}'::uuid,'${event}',null,null,12,now(),repeat('a',64),'ops-email-v1',repeat('b',64));\n`;
const startSession = () => {
  const child = spawn(docker, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db,
    '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const waitFor = async (needle, limitMs = 8_000) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      if (stdout.includes(needle)) return stdout;
      if (child.exitCode !== null) throw new Error(`psql ended before ${needle}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`psql did not emit ${needle}: ${stderr}`);
  };
  return { child, waitFor, output: () => stdout, send: (sql) => child.stdin.write(sql) };
};
const waitForBlockedLock = async (waiterName) => {
  for (let i = 0; i < 80; i++) {
    const result = psql(`select exists(select 1 from pg_stat_activity
      where datname = current_database()
        and application_name = '${waiterName}'
        and state = 'active'
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
        and query like '%reserve_whatsapp_ops_email_attempt%');`).trim();
    if (result === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Named second backend did not wait on the advisory lock');
};
let raceNumber = 0;
async function race(unitA, unitB, expectedB) {
  const a = startSession();
  const b = startSession();
  const tag = `ops_email_race_${++raceNumber}`;
  const waiterName = `${tag}_waiter`;
  try {
    a.send(`BEGIN;\nSET application_name = '${tag}_holder';\nSET ROLE service_role;\n` + reserve(unitA));
    await a.waitFor('"decision": "reserved"');
    b.send(`BEGIN;\nSET application_name = '${waiterName}';\nSET ROLE service_role;\n` + reserve(unitB));
    await waitForBlockedLock(waiterName);
    if (b.output().includes('"decision"')) throw new Error('Second reservation returned before first committed');
    a.send('COMMIT;\n\\q\n');
    await b.waitFor(`"decision": "${expectedB}"`);
    b.send('COMMIT;\n\\q\n');
  } finally {
    for (const session of [a, b]) {
      if (session.child.exitCode === null) {
        session.child.stdin.end();
        session.child.kill();
      }
    }
  }
}

run(['createdb', '-U', 'postgres', db]);
let testError;
let sabotageStarted = false;
let originalDefinition;
try {
  for (const file of [
    join(here, '00-bootstrap.sql'),
    join(here, '71a-whatsapp-ops-email-bootstrap.sql'),
  ]) psql(readFileSync(file, 'utf8'));
  psql(migration);

  const unitA = '70000000-0000-4000-8000-000000000011';
  await race(unitA, unitA, 'blocked');
  process.stdout.write('CONC-71-1 same pair: one reserved, one blocked after lock PASS\n');

  // The committed same-pair attempt counts as 1. Reserve 48 distinct units,
  // then race two more units for the sole remaining slot in the 50/24h cap.
  psql(`insert into public.units(organization_id,name)
    select '70000000-0000-4000-8000-000000000001', 'Race cap ' || i
    from generate_series(1,50) i;`);
  psql(`begin; set local role service_role;
    do $$ declare u record; r jsonb; n int := 0; begin
      for u in select id from public.units where name like 'Race cap %' order by name limit 48 loop
        r := public.reserve_whatsapp_ops_email_attempt(u.id,'inbound_backlog_stalled',null,
          null,12,now(),repeat('a',64),'ops-email-v1',repeat('b',64));
        if r->>'decision' is distinct from 'reserved' then raise exception 'seed cap %', r; end if;
        n := n + 1;
      end loop;
      if n is distinct from 48 then raise exception 'seed count %', n; end if;
    end $$; commit;`);
  const ids = psql("select id from public.units where name like 'Race cap %' order by name offset 48;")
    .trim().split(/\r?\n/).filter(Boolean);
  if (ids.length !== 2) throw new Error('Expected two remaining units');
  await race(ids[0], ids[1], 'blocked');
  const total = Number(psql('select count(*) from public.whatsapp_ops_email_attempts;').trim());
  if (total !== 50) throw new Error(`Global cap race wrote ${total} rows, expected 50`);
  process.stdout.write('CONC-71-2 different pairs: global cap 50 preserved PASS\n');

  // Positive control: weaken only the cap branch in the actual function body.
  // A 51st row must become possible and the budget assertion must fail. The
  // original migration is then reapplied, restoring the function definition.
  const signature = 'public.reserve_whatsapp_ops_email_attempt(uuid,text,uuid,integer,integer,timestamptz,text,text,text)';
  originalDefinition = psql(`select pg_get_functiondef('${signature}'::regprocedure);`);
  const weakenedDefinition = originalDefinition.replace(/if v_total >= 50 then/i, 'if false then');
  if (weakenedDefinition === originalDefinition) throw new Error('Cap control could not find the actual guard');
  sabotageStarted = true;
  psql(weakenedDefinition);
  const extra = psql("insert into public.units(organization_id,name) values ('70000000-0000-4000-8000-000000000001','Race cap control') returning id;").trim();
  const controlResult = psql(`set role service_role; ${reserve(extra)}`);
  if (!controlResult.includes('"decision": "reserved"')) throw new Error(`Cap sabotage did not exceed budget: ${controlResult}`);
  const violated = Number(psql('select count(*) from public.whatsapp_ops_email_attempts;').trim());
  if (violated !== 51) throw new Error(`Positive control did not produce 51 attempts: ${violated}`);
  process.stdout.write('C-71 cap guard removed: 51st reservation exposed, assertion detects it PASS\n');
} catch (error) {
  testError = error;
} finally {
  if (sabotageStarted) {
    try {
      psql(migration);
      const signature = 'public.reserve_whatsapp_ops_email_attempt(uuid,text,uuid,integer,integer,timestamptz,text,text,text)';
      const restoredDefinition = psql(`select pg_get_functiondef('${signature}'::regprocedure);`);
      if (restoredDefinition !== originalDefinition) throw new Error('Cap guard was not restored verbatim');
      process.stdout.write('C-71 original function restored by migration PASS\n');
    } catch (restoreError) {
      testError = testError
        ? new AggregateError([testError, restoreError], 'Test failed and migration restore failed')
        : restoreError;
    }
  }
  try {
    run(['dropdb', '-U', 'postgres', '--force', db]);
  } catch (cleanupError) {
    testError = testError
      ? new AggregateError([testError, cleanupError], 'Test or restore failed and disposable database cleanup failed')
      : cleanupError;
  }
}
if (testError) throw testError;

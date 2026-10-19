// Two real PostgreSQL sessions against the disposable networkless container.
// No ports, provider calls, or production connection.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveLocalDocker } from './local-runtime-paths.mjs';

const docker = resolveLocalDocker();
const container = 'margin-cutover-dedup-sql-pg-r1';
const identity = execFileSync(docker, ['inspect', '--format',
  '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}', container],
  { encoding: 'utf8', timeout: 10_000 }).trim();
if (identity !== 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') {
  throw new Error('cutover76_nonquarantined_postgres');
}
const ids = Object.fromEntries(['org','unit','customer','admin','channel','reservationA','reservationB']
  .map((name) => [name, randomUUID()]));
const { org, unit, customer, admin, channel, reservationA, reservationB } = ids;
function labeledValue(output, label) {
  const matches = output.split(/\r?\n/).filter((line) => line.startsWith(`${label}:`));
  if (matches.length !== 1) throw new Error(`expected exactly one ${label} row: ${output}`);
  return matches[0].slice(label.length + 1);
}
async function waitForAdvisoryLock(applicationName, sessionB) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (sessionB.finished) throw new Error(`${applicationName}: second session finished before lock evidence: ${sessionB.output}`);
    const observed = execFileSync(docker,
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
      { input: `select coalesce(wait_event_type,'')||':'||coalesce(wait_event,'') from pg_stat_activity where datname='postgres' and application_name='${applicationName}';\n`,
        encoding: 'utf8', timeout: 10_000 }).trim();
    if (observed === 'Lock:advisory') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${applicationName}: advisory lock wait not observed`);
}

function session(sql = '', { hold = false } = {}) {
  const p = spawn(docker, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1']);
  let output = '';
  let error = '';
  let finished = false;
  const waiters = [];
  p.stdout.on('data', (chunk) => {
    output += chunk.toString();
    for (const w of [...waiters]) if (output.includes(w.text)) { w.resolve(); waiters.splice(waiters.indexOf(w), 1); }
  });
  p.stderr.on('data', (chunk) => { error += chunk.toString(); });
  const done = new Promise((resolve, reject) => p.on('close', (code) => {
    finished = true;
    if (code === 0) resolve(output); else reject(new Error(`psql ${code}: ${error}\n${output}`));
  }));
  if (sql) p.stdin.write(sql);
  if (!hold) p.stdin.end();
  return { p, done, get output() { return output; }, get finished() { return finished; },
    waitFor(text) { return new Promise((resolve, reject) => {
      if (output.includes(text)) return resolve();
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}: ${error}\n${output}`)), 8000);
      waiters.push({ text, resolve: () => { clearTimeout(timer); resolve(); } });
    }); },
  };
}

const checked = await session(`
select case when current_database()='postgres'
  and current_setting('server_version_num')::integer >= 170000
  and not exists(select from cron.job where jobname in ('whatsapp-automation-worker','whatsapp-template-workers'))
  and not exists(select from net.http_request_queue) then 'LOCAL_OK' else 'UNSAFE' end;
`).done;
if (!checked.includes('LOCAL_OK')) throw new Error('Database quarantine not proven');

await session(`
insert into auth.users(id) values('${admin}');
insert into public.platform_admins(user_id) values('${admin}');
insert into public.organizations(id,name) values('${org}','Cutover76 concurrent');
insert into public.units(id,organization_id,name,slug) values('${unit}','${org}','Cutover76','cutover76-${unit}');
insert into public.customers(id,organization_id,name,phone,do_not_contact,deleted_at)
  values('${customer}','${org}','Cutover76','11999997602',false,null);
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,webhook_secret)
  values('${channel}','${unit}','zapi','connected',true,clock_timestamp(),'local-only');
insert into public.reservations(id,unit_id,customer_id,date,time,status,source,party_size,reservation_code)
  values('${reservationA}','${unit}','${customer}',(clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00','confirmed','web',2,'C76-${reservationA}'),
    ('${reservationB}','${unit}','${customer}',(clock_timestamp() at time zone 'America/Sao_Paulo')::date+1,'20:00','confirmed','web',2,'C76-${reservationB}');
`).done;

for (const [name, resource, secondSql, resultLabel] of [
  ['same_fact', reservationA,
    `select 'CLAIM_RESULT:' || public.claim_whatsapp_legacy_automation_post('confirmation','${reservationA}','${channel}',0,'send-confirmation')::text;`,
    'CLAIM_RESULT'],
  ['adoption_vs_claim', reservationB,
    `select set_config('request.jwt.claim.role','authenticated',false);
     select set_config('request.jwt.claim.sub','${admin}',false);
     select 'ADOPTION_RESULT:' || coalesce(public.release_whatsapp_template_channel('${channel}','dispatch',true,0,null)::text,'null');`,
    'ADOPTION_RESULT'],
]) {
  const a = session(`begin;
set local lock_timeout='5s';
select 'FIRST_CLAIM_RESULT:' || public.claim_whatsapp_legacy_automation_post('confirmation','${resource}','${channel}',0,'send-confirmation')::text;
select 'A_CLAIMED';
`, { hold: true });
  await a.waitFor('A_CLAIMED');
  const first = JSON.parse(labeledValue(a.output, 'FIRST_CLAIM_RESULT'));
  if (first.allowed !== true || !first.intent_id || !first.fence) throw new Error(`${name}: first claim failed: ${a.output}`);
  const applicationName = `cutover76_${name}_${randomUUID().slice(0, 8)}`;
  const b = session(`set application_name='${applicationName}';\nset lock_timeout='5s';\n${secondSql}\n`);
  await waitForAdvisoryLock(applicationName, b);
  a.p.stdin.end('commit;\n');
  await a.done;
  const observed = await b.done;
  const result = labeledValue(observed, resultLabel);
  if (name === 'same_fact') {
    const claim = JSON.parse(result);
    if (claim.allowed !== false || claim.reason !== 'intent_owned') throw new Error(`${name}: unexpected result: ${observed}`);
  } else if (result !== 'false') {
    throw new Error(`${name}: unexpected result: ${observed}`);
  }
  process.stdout.write(`${name}: PASS (second session waited; ${resultLabel}=${result})\n`);
}

// One WABA is organization-scoped. Two distinct units must enable through
// their own binding/tenant guard without a cross-unit deadlock or adoption leak.
const shared = Object.fromEntries(['unitA','unitB','channelA','channelB','account'].map((key) => [key, randomUUID()]));
const wabaId = `7${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`)}`;
const phoneA = `76${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 8)}`)}`;
const phoneB = `76${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 8)}`)}`;
await session(`
insert into public.units(id,organization_id,name,slug) values
  ('${shared.unitA}','${org}','Shared WABA A','cutover76-${shared.unitA}'),
  ('${shared.unitB}','${org}','Shared WABA B','cutover76-${shared.unitB}');
insert into public.whatsapp_channels(id,unit_id,provider,status,is_active,last_health_check_at,credentials,webhook_secret)
  values('${shared.channelA}','${shared.unitA}','datafy','connected',true,clock_timestamp(),'{"phone_number_id":"${phoneA}"}'::jsonb,'local-only'),
    ('${shared.channelB}','${shared.unitB}','datafy','connected',true,clock_timestamp(),'{"phone_number_id":"${phoneB}"}'::jsonb,'local-only');
insert into public.whatsapp_template_accounts(id,organization_id,waba_id,verified_at)
  values('${shared.account}','${org}','${wabaId}',clock_timestamp());
insert into public.whatsapp_template_bindings(unit_id,channel_id,account_id,provider,verified_at)
  values('${shared.unitA}','${shared.channelA}','${shared.account}','datafy',clock_timestamp()),
    ('${shared.unitB}','${shared.channelB}','${shared.account}','datafy',clock_timestamp());
`).done;

function sharedSession(label) {
  return session(`begin;\nset local lock_timeout='5s';
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','${admin}',true);
select 'READY_${label}';\n`, { hold: true });
}
const sharedA = sharedSession('A');
const sharedB = sharedSession('B');
await Promise.all([sharedA.waitFor('READY_A'), sharedB.waitFor('READY_B')]);
const enableSql = (channelId) => `select 'ENABLE_RESULT:' || coalesce(public.release_whatsapp_template_channel('${channelId}',
  'dispatch',true,0,(select generation from public.whatsapp_template_bindings where channel_id='${channelId}'))::text,'null');\ncommit;\n`;
sharedA.p.stdin.end(enableSql(shared.channelA));
sharedB.p.stdin.end(enableSql(shared.channelB));
const [enabledA, enabledB] = await Promise.all([sharedA.done, sharedB.done]);
if (labeledValue(enabledA, 'ENABLE_RESULT') !== 'true' || labeledValue(enabledB, 'ENABLE_RESULT') !== 'true') {
  throw new Error(`shared WABA enable failed: A=${enabledA} B=${enabledB}`);
}
const sharedState = await session(`select 'SHARED_STATE:' || jsonb_build_object(
  'adoptions',(select count(*) from public.whatsapp_automation_adoptions where unit_id in ('${shared.unitA}','${shared.unitB}')),
  'bindings',(select count(*) from public.whatsapp_template_bindings where account_id='${shared.account}'
    and dispatch_enabled=true and unit_id in ('${shared.unitA}','${shared.unitB}')),
  'accounts',(select count(distinct account_id) from public.whatsapp_template_bindings
    where unit_id in ('${shared.unitA}','${shared.unitB}'))
)::text;`).done;
const state = JSON.parse(labeledValue(sharedState, 'SHARED_STATE'));
if (state.adoptions !== 2 || state.bindings !== 2 || state.accounts !== 1) {
  throw new Error(`shared WABA tenant state mismatch: ${sharedState}`);
}
process.stdout.write('shared_waba_two_units: PASS (two concurrent enables; two unit adoptions; one organization account)\n');

// Local PostgreSQL only. Two real sessions: B must block on A's uncommitted
// WABA reservation before A is allowed to commit. No provider or production.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const executable = process.argv[2] ?? 'C:/Program Files/PostgreSQL/18/bin/psql.exe';
const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55463', '-U', 'postgres', '-d', 'task7_datafy'];
const u1 = 'bbbbbbbb-0063-0000-0000-000000000011', u2 = 'bbbbbbbb-0063-0000-0000-000000000012';
const u3 = 'bbbbbbbb-0063-0000-0000-000000000013';
const org1 = 'aaaaaaaa-0000-0000-0000-000000000001', org2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const wabas = ['63911', '63912', '63913', '63914', '63915'];
function session(sql, name = 'local63', keepOpen = false) {
  const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGAPPNAME: name } });
  let output = '', error = '';
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyReject = reject;
    child.stdout.on('data', (chunk) => {
      output += String(chunk); if (output.includes('READY63')) resolve();
    });
  });
  child.stderr.on('data', (chunk) => { error += String(chunk); });
  const done = new Promise((resolve, reject) => {
    child.on('error', (failure) => { if (keepOpen) readyReject(failure); reject(failure); });
    child.on('exit', (code) => {
      if (keepOpen && !output.includes('READY63')) readyReject(new Error(`session did not reach barrier: ${error}`));
      resolve({ code, output, error });
    });
  });
  if (keepOpen) child.stdin.write(sql); else child.stdin.end(sql);
  return { child, ready, done };
}
async function query(sql) {
  const r = await session(sql).done;
  assert.equal(r.code, 0, r.error); return r.output.trim();
}
const channel = (unit, waba, phone) => `insert into public.whatsapp_channels(unit_id,provider,credentials) values('${unit}','datafy','{"business_account_id":"${waba}","phone_number_id":"${phone}"}');`;
const account = (org, waba) => `insert into public.whatsapp_template_accounts(organization_id,waba_id) values('${org}','${waba}');`;
async function race(label, sqlA, sqlB, expectedCode) {
  const a = session(`begin; ${sqlA} select 'READY63';\n`, 'local63a', true);
  let b;
  const timeout = setTimeout(() => { a.child.kill(); b?.child.kill(); }, 15_000);
  try {
    await a.ready;
    b = session(`begin; ${sqlB} commit;`, 'local63b');
    let blocked = false;
    for (let i = 0; i < 30; i++) {
      blocked = await query("select exists(select from pg_stat_activity where application_name='local63b' and wait_event_type='Lock');") === 't';
      if (blocked) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(blocked, `${label}: B never waited on A`);
    a.child.stdin.end('commit;\n');
    assert.equal((await a.done).code, 0);
    const result = await b.done;
    assert.equal(result.code, expectedCode, result.error);
    if (expectedCode) assert.match(result.error, /waba_organization_conflict/);
    console.log(`${label}: B blocked on A, result=${expectedCode ? 'PT409' : 'accepted'}`);
  } finally { clearTimeout(timeout); a.child.kill(); b?.child.kill(); }
}
try {
  await query(`insert into public.units(id,organization_id,name) values('${u1}','${org1}','local63-race-a'),('${u2}','${org2}','local63-race-b'),('${u3}','${org1}','local63-race-a2');`);
  await race('cross-org channel/channel', channel(u1, wabas[0], '6391101'), channel(u2, wabas[0], '6391102'), 3);
  await race('same-org two units', channel(u1, wabas[1], '6391201'), channel(u3, wabas[1], '6391202'), 0);
  await race('template/channel cross-org', account(org1, wabas[2]), channel(u2, wabas[2], '6391302'), 3);
  await race('channel/template cross-org', channel(u1, wabas[3], '6391401'), account(org2, wabas[3]), 3);
  assert.equal(await query(`select count(*) from public.whatsapp_channels where unit_id in ('${u1}','${u2}','${u3}');`), '4');
  assert.equal(await query(`select count(*) from public.whatsapp_channels where unit_id='${u2}';`), '0');
  // Backfill rejects a contradiction that predates the guard, and rolls back
  // every DDL/data change in that failed migration transaction.
  const migration = readFileSync(new URL('../../migrations/20261014170540_datafy_existing_subscription_claim.sql', import.meta.url), 'utf8');
  const badBackfill = await session(`begin; alter table public.whatsapp_channels disable trigger guard_whatsapp_channel_waba_owner;
    ${channel(u1, wabas[4], '6391501')} ${channel(u2, wabas[4], '6391502')} ${migration} commit;`).done;
  assert.equal(badBackfill.code, 3); assert.match(badBackfill.error, /waba_organization_conflict/);
  assert.equal(await query(`select count(*) from public.whatsapp_waba_owners where waba_id='${wabas[4]}';`), '0');
  console.log('backfill conflict: fail-closed, transaction rolled back');
} finally {
  await query(`delete from public.whatsapp_template_accounts where waba_id in (${wabas.map((w) => `'${w}'`).join(',')});
    delete from public.whatsapp_channels where unit_id in ('${u1}','${u2}','${u3}');
    delete from public.whatsapp_waba_owners where waba_id in (${wabas.map((w) => `'${w}'`).join(',')});
    delete from public.units where id in ('${u1}','${u2}','${u3}');`);
}

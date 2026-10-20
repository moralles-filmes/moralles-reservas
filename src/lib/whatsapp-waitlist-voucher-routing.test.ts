// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { selectWaitlistAutomationRoute } from '../../supabase/functions/_shared/whatsapp-automation-producer-routing';
import { catalogHash, TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';

const fixtures: ReturnType<typeof createAutomationFixture>[] = [];
function fixture(kind: 'birthday' | 'frequency' | 'entered' | 'feedback' = 'birthday', nowISO?: string) {
  const f = createAutomationFixture({ nowISO }); fixtures.push(f);
  const p = f.producer();
  Object.assign(f.rows.customers[0], { birthday: '1990-10-05' });
  Object.assign(f.rows.reservations[0], { date: '2026-10-04' });
  f.rows.voucher_rules.push({ id: p.ruleId, unit_id: f.ids.unit, trigger_type: kind === 'frequency' ? 'frequency' : 'birthday',
    discount_percent: 15, validity_days: 30, visits_required: kind === 'frequency' ? 1 : null,
    days_window: kind === 'frequency' ? 30 : null, active: true, min_rating: null,
    name:'Synthetic Task11',created_at:f.nowISO,updated_at:f.nowISO });
  if (kind === 'entered' || kind === 'feedback') {
    f.rows.waitlist.push({ id: f.ids.reservation, unit_id: f.ids.unit, customer_id: f.ids.customer,
      customer_phone: '55912345678', customer_name: 'Marina', party_size: 4, code: 12,
      status: kind === 'entered' ? 'waiting' : 'seated', created_at: '2026-10-05T14:30:00Z',
      seated_at: kind === 'feedback' ? '2026-10-04T15:00:00Z' : null,
      notified_at: null, notified_server_at: null });
  }
  return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) {
  const p=f.producer(); p.harness.dispose(); expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
} });

describe('actual waitlist and voucher Request producers', () => {
  it('current birthday INSERT uses atomic issuer and dispatches only its returned existing job', async () => {
    const f = fixture(), p = f.producer();
    await f.runVoucherProducer();
    expect(p.trace.filter(x => x.name === 'issue_scheduled_whatsapp_voucher')).toHaveLength(1);
    const hop = p.harness.internalRequests.find(x => x.to === 'send-scheduled-whatsapp');
    expect(hop).toBeDefined();
    expect(await hop!.request.json()).toEqual({ action: 'dispatch_existing', job_id: p.row.id });
    expect(p.writes.voucherInsertCount).toBe(1); expect(f.calls.legacyText).toBe(0);
    expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
  it.each(['waitlist_entered','waitlist_feedback'] as const)('%s invokes the actual scheduled endpoint with only resource provenance', async kind => {
    const f = fixture(kind === 'waitlist_entered' ? 'entered' : 'feedback'), p = f.producer();
    await f.runWaitlistProducer(kind);
    const hop = p.harness.internalRequests.find(x => x.to === 'send-scheduled-whatsapp');
    expect(hop).toBeDefined();
    expect(await hop!.request.json()).toEqual({ action: 'dispatch', kind, unit_id: f.ids.unit,
      resource_id: f.ids.reservation, ...(kind === 'waitlist_feedback' ? { target_date: '2026-10-04' } : {}) });
    expect(f.calls.legacyText).toBe(0); expect(p.unexpected).toEqual([]); p.harness.assertNoUnexpectedIo();
  });
});

describe('issuer source boundary and unchanged benefit arithmetic', () => {
  const sql = () => readFileSync('supabase/migrations/20261009003452_whatsapp_scheduled_voucher_issuer.sql','utf8');
  it('rejects an invalid fixture clock and retains the original default', () => {
    expect(() => createAutomationFixture({nowISO:'invalid'})).toThrow('fixture_invalid_clock');
    const f=fixture(); expect(f.nowISO).toBe('2026-10-05T15:00:00Z');
  });
  it('keeps the only conflict handler around INSERT and final clock after every relation read', () => {
    const source = sql();
    expect(source).toContain('create or replace function public.issue_scheduled_whatsapp_voucher(');
    expect(source).toMatch(/for update;[\s\S]*for share;[\s\S]*v_issued := date_trunc\('milliseconds', clock_timestamp\(\)\)/);
    expect(source).toMatch(/exception when unique_violation then\s+return;\s+end;\s+v_job_id := public.enqueue_whatsapp_automation/);
    const final = source.slice(source.indexOf('v_final_day :='));
    expect(final).toContain('voucher_selection_day_changed');
    expect(final).not.toMatch(/\b(select|insert|update|delete|perform)\b/i);
    expect(source.match(/exception when unique_violation/g)).toHaveLength(1);
    expect(source).toContain("interval '168 hours'");
  });
  it.each([
    ['2026-01-31T02:59:59.999Z',1,'2026-02-01T02:59:59.999Z'],
    ['2026-01-31T03:00:00.000Z',1,'2026-02-02T02:59:59.999Z'],
    ['2024-02-28T12:00:00.000Z',1,'2024-03-01T02:59:59.999Z'],
    ['2025-02-28T12:00:00.000Z',1,'2025-03-02T02:59:59.999Z'],
    ['2026-12-31T12:00:00.000Z',1,'2027-01-02T02:59:59.999Z'],
    ['2026-10-05T12:34:56.789Z',30,'2026-11-05T02:59:59.999Z'],
    ['2026-03-07T12:00:00.000Z',1,'2026-03-09T02:59:59.999Z'],
  ])('actual legacy producer INSERT preserves expiry boundary %s', async (fact, days, expiry) => {
    const f=fixture('birthday',String(fact)),p=f.producer(); p.controls.adopted=false;
    const day=new Date(Date.parse(String(fact))-3*60*60*1000).toISOString().slice(0,10);
    f.rows.customers[0].birthday=`1990-${day.slice(5)}`;
    f.rows.voucher_rules[0].validity_days=Number(days);
    const body=await (await f.runVoucherProducer()).json();
    expect(body.birthday_issued).toBe(1); expect(p.writes.voucherInsertCount).toBe(1);
    expect(f.rows.vouchers[0].expires_at).toBe(expiry);
    expect(p.trace.some(x=>x.name==='issue_scheduled_whatsapp_voucher')).toBe(false);
  });
});

describe('real producer refusal and preserved branches', () => {
  it('does not report acceptance for a different returned job', async () => {
    const f=fixture(), p=f.producer();
    p.responseScripts.push({from:'process-voucher-triggers',to:'send-scheduled-whatsapp',reply:() => Response.json({
      state:'accepted',pinPhase:'bound',jobId:'00000000-0000-4000-8000-000000009999'})});
    await f.runVoucherProducer();
    expect(p.harness.logs.some(x => x.includes('"accepted":true'))).toBe(false);
  });
  it.each(['birthday','frequency'] as const)('%s returns exact rule assertions and accepts once', async kind => {
    const f=fixture(kind), p=f.producer(); const response=await f.runVoucherProducer();
    expect((await response.json())[`${kind}_issued`]).toBe(1);
    const call=p.trace.find(x=>x.name==='issue_scheduled_whatsapp_voucher')!;
    expect(call.args.p_expected_rule).toEqual({unit_id:f.ids.unit,trigger_type:kind,discount_percent:15,validity_days:30,
      visits_required:kind==='frequency'?1:null,days_window:kind==='frequency'?30:null,selected_brt_day:'2026-10-05'});
    expect(p.row.initial_catalog_key).toBe('mkt_voucher_programado_v1');
    expect(f.calls.post).toBe(1); expect(f.calls.legacyText).toBe(0);
    expect(p.writes.deletedVoucherIds).toEqual([]);
  });
  it.each(['zero','error','malformed'] as const)('issuer %s never sends, rereads a winner or reissues', async mode => {
    const f=fixture(), p=f.producer(); p.controls.issuer=mode;
    const response=await f.runVoucherProducer(); const body=await response.json();
    expect(body.birthday_issued).toBe(0); expect(body.errors.join()).toContain(mode==='zero'?'duplicate':mode==='error'?'atomic_issuance_failed':'atomic_provenance_unavailable');
    expect(p.harness.internalRequests).toHaveLength(0); expect(f.calls.post+f.calls.legacyText).toBe(0);
    expect(p.queries.filter(x=>x.table==='vouchers' && x.columns==='*')).toHaveLength(0);
    expect(p.writes.deletedVoucherIds).toEqual([]);
  });
  it.each(['birthday','frequency'] as const)('%s giftback OFF retains only original voucher', async kind => {
    const f=fixture(kind), p=f.producer(); f.rows.settings.push({unit_id:f.ids.unit,key:'giftback_whatsapp_enabled',value:false});
    expect((await (await f.runVoucherProducer()).json())[`${kind}_issued`]).toBe(1);
    expect(p.trace.some(x=>x.name==='issue_scheduled_whatsapp_voucher')).toBe(false);
    expect(p.writes.voucherInsertCount).toBe(1); expect(p.harness.internalRequests).toHaveLength(0);
  });
  it.each(['birthday','frequency'] as const)('%s original suspension asymmetry remains', async kind => {
    const f=fixture(kind), p=f.producer(); p.controls.enforcement=true; p.controls.serviceSuspended=true;
    const body=await (await f.runVoucherProducer()).json();
    expect(body[`${kind}_issued`]).toBe(kind==='birthday'?1:0);
    expect(body[kind==='birthday'?'send_suppressed':'skipped_suspended']).toBe(1);
    expect(p.writes.voucherInsertCount).toBe(kind==='birthday'?1:0); expect(p.harness.internalRequests).toHaveLength(0);
  });
  it.each(['birthday','frequency'] as const)('%s never-adopted retains existing text path', async kind => {
    const f=fixture(kind), p=f.producer(); p.controls.adopted=false; p.controls.bindingEnabled=false;
    await f.runVoucherProducer(); expect(p.trace.some(x=>x.name==='issue_scheduled_whatsapp_voucher')).toBe(false);
    expect(p.writes.voucherInsertCount).toBe(1); expect(f.calls.legacyText).toBe(1); expect(f.calls.post).toBe(0);
    const forwarded = p.harness.internalRequests.find(hop => hop.to === 'send-whatsapp');
    expect(await forwarded!.request.json()).toMatchObject({ kind: 'voucher_issued', voucher_id: f.rows.vouchers[0].id });
    expect(p.trace.find(call => call.name === 'claim_whatsapp_legacy_automation_post')).toMatchObject({ args: {
      p_kind: 'voucher_issued', p_resource_id: f.rows.vouchers[0].id, p_origin: 'send-whatsapp' } });
  });
  it.each(['settings','organizations','whatsapp_automation_adoptions'])('adopted required %s error remains dependency', async table => {
    const f=fixture(),p=f.producer(); p.controls.queryError=table;
    const response=await f.runVoucherProducer(); expect((await response.json()).birthday_issued).toBe(0);
    expect(p.writes.voucherInsertCount).toBe(0); expect(f.calls.post+f.calls.legacyText).toBe(0);
  });
  it.each(['flag','consent','expired','erased','foreign'] as const)('post-INSERT %s refusal retains benefit and never reissues on dispatcher retry', async change => {
    const f=fixture(),p=f.producer(); p.controls.afterIssuer=()=>{
      if(change==='flag') p.controls.flag=false;
      if(change==='consent') p.controls.consent='opt_out';
      if(change==='expired') f.rows.vouchers[0].expires_at='2026-10-05T14:59:59Z';
      if(change==='erased') f.rows.customers[0].deleted_at=f.nowISO;
      if(change==='foreign') f.rows.customers[0].organization_id=f.ids.foreignUnit;
    };
    await f.runVoucherProducer(); expect(f.calls.post).toBe(0); expect(p.writes.voucherInsertCount).toBe(1);
    await p.harness.request('send-scheduled-whatsapp',new Request('https://fixture.supabase.invalid/functions/v1/send-scheduled-whatsapp',{
      method:'POST',headers:{'Content-Type':'application/json','x-internal-key':'synthetic-internal'},
      body:JSON.stringify({action:'dispatch_existing',job_id:p.row.id})}));
    expect(p.writes.voucherInsertCount).toBe(1); expect(p.writes.deletedVoucherIds).toEqual([]);
    expect(p.trace.filter(x=>x.name==='issue_scheduled_whatsapp_voucher')).toHaveLength(1);
  });
  it.each(['birthday','feedback'] as const)('%s PENDING official template blocks actual dispatcher while preserving original intent', async kind => {
    const f=fixture(kind),p=f.producer();const logical=kind==='birthday'?'mkt_voucher_programado_v1':'fila_feedback_v1';
    const hash=await catalogHash(TEMPLATE_CATALOG[logical]);
    const account='88888888-0000-4000-8000-000000000001',template='99999999-0000-4000-8000-000000000001';
    Object.assign(p.row,{provider:'official',transport:'template',account_id:account,remote_template_id:template,
      template_version:1,sync_epoch:3,initial_catalog_key:logical});
    p.tables.whatsapp_remote_templates=[{id:template,account_id:account,logical_id:logical,name:logical,version:1,language:'pt_BR',
      desired_hash:hash,observed_hash:hash,requested_category:'MARKETING',effective_category:'MARKETING',quality:'GREEN',local_status:'usable',
      remote_status:'PENDING',sync_required:false,last_synced_at:f.nowISO,remote_id:'native-template',sync_epoch:3}];
    if(kind==='birthday')await f.runVoucherProducer();else await f.runWaitlistProducer('waitlist_feedback');
    expect(p.row.error_code).toBe('template_unavailable');expect(f.calls.post+f.calls.legacyText).toBe(0);
    expect(p.writes.voucherInsertCount).toBe(kind==='birthday'?1:0);expect(p.writes.deletedVoucherIds).toEqual([]);
  });
  it('valid supplied preconfiguration result preserves voucher without accepting or falling back', async () => {
    const f=fixture(),p=f.producer();p.controls.afterIssuer=()=>Object.assign(p.row,{pin_phase:'preconfiguration',
      channel_id:null,provider:null,binding_id:null,binding_generation:null,transport:null,account_id:null,remote_template_id:null,
      template_version:null,sync_epoch:null,initial_credential_revision:null,initial_catalog_key:'mkt_voucher_programado_v1',state:'blocked',error_code:'channel_unconfigured'});
    await f.runVoucherProducer();expect(p.writes.voucherInsertCount).toBe(1);expect(f.calls.post+f.calls.legacyText).toBe(0);
    expect(p.row.pin_phase).toBe('preconfiguration');expect(p.harness.logs.some(x=>x.includes('"accepted":true'))).toBe(false);
  });
  it('frequency refuses mixed original Date anchors with no INSERT or fallback', async () => {
    const f=fixture('frequency'), p=f.producer();
    await p.harness.advanceTime(Date.parse('2026-10-06T02:59:59Z')-p.harness.now);
    p.controls.onQuery=(table,columns)=>{if(table==='units'&&columns==='organization_id') void p.harness.advanceTime(2000);};
    const body=await (await f.runVoucherProducer()).json();
    expect(body.errors.join()).toContain('selection_day_changed'); expect(p.writes.voucherInsertCount).toBe(0);
    expect(p.harness.internalRequests).toHaveLength(0);
  });
  it.each(['future','outside','cancelled','insufficient','cooldown'] as const)('frequency original %s selector prevents issuance', async change => {
    const f=fixture('frequency'),p=f.producer();
    if(change==='future')f.rows.reservations[0].date='2026-10-06';
    if(change==='outside')f.rows.reservations[0].date='2026-08-01';
    if(change==='cancelled')f.rows.reservations[0].status='cancelled';
    if(change==='insufficient')f.rows.voucher_rules[0].visits_required=2;
    if(change==='cooldown')f.rows.vouchers.push({...p.voucher,status:'used',issued_at:'2026-10-01T12:00:00Z'});
    await f.runVoucherProducer(); expect(p.writes.voucherInsertCount).toBe(0); expect(p.harness.internalRequests).toHaveLength(0);
  });
  it.each(['different_day','no_visit','no_phone','cooldown','after_rating'] as const)('birthday original %s selector prevents issuance', async change => {
    const f=fixture(),p=f.producer();
    if(change==='different_day')f.rows.customers[0].birthday='1990-10-06';
    if(change==='no_visit')f.rows.reservations.length=0;
    if(change==='no_phone')f.rows.customers[0].phone='';
    if(change==='cooldown')f.rows.vouchers.push({...p.voucher,status:'used',issued_at:'2026-01-01T12:00:00Z'});
    if(change==='after_rating'){f.rows.voucher_rules[0].trigger_type='after_rating';f.rows.voucher_rules[0].min_rating=5;}
    await f.runVoucherProducer(); expect(p.writes.voucherInsertCount).toBe(0); expect(p.harness.internalRequests).toHaveLength(0);
  });
  it('birthday leap day continues to select February 28 in a non-leap year', async () => {
    const f=fixture(),p=f.producer(); f.rows.customers[0].birthday='2000-02-29';
    await p.harness.advanceTime(Date.parse('2027-02-28T12:00:00Z')-p.harness.now);
    await f.runVoucherProducer(); expect(p.trace.find(x=>x.name==='issue_scheduled_whatsapp_voucher')?.args.p_expected_rule)
      .toMatchObject({selected_brt_day:'2027-02-28'});
  });
});

describe('waitlist actual requests and exact routing', () => {
  it.each(['entered','feedback'] as const)('%s preserves text editor, current links and DDD55', async kind => {
    const f=fixture(kind),p=f.producer();
    p.tables.waitlist_message_templates=[{unit_id:f.ids.unit,event:kind,customized:true,body:'Olá {{cliente_nome}} #{{codigo_fila}} {{link_status}}'}];
    await f.runWaitlistProducer(kind==='entered'?'waitlist_entered':'waitlist_feedback');
    expect(f.calls.post).toBe(1); expect(f.calls.legacyText).toBe(0);
    const sent=p.requests.find(x=>typeof x.message==='string')!;
    expect(sent.phone).toBe('5555912345678');
    expect(sent.message).toContain(kind==='entered'?`/acompanhar/${f.ids.reservation}`:'/r/exemplo');
    expect(sent.message).toContain('Olá Marina #12');
    expect(p.row.waitlist_id).toBe(f.ids.reservation); expect(p.row.reservation_id).toBeNull();
  });
  it.each(['entered','feedback'] as const)('%s paused gate never falls back or counts acceptance', async kind => {
    const f=fixture(kind),p=f.producer(); p.controls.flag=false;
    const body=await (await f.runWaitlistProducer(kind==='entered'?'waitlist_entered':'waitlist_feedback')).json();
    expect(body.dispatched).toBe(kind==='entered'?false:0); expect(f.calls.post+f.calls.legacyText).toBe(0);
  });
  it.each(['entered','feedback'] as const)('%s never-adopted original legacy path stays usable', async kind => {
    const f=fixture(kind),p=f.producer(); p.controls.adopted=false;p.controls.bindingEnabled=false;
    await f.runWaitlistProducer(kind==='entered'?'waitlist_entered':'waitlist_feedback');
    expect(f.calls.legacyText).toBe(1);expect(f.calls.post).toBe(0);
  });
  it.each(['status','code','foreign_customer','erased','dnc','phone','slug'] as const)('feedback current %s refuses stale selected row', async change => {
    const f=fixture('feedback'),p=f.producer();
    if(change==='status')f.rows.waitlist[0].status='waiting';
    if(change==='code')f.rows.waitlist[0].code=null;
    if(change==='foreign_customer')f.rows.customers[0].organization_id=f.ids.foreignUnit;
    if(change==='erased')f.rows.customers[0].deleted_at=f.nowISO;
    if(change==='dnc')f.rows.customers[0].do_not_contact=true;
    if(change==='phone')f.rows.waitlist[0].customer_phone='11912345678';
    if(change==='slug')f.rows.units[0].slug=null;
    await f.runWaitlistProducer('waitlist_feedback'); expect(f.calls.post+f.calls.legacyText).toBe(0);
    expect(p.queries.filter(x=>x.table==='customers' && x.patch!==null)).toHaveLength(0);
  });
  it.each(['entered','feedback'] as const)('%s unknown customer is never fabricated', async kind => {
    const f=fixture(kind),p=f.producer(); f.rows.waitlist[0].customer_id=null; f.rows.customers.length=0; p.row.customer_id=null;
    await f.runWaitlistProducer(kind==='entered'?'waitlist_entered':'waitlist_feedback');
    expect(f.calls.post).toBe(kind==='entered'?1:0);expect(f.rows.customers).toEqual([]);
  });
  it.each(['process-waitlist-entered','process-waitlist-feedback','process-voucher-triggers'] as const)('%s retains internal auth and OPTIONS', async endpoint => {
    const f=fixture(),p=f.producer();
    expect((await p.harness.request(endpoint,new Request(`https://fixture.supabase.invalid/functions/v1/${endpoint}`,{method:'OPTIONS'}))).status).toBe(204);
    expect((await p.harness.request(endpoint,new Request(`https://fixture.supabase.invalid/functions/v1/${endpoint}`,{method:'POST',body:'{}'}))).status).toBe(401);
    expect(p.queries).toHaveLength(0);expect(p.trace).toHaveLength(0);
  });
  it('entered malformed body stays a 400 and makes no SQL call', async () => {
    const f=fixture('entered'),p=f.producer();
    const result=await p.harness.request('process-waitlist-entered',new Request('https://fixture.supabase.invalid/functions/v1/process-waitlist-entered',{
      method:'POST',headers:{'x-internal-key':'synthetic-internal'},body:'{'}));
    expect(result.status).toBe(400);expect(p.queries).toHaveLength(0);
  });
  it('entered retry finds accepted ledger despite changed volatile settings and preserves original fact', async () => {
    const f=fixture('entered'),p=f.producer();await f.runWaitlistProducer('waitlist_entered');
    const original=p.row.fact_at;const enqueues=p.trace.filter(x=>x.name==='enqueue_whatsapp_automation').length;
    p.controls.flag=false;f.rows.waitlist[0].status='seated';f.rows.settings.push({unit_id:f.ids.unit,key:'waitlist_entered_enabled',value:false});
    const result=await (await f.runWaitlistProducer('waitlist_entered')).json();
    expect(result.dispatched).toBe(true);expect(f.calls.post).toBe(1);expect(p.row.fact_at).toBe(original);
    expect(p.trace.filter(x=>x.name==='enqueue_whatsapp_automation')).toHaveLength(enqueues);
    expect(await p.harness.internalRequests.at(-1)!.request.json()).toEqual({action:'dispatch_existing',job_id:p.row.id});
  });
  it('exact existing accepted ledger precedes all volatile route reads', async () => {
    const f=fixture('entered'),p=f.producer();
    Object.assign(p.row,{kind:'waitlist_entered',reservation_id:null,waitlist_id:f.ids.reservation,voucher_id:null,state:'accepted'});
    const calls:string[]=[];
    const result=await selectWaitlistAutomationRoute(async (table,_columns,predicates)=>{
      calls.push(table);expect(predicates).toEqual([['unit_id',f.ids.unit],['waitlist_id',f.ids.reservation],['kind','waitlist_entered']]);return p.row;
    },{kind:'waitlist_entered',unitId:f.ids.unit,waitlistId:f.ids.reservation});
    expect(result).toEqual({path:'managed',existingJobId:p.row.id,selection:'scheduled'}); expect(calls).toEqual(['whatsapp_automation_jobs']);
  });
  it.each(['wrong_unit','wrong_resource','malformed','query_error'] as const)('exact route %s is dependency', async change => {
    const f=fixture('entered'),p=f.producer();Object.assign(p.row,{kind:'waitlist_entered',reservation_id:null,waitlist_id:f.ids.reservation});
    if(change==='wrong_unit')p.row.unit_id=f.ids.foreignUnit;
    if(change==='wrong_resource')p.row.waitlist_id=f.ids.foreignUnit;
    if(change==='malformed')p.row.state='made_up';
    expect(await selectWaitlistAutomationRoute(async ()=>{if(change==='query_error')throw new Error('fixture');return p.row;},
      {kind:'waitlist_entered',unitId:f.ids.unit,waitlistId:f.ids.reservation})).toEqual({path:'dependency'});
  });
});

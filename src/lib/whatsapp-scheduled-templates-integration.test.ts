// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { chatSdkMessage, createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';

const fixtures: ReturnType<typeof createAutomationFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) {
  expect(f.chatCalls.sendTemplate).toBe(0); expect(f.chatCalls.enqueueAutomation).toBe(0);
  f.chat().harness.dispose();
} });
function fixture() { const f = createAutomationFixture(); fixtures.push(f); return f; }
function tool(name: string,input: Record<string,unknown>) { return chatSdkMessage([{ type:'tool_use',id:'synthetic-tool',name,input }],'tool_use'); }
function ratingFixture() {
  const f = fixture(), c = f.chat();
  c.tables.notifications_sent.push({ id:'survey-own',unit_id:c.ids.unit,reservation_id:c.ids.reservation,kind:'survey_d1',status:'sent',sent_at:'2026-10-05T14:00:00Z' });
  c.tables.voucher_rules.push({ id:'synthetic-rule',unit_id:c.ids.unit,trigger_type:'after_rating',active:true,min_rating:4,
    discount_percent:15,validity_days:30,created_at:'2026-01-01',visits_required:null,days_window:null });
  return { f,c };
}

it('atendimento continua respondendo texto pelo Request real', async () => {
  const f = fixture();
  await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
  expect(f.chatCalls.sendText).toBe(1);
  expect(f.chatCalls.sendTemplate).toBe(0);
  expect(f.chatCalls.enqueueAutomation).toBe(0);
  expect(f.chatCalls.llm).toBe(1);
  expect(f.chat().tables.conversations[0].messages).toEqual([
    expect.objectContaining({ author:'customer',role:'user',content:'Quero reservar',event_id:'wa-in:datafy:wamid.synthetic-incoming',timestamp:'2026-10-05T15:00:00.000Z' }),
    expect.objectContaining({ author:'ai',role:'assistant',content:'Posso ajudar com sua reserva.' }),
  ]);
  expect(f.chat().tables.conversations[0].ai_lock_token).toBeNull();
});

it('observa opções reais do SDK, cache, ferramentas e a mesma identidade do AbortSignal', async () => {
  const f=fixture(),c=f.chat(); let options: unknown;
  c.controls.beforeSdk = async (_input,actualOptions) => { options=actualOptions; };
  await f.runChatControl({ kind:'customer_text',text:'Olá' });
  expect(c.sdk.constructors).toEqual([{ apiKey:'synthetic-byok',maxRetries:2 }]);
  expect(c.sdk.requests[0].options).toBe(options);
  expect(options).toMatchObject({ signal:expect.any(AbortSignal) });
  expect(c.sdk.requests[0].input).toMatchObject({ system:[{ type:'text',cache_control:{ type:'ephemeral' } }],
    tools:expect.arrayContaining([expect.objectContaining({ name:'create_reservation' }),expect.objectContaining({ name:'request_human_handoff' })]) });
});

it('handoff executa ferramenta real, propaga tool_result e libera o lock', async () => {
  const f=fixture(),c=f.chat(); c.controls.sdkResponses=[tool('request_human_handoff',{ reason:'Cliente pediu atendente' }),chatSdkMessage([{ type:'text',text:'Um atendente vai responder em breve.' }])];
  await f.runChatControl({ kind:'customer_text',text:'Quero falar com alguém' });
  expect(c.tables.conversations[0]).toMatchObject({ status:'awaiting_human',handoff_reason:'Cliente pediu atendente',ai_lock_token:null });
  expect(c.calls.llm).toBe(2); expect(c.calls.sendText).toBe(1);
  expect(c.sdk.requests[1].input).toMatchObject({ messages:expect.arrayContaining([expect.objectContaining({ role:'user',content:expect.arrayContaining([expect.objectContaining({ type:'tool_result',tool_use_id:'synthetic-tool',content:expect.stringContaining('Transferência registrada') })]) })]) });
  expect(c.trace.at(-1)?.operation).toBe('rpc:release_conversation_ai_claim');
});

it('observação de reserva passa pela ferramenta real sem criar job', async () => {
  const f=fixture(),c=f.chat(); c.controls.sdkResponses=[tool('update_reservation',{ reservation_code:'RES123',notes:'Mesa tranquila' }),chatSdkMessage()];
  await f.runChatControl({ kind:'customer_text',text:'Anote que prefiro uma mesa tranquila' });
  expect(c.tables.reservations[0].notes).toBe('Mesa tranquila');
  expect(c.calls.llm).toBe(2); expect(c.calls.sendText).toBe(1);
});

it('retry antes de ferramenta mutante ocorre uma vez e depois responde', async () => {
  const f=fixture(),c=f.chat(); c.controls.sdkResponses=[new Error('synthetic SDK transport failed'),chatSdkMessage()];
  await f.runChatControl({ kind:'customer_text',text:'Olá' });
  expect(c.calls.llm).toBe(2); expect(c.sdk.constructors).toHaveLength(2);
  expect(c.tables.conversations[0].status).toBe('ai_active'); expect(c.calls.sendText).toBe(1);
});

it('erro após ferramenta mutante não repete a ferramenta e transfere para humano', async () => {
  const f=fixture(),c=f.chat(); c.controls.sdkResponses=[tool('update_reservation',{ reservation_code:'RES123',notes:'Uma alteração' }),new Error('synthetic SDK transport failed')];
  await f.runChatControl({ kind:'customer_text',text:'Anote uma alteração' });
  expect(c.calls.llm).toBe(2); expect(c.sdk.constructors).toHaveLength(1);
  expect(c.queries.filter(q=>q.table==='reservations' && q.operation==='update')).toHaveLength(1);
  expect(c.tables.conversations[0]).toMatchObject({ status:'awaiting_human',ai_lock_token:null });
});

it.each([false,true])('deadline só interrompe a próxima rodada na fila: queue=%s',async queue => {
  const f=fixture(),c=f.chat();
  c.tables.whatsapp_channels[0].async_ingestion_enabled=queue;
  c.tables.platform_flags.find(row=>row.key==='whatsapp_async_ingestion')!.value=queue;
  c.controls.sdkResponses=[tool('list_customer_reservations',{}),chatSdkMessage()];
  c.controls.beforeSdk=async()=>{ if(c.calls.llm===1) await c.harness.advanceTime(31000); };
  await f.runChatControl({ kind:'customer_text',text:'Quais são minhas reservas?' });
  expect(c.calls.llm).toBe(queue?1:2);
  expect(c.tables.conversations[0].status).toBe(queue?'awaiting_human':'ai_active');
  expect(c.harness.pendingBackground).toBe(0);
  if(queue) {
    expect(c.tables.whatsapp_inbound_events).toHaveLength(1);
    expect(c.tables.whatsapp_inbound_events[0].status).toBe('done');
    expect(c.tables.conversations[0].handoff_reason).toEqual(expect.stringContaining('agent_deadline:'));
  }
});

it('eco Coexistence preserva autor/evento/tempo humano e não roda IA nem cria cliente',async()=>{
  const f=fixture(),c=f.chat(); c.tables.conversations[0].ai_lock_token='previous-lock';
  await f.runChatControl({ kind:'human_echo',text:'A equipe assumiu',messageId:'wamid.human' });
  const call=c.trace.find(row=>row.operation==='rpc:record_whatsapp_human_message');
  expect(call?.value).toMatchObject({ p_unit_id:c.ids.unit,p_message:{ author:'human',role:'human',content:'A equipe assumiu',event_id:'wa-own:datafy:wamid.human',timestamp:'2026-10-05T15:00:00.000Z' } });
  expect(c.tables.conversations[0]).toMatchObject({ status:'human_active',ai_lock_token:null });
  expect(c.calls.llm).toBe(0); expect(c.calls.sendText).toBe(0); expect(c.tables.customers).toHaveLength(1);
  await f.runChatControl({ kind:'human_echo',text:'A equipe assumiu',messageId:'wamid.human' });
  expect(c.trace.filter(row=>row.operation==='rpc:record_whatsapp_human_message')).toHaveLength(1);
});

it.each(['ai_active','human_active','awaiting_human'])('mídia preserva mensagem e respeita handoff %s',async status=>{
  const f=fixture(),c=f.chat();c.tables.conversations[0].status=status;
  await f.runChatControl({ kind:'media',unnamed:true });
  expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(status==='ai_active'?1:0);
  expect(c.tables.conversations[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ author:'customer',content:'[áudio]' })]));
});

it.each(['billing','service'])('bloqueio %s mantém inbound sem nome e sem IA/envio',async gate=>{
  const f=fixture(),c=f.chat();
  if(gate==='billing') c.tables.organizations[0].billing_status='blocked';
  else {
    c.tables.platform_flags[0].value=true;
    c.tables.organization_entitlement_overrides.push({ organization_id:c.ids.organization,feature:'whatsapp',
      enabled:false,starts_at:'2026-10-01T00:00:00Z',ends_at:null,revoked_at:null });
  }
  await f.runChatControl({ kind:'customer_text',text:'Olá sem nome',unnamed:true });
  expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(0);
  expect(c.tables.conversations[0].messages).toEqual([expect.objectContaining({ author:'customer',content:'Olá sem nome' })]);
  expect(c.tables.webhook_executions[0].outcome).toBe(gate==='billing'?'org_billing_blocked':'whatsapp_service_suspended');
});

it.each([200,503])('after_rating grava nota antes do envio e só emite benefício após aceite: HTTP%s',async status=>{
  const {f,c}=ratingFixture();c.controls.sendStatus=status;
  await f.runChatControl({kind:'customer_text',text:'5'});
  expect(c.tables.reservations[0].satisfaction_rating).toBe(5);expect(c.calls.llm).toBe(0);
  expect(c.tables.vouchers).toHaveLength(status===200?1:0);
  expect(c.tables.notifications_sent.at(-1)).toMatchObject({kind:'voucher_issued',status:status===200?'sent':'failed',unit_id:c.ids.unit});
  const sequence=c.trace.map(row=>row.operation);
  expect(sequence.indexOf('update:reservations')).toBeLessThan(sequence.indexOf('provider:post'));
  if(status===200) {
    expect(sequence.indexOf('provider:post')).toBeLessThan(sequence.indexOf('insert:vouchers'));
    const sent=c.trace.find(row=>row.operation==='provider:post')?.value;
    expect(sent).toMatchObject({type:'text',text:{body:expect.stringContaining(String(c.tables.vouchers[0].code))}});
    expect(c.tables.conversations[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({author:'automation'})]));
  }
});

it.each(['min_rating','existing','23505','XX000'])('after_rating mantém controle %s sem voucher duplicado',async control=>{
  const {f,c}=ratingFixture();
  if(control==='min_rating') c.tables.voucher_rules[0].min_rating=5;
  else if(control==='existing') c.tables.vouchers.push({id:'existing',unit_id:c.ids.unit,customer_id:c.ids.customer,rule_id:'synthetic-rule',status:'active'});
  else c.controls.voucherInsertError=control;
  await f.runChatControl({kind:'customer_text',text:'4'});
  expect(c.tables.vouchers).toHaveLength(control==='existing'?1:0);
  expect(c.calls.sendText).toBe(1);
  expect(c.tables.notifications_sent.filter(row=>row.kind==='voucher_issued')).toHaveLength(control==='23505'?1:0);
});

it('comentário próprio persiste e responde sem IA',async()=>{
  const f=fixture(),c=f.chat();Object.assign(c.tables.reservations[0],{satisfaction_rating:5,satisfaction_at:'2026-10-05T14:50:00Z'});
  await f.runChatControl({kind:'customer_text',text:'Foi ótimo'});
  expect(c.tables.reservations[0].satisfaction_comment).toBe('Foi ótimo');expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(1);
});

it('callback correlaciona quatro campos e não abre conversa nem IA',async()=>{
  const f=fixture(),c=f.chat();const own={id:'notification',unit_id:c.ids.unit,whatsapp_provider:'datafy',whatsapp_channel_id:c.ids.channel,provider_message_id:'wamid.synthetic-reply',read_at:null,delivered_at:null};
  c.tables.notifications_sent.push(own,{...own,id:'unit',unit_id:c.ids.foreignUnit},{...own,id:'provider',whatsapp_provider:'official'},{...own,id:'channel',whatsapp_channel_id:'other'},{...own,id:'message',provider_message_id:'other'});
  await f.runChatControl({kind:'receipt'});
  expect(own.read_at).not.toBeNull();expect(c.tables.notifications_sent.slice(1).every(row=>row.read_at===null)).toBe(true);
  expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(0);expect(c.tables.conversations[0].messages).toEqual([]);
});

it('gestão WABA assinado persiste evento sanitizado sem cliente/histórico',async()=>{
  const f=fixture(),c=f.chat();await f.runChatControl({kind:'management'});
  expect(c.trace.some(row=>row.operation==='rpc:record_whatsapp_template_events_fenced')).toBe(true);
  expect(c.queries.some(q=>['customers','conversations'].includes(q.table))).toBe(false);
  expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(0);
});

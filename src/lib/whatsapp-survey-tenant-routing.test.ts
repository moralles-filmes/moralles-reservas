// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';

const fixtures: ReturnType<typeof createAutomationFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.chat().harness.dispose(); });
function fixture() {
  const f = createAutomationFixture(); fixtures.push(f);
  const c = f.chat();
  // A and B really share an organization and customer; C belongs to another
  // organization with a distinct customer row using exactly the same phone.
  const foreignOrg='aaaaaaaa-0000-4000-8000-000000000002';
  const foreignOrgUnit='bbbbbbbb-0000-4000-8000-000000000004';
  const foreignOrgCustomer='cccccccc-0000-4000-8000-000000000002';
  const otherCustomerId='cccccccc-0000-4000-8000-000000000003';
  c.tables.organizations.push({...c.tables.organizations[0],id:foreignOrg});
  c.tables.units.push({...c.tables.units[0],id:c.ids.foreignUnit,name:'Unidade B mesma organização',slug:'survey-b'},
    {...c.tables.units[0],id:foreignOrgUnit,organization_id:foreignOrg,name:'Unidade C outra organização',slug:'survey-c'});
  c.tables.customers.push({...c.tables.customers[0],id:foreignOrgCustomer,organization_id:foreignOrg,name:'Mesmo telefone em outra organização'},
    {...c.tables.customers[0],id:otherCustomerId,phone:'11988887766',name:'Outro cliente da organização'});
  const own = c.tables.reservations[0];
  const foreign: Record<string, unknown> = { ...own, id: 'eeeeeeee-0000-4000-8000-000000000002', unit_id: c.ids.foreignUnit };
  c.tables.reservations.push(foreign);
  c.tables.notifications_sent.push(
    { id: 'survey-own', unit_id: c.ids.unit, reservation_id: own.id, kind: 'survey_d1', status: 'sent', sent_at: '2026-10-05T13:00:00Z' },
    { id: 'survey-foreign', unit_id: c.ids.foreignUnit, reservation_id: foreign.id, kind: 'survey_d1', status: 'sent', sent_at: '2026-10-05T14:00:00Z' },
  );
  return { f,c,own,foreign,foreignOrg,foreignOrgUnit,foreignOrgCustomer,otherCustomerId };
}

it('Request do canal A avalia a pesquisa própria, mesmo com pesquisa B mais recente do mesmo cliente da organização', async () => {
  const { f,c,own,foreign } = fixture();
  expect((await f.runChatControl({ kind: 'customer_text', text: '5' })).status).toBe(200);
  expect(c.calls.llm).toBe(0);
  expect(c.calls.sendText).toBe(1);
  expect(foreign.satisfaction_rating).toBeNull();
  expect(own.satisfaction_rating).toBe(5);
});

it.each(['notification','resource'])('recusa decoy cujo %s pertence à outra unidade independentemente', async mismatch => {
  const { f,c,own,foreign } = fixture();
  const decoy = c.tables.notifications_sent[1];
  if (mismatch === 'notification') {
    const secondOwn = { ...own, id: 'eeeeeeee-0000-4000-8000-000000000003' };
    c.tables.reservations.push(secondOwn); decoy.reservation_id = secondOwn.id;
  } else decoy.unit_id = c.ids.unit;
  await f.runChatControl({ kind: 'customer_text', text: '5' });
  expect(own.satisfaction_rating).toBe(5);
  expect(c.tables.reservations.slice(1).every(row => row.satisfaction_rating === null)).toBe(true);
  expect(foreign.satisfaction_rating).toBeNull();
});

it('somente pesquisa estrangeira segue o atendimento normal da IA', async () => {
  const { f,c,foreign } = fixture(); c.tables.notifications_sent.shift();
  await f.runChatControl({ kind: 'customer_text', text: '5' });
  expect(foreign.satisfaction_rating).toBeNull();
  expect(c.calls.llm).toBe(1); expect(c.calls.sendText).toBe(1);
  expect(c.tables.webhook_executions[0].outcome).toBe('success');
});

it.each(['unit_id','customer_id'])('rating recusa reassignment de %s durante await antes do UPDATE', async column => {
  const { f,c,own } = fixture(); c.tables.notifications_sent.pop();
  c.controls.beforeQuery = async query => {
    if (query.table === 'reservations' && query.operation === 'update' && 'satisfaction_rating' in query.patch!) {
      await Promise.resolve(); own[column] = column==='unit_id'?c.ids.foreignUnit:'cccccccc-0000-4000-8000-000000000003';
    }
  };
  const response = await f.runChatControl({ kind: 'customer_text', text: '5' });
  expect(response.status).toBe(500);
  expect(own.satisfaction_rating).toBeNull(); expect(c.calls.sendText).toBe(0); expect(c.tables.vouchers).toHaveLength(0);
  expect(c.tables.conversations[0].messages).toEqual([expect.objectContaining({ author: 'customer',content: '5' })]);
  expect(c.queries.find(query => query.operation === 'update' && query.table === 'reservations')?.matched).toEqual([]);
});

it.each(['unit_id','customer_id'])('comment recusa reassignment de %s durante await antes do UPDATE', async column => {
  const { f,c,own } = fixture();
  Object.assign(own,{ satisfaction_rating: 5,satisfaction_at: '2026-10-05T14:50:00Z' });
  c.controls.beforeQuery = async query => {
    if (query.table === 'reservations' && query.operation === 'update' && 'satisfaction_comment' in query.patch!) {
      await Promise.resolve(); own[column] = column==='unit_id'?c.ids.foreignUnit:'cccccccc-0000-4000-8000-000000000003';
    }
  };
  expect((await f.runChatControl({ kind: 'customer_text',text: 'Excelente atendimento' })).status).toBe(500);
  expect(own.satisfaction_comment).toBeNull(); expect(c.calls.sendText).toBe(0); expect(c.tables.vouchers).toHaveLength(0);
  expect(c.tables.conversations[0].messages).toEqual([expect.objectContaining({ author: 'customer',content: 'Excelente atendimento' })]);
});

it('seleciona a pesquisa válida própria mais recente e ignora outro cliente', async () => {
  const { f,c,own,otherCustomerId } = fixture();
  const ownNewer: Record<string, unknown> = { ...own,id: 'eeeeeeee-0000-4000-8000-000000000003' };
  const otherCustomer: Record<string, unknown> = { ...own,id: 'eeeeeeee-0000-4000-8000-000000000004',customer_id: otherCustomerId };
  c.tables.reservations.push(ownNewer,otherCustomer);
  c.tables.notifications_sent.push(
    { ...c.tables.notifications_sent[0],id:'survey-newer',reservation_id:ownNewer.id,sent_at:'2026-10-05T14:20:00Z' },
    { ...c.tables.notifications_sent[0],id:'survey-other-customer',reservation_id:otherCustomer.id,sent_at:'2026-10-05T14:30:00Z' },
  );
  await f.runChatControl({ kind:'customer_text',text:'4' });
  expect(ownNewer.satisfaction_rating).toBe(4); expect(own.satisfaction_rating).toBeNull(); expect(otherCustomer.satisfaction_rating).toBeNull();
});

it('Request resolve o cliente pela organização do canal mesmo com telefone igual e pesquisa mais recente em outra organização',async()=>{
  const {f,c,own,foreignOrg,foreignOrgUnit,foreignOrgCustomer}=fixture();
  const foreignOrgReservation={...own,id:'eeeeeeee-0000-4000-8000-000000000005',unit_id:foreignOrgUnit,customer_id:foreignOrgCustomer,satisfaction_rating:null};
  c.tables.reservations.push(foreignOrgReservation);
  c.tables.notifications_sent.push({...c.tables.notifications_sent[0],id:'survey-foreign-org',unit_id:foreignOrgUnit,
    reservation_id:foreignOrgReservation.id,sent_at:'2026-10-05T14:40:00Z'});
  expect(c.tables.customers.find(row=>row.id===foreignOrgCustomer)).toMatchObject({organization_id:foreignOrg,phone:c.tables.customers[0].phone});
  await f.runChatControl({kind:'customer_text',text:'5'});
  expect(own.satisfaction_rating).toBe(5);expect(foreignOrgReservation.satisfaction_rating).toBeNull();
  expect(c.tables.conversations[0].customer_id).toBe(c.ids.customer);
  expect(c.queries.filter(query=>query.table==='customers'&&query.operation==='select')
    .some(query=>query.filters.some(([op,key,value])=>op==='eq'&&key==='organization_id'&&value===c.ids.organization))).toBe(true);
  expect(c.calls.llm).toBe(0);expect(c.calls.sendText).toBe(1);
});

// Mutate the actual query at its I/O boundary, after the real handler constructs
// it. Each mutant demonstrates that removing one predicate breaks the matching
// behavioral invariant; no copied survey decision or source-text assertion.
it.each(['unit_id','reservations.unit_id'])('sensibilidade: remover o filtro de leitura %s quebra seleção própria', async column => {
  const { f,c,own } = fixture();
  if (column === 'unit_id') {
    const secondOwn = { ...own,id:'eeeeeeee-0000-4000-8000-000000000003' };
    c.tables.reservations.push(secondOwn);
    c.tables.notifications_sent[1].reservation_id=secondOwn.id;
  } else c.tables.notifications_sent[1].unit_id=c.ids.unit;
  let removed=0;
  c.controls.beforeQuery=async query=>{
    if(query.table==='notifications_sent' && query.columns.includes('reservations!inner(')) {
      const index=query.filters.findIndex(([op,key])=>op==='eq'&&key===column);
      expect(index).toBeGreaterThanOrEqual(0);query.filters.splice(index,1);removed++;
    }
  };
  await f.runChatControl({kind:'customer_text',text:'5'});
  expect(removed).toBe(1);
  expect(()=>expect(own.satisfaction_rating).toBe(5)).toThrow();
  expect(own.satisfaction_rating).toBeNull();
});

it.each([
  ['rating','unit_id'],['rating','customer_id'],['comment','unit_id'],['comment','customer_id'],
])('sensibilidade: remover %s UPDATE.%s permite escrita após reassignment',async (kind,column)=>{
  const { f,c,own }=fixture();c.tables.notifications_sent.pop();
  const field=kind==='rating'?'satisfaction_rating':'satisfaction_comment';
  if(kind==='comment') Object.assign(own,{satisfaction_rating:5,satisfaction_at:'2026-10-05T14:50:00Z'});
  let removed=0;
  c.controls.beforeQuery=async query=>{
    if(query.table==='reservations'&&query.operation==='update'&&field in query.patch!) {
      await Promise.resolve();own[column]=column==='unit_id'?c.ids.foreignUnit:'cccccccc-0000-4000-8000-000000000003';
      const index=query.filters.findIndex(([op,key])=>op==='eq'&&key===column);
      expect(index).toBeGreaterThanOrEqual(0);query.filters.splice(index,1);removed++;
    }
  };
  const text=kind==='rating'?'5':'Excelente atendimento';
  const response=await f.runChatControl({kind:'customer_text',text});
  expect(removed).toBe(1);
  expect(()=>expect(response.status).toBe(500)).toThrow();
  expect(response.status).toBe(200);expect(own[field]).toBe(kind==='rating'?5:text);
  expect(c.calls.sendText).toBe(1);
});

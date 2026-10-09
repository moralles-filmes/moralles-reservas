import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { inspectTemplateEventFamilies, sanitizeTemplateEvents, validateTemplateEventBatch } from '../../supabase/functions/_shared/whatsapp-template-events-core';
import { createTemplateEventService, type TemplateEventAuthority, type TemplateEventDependencies } from '../../supabase/functions/_shared/whatsapp-template-events-core';
import { splitMetaWebhookPayloadCore } from '../../supabase/functions/_shared/whatsapp-meta-batch-core';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));

const identity = { wabaId: 'waba-a', phoneNumberId: 'phone-a' };
const management = { field: 'message_template_status_update', value: {
  message_template_id: 1713142233297685, message_template_name: 'aviso_agendamento',
  message_template_language: 'pt_BR', event: 'APPROVED',
} };
const batch = (changes: unknown[], id = 'waba-a') => ({
  object: 'whatsapp_business_account', entry: [{ id, changes }],
});
const chat = (field = 'messages', phone = 'phone-a') => ({ field, value: {
  metadata: { phone_number_id: phone }, ...(field === 'smb_message_echoes' ? { message_echoes: [] } : { messages: [] }),
} });
const event = (value: Record<string, unknown> = {}, field = management.field) => ({
  field, value: { ...management.value, ...value },
});
const catalog = [{ remote_id: '1713142233297685', name: 'aviso_agendamento', language: 'pt_BR' }];
const observedAt = '2026-10-04T12:00:00.000Z';
async function sanitized(value: Record<string, unknown> = {}, field = management.field, time?: unknown) {
  const payload = { ...batch([event(value, field)]), entry: [{ ...batch([]).entry[0], time, changes: [event(value, field)] }] };
  const validated = validateTemplateEventBatch(payload, identity);
  expect(validated.ok).toBe(true);
  return (await sanitizeTemplateEvents(validated.management, catalog, observedAt))[0];
}

describe('identidade de cada família antes de efeitos', () => {
  it('aceita gestão WABA exclusiva sem metadata.phone_number_id', () => {
    const result = validateTemplateEventBatch(batch([management]), identity);
    expect(result.ok).toBe(true);
    expect(result.management).toHaveLength(1);
  });
  it('mensagem alheia não usa a identidade WABA para passar', () => {
    const payload = batch([management, { field: 'messages', value: {
      metadata: { phone_number_id: 'phone-b' }, messages: [],
    } }]);
    expect(validateTemplateEventBatch(payload, identity).ok).toBe(false);
  });
  it.each(['messages', 'smb_message_echoes'])('valida número de cada irmão %s', field => {
    expect(validateTemplateEventBatch(batch([management, chat(field)]), identity).ok).toBe(true);
    expect(validateTemplateEventBatch(batch([management, chat(field, 'phone-b')]), identity).ok).toBe(false);
  });
  it('preserva metadados originais de mensagem e eco válidos no lote misto', () => {
    const message = { id: 'wamid.msg', from: '5511999999999', type: 'text', timestamp: '1789008423', text: { body: 'Olá' } };
    const echo = { id: 'wamid.echo', to: '5511999999999', type: 'text', timestamp: '1789008424', text: { body: 'Resposta humana' } };
    const changes = [management, { field: 'messages', value: { metadata: { phone_number_id: 'phone-a' }, messages: [message] } },
      { field: 'smb_message_echoes', value: { metadata: { phone_number_id: 'phone-a' }, message_echoes: [echo] } }];
    const payload = batch(changes); const before = JSON.stringify(payload);
    expect(validateTemplateEventBatch(payload, identity)).toMatchObject({ ok: true, hasChat: true });
    expect(JSON.stringify(payload)).toBe(before);
    expect(JSON.stringify(splitMetaWebhookPayloadCore(payload))).toContain(JSON.stringify(message));
    expect(JSON.stringify(splitMetaWebhookPayloadCore(payload))).toContain(JSON.stringify(echo));
  });
  it.each([null, [], {}, { field: 'messages', value: {} }, { field: 'messages', value: { metadata: { phone_number_id: 'phone-a' }, messages: [null] } },
    { field: 'messages', value: { metadata: { phone_number_id: 'phone-a' }, messages: [{}] } },
    { field: 'smb_message_echoes', value: { metadata: { phone_number_id: 'phone-a' }, message_echoes: [], messages: [{}] } },
    { field: 'unknown', value: {} }, { field: 'messages', value: [] }])('recusa irmão malformado %j sem gestão parcial', sibling => {
    expect(validateTemplateEventBatch(batch([management, sibling]), identity)).toMatchObject({ ok: false, management: [] });
  });
  it('recusa outra WABA, segunda entry malformada e root falso', () => {
    expect(validateTemplateEventBatch(batch([management], 'waba-b'), identity).ok).toBe(false);
    expect(validateTemplateEventBatch({ ...batch([management]), entry: [...batch([management]).entry, null] }, identity).ok).toBe(false);
    expect(validateTemplateEventBatch({ ...batch([management]), object: 'other' }, identity).ok).toBe(false);
  });
  it.each([undefined, null, {}, true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1e3', '01', ' 12', 't1', '1'.repeat(513)])('recusa ID remoto inválido %j', id => {
    expect(validateTemplateEventBatch(batch([event({ message_template_id: id })]), identity).ok).toBe(false);
  });
  it.each([{ message_template_name: {} }, { message_template_name: 'has spaces' }, { message_template_name: 'x'.repeat(513) },
    { message_template_language: null }, { message_template_language: 'pt-BR' }, { message_template_element: {} }])('recusa identidade/conteúdo mal tipado %j', value => {
    expect(validateTemplateEventBatch(batch([event(value, 'message_template_components_update')]), identity).ok).toBe(false);
  });
  it('recusa lote maior que a transação SQL permite', () => {
    expect(validateTemplateEventBatch(batch(Array(101).fill(management)), identity).ok).toBe(false);
  });
});

describe('normalização restritiva e privacidade', () => {
  it('número seguro e tolerância decimal produzem ID técnico e mesmo digest', async () => {
    const a = await sanitized(); const b = await sanitized({ message_template_id: '1713142233297685' });
    expect(a.remote_id).toBe('1713142233297685'); expect(a.digest).toBe(b.digest);
    expect(a.name).toBeNull(); expect(a.remote_status).toBeNull();
  });
  it.each(['PAUSED', 'DISABLED', 'REJECTED'])('identidade verificada carrega %s imediatamente', async status => {
    expect((await sanitized({ event: status })).remote_status).toBe(status);
  });
  it.each([
    { message_template_id: 999, message_template_language: 'es' },
    { message_template_language: 'es' }, { message_template_id: 999 },
    { message_template_name: 'outro_nome' }, { message_template_name: undefined }, { message_template_language: undefined },
  ])('identidade não verificada só invalida: %j', async value => {
    const result = await sanitized({ ...value, event: 'PAUSED', new_quality_score: 'RED' });
    expect(result).toMatchObject({ name: null, language: null, remote_status: null, quality: null, effective_category: null });
    expect((await sanitized({ ...value, new_quality_score: 'RED' }, 'message_template_quality_update')).quality).toBeNull();
  });
  it('usa event e new_quality_score; ignora aliases e fatos permissivos', async () => {
    expect((await sanitized({ event: undefined, status: 'PAUSED' })).remote_status).toBeNull();
    expect((await sanitized({ event: 'APPROVED' })).remote_status).toBeNull();
    expect((await sanitized({ event: 'NEW_UNKNOWN_STATE' })).remote_status).toBeNull();
    expect((await sanitized({ previous_quality_score: 'RED', new_quality_score: 'GREEN' }, 'message_template_quality_update')).quality).toBeNull();
    expect((await sanitized({ previous_quality_score: 'GREEN', new_quality_score: 'RED' }, 'message_template_quality_update')).quality).toBe('RED');
  });
  it('mantém papéis de categorias no digest sem inventar precedência', async () => {
    const a = await sanitized({ new_category: 'UTILITY', correct_category: 'MARKETING' }, 'template_category_update');
    const b = await sanitized({ new_category: 'MARKETING', correct_category: 'UTILITY' }, 'template_category_update');
    expect(a.effective_category).toBeNull(); expect(b.effective_category).toBeNull(); expect(a.digest).not.toBe(b.digest);
  });
  it('não persiste conteúdo, motivo, token, nome nem PII; componente só diferencia digest', async () => {
    const a = await sanitized({ message_template_element: 'Contato privado 11999999999', reason: 'private reason', token: 'private token' }, 'message_template_components_update');
    const b = await sanitized({ message_template_element: 'Outro texto privado' }, 'message_template_components_update');
    expect(a.digest).not.toBe(b.digest);
    expect(JSON.stringify(a)).not.toMatch(/Contato|11999999999|private|aviso_agendamento|element|reason|token/);
    expect(Object.keys(a).sort()).toEqual(['digest', 'effective_category', 'event_time', 'field', 'language', 'name', 'quality', 'remote_id', 'remote_status']);
    expect((await sanitized({ reason: 'first' })).digest).toBe((await sanitized({ reason: 'second', token: 'anything' })).digest);
  });
  it.each([undefined, null, '1789008423', {}, 1.5, Number.MAX_SAFE_INTEGER,
    253402300800, -62198755200, -62167219200])('timestamp ausente/incompatível usa recebimento fora do digest %j', async time => {
    const payload = { ...batch([management]), entry: [{ ...batch([management]).entry[0], time }] };
    const parsed = validateTemplateEventBatch(payload, identity).management;
    const a = (await sanitizeTemplateEvents(parsed, catalog, observedAt))[0];
    const b = (await sanitizeTemplateEvents(parsed, catalog, '2026-10-05T12:00:00Z'))[0];
    expect(a.event_time).toBe(observedAt); expect(a.digest).toBe(b.digest);
  });
  it('preserva horário remoto válido, inclusive evento velho; relógio não aprova', async () => {
    const a = await sanitized({ event: 'PAUSED' }, management.field, 1000000000);
    expect(a.event_time).toBe('2001-09-09T01:46:40.000Z'); expect(a.remote_status).toBe('PAUSED');
    expect(a.digest).not.toBe((await sanitized({ event: 'PAUSED' }, management.field, 1000000001)).digest);
  });
});

const channel = { id: 'channel-a', unit_id: 'unit-a', provider: 'datafy', phoneNumberId: 'phone-a' };
function fixture() {
  const authority: TemplateEventAuthority = { accountId: 'account-a', wabaId: 'waba-a', organizationId: 'org-a', unitOrganizationId: 'org-a',
    channelId: channel.id, unitId: channel.unit_id, provider: channel.provider, phoneNumberId: channel.phoneNumberId,
    verifiedAt: observedAt, credentialRevision: 0, bindingCredentialRevision: 0,
    bindingId: 'binding-a', bindingGeneration: 1, accountGeneration: 1 };
  const deps: TemplateEventDependencies = { loadAuthority: vi.fn(async () => authority), loadCatalog: vi.fn(async () => catalog), persistTemplateEvents: vi.fn(async () => {}) };
  return { authority, deps, service: createTemplateEventService(deps) };
}
describe('factory usada pelo webhook: barreira durável antes de ACK', () => {
  it.each([chat(), chat('smb_message_echoes'), { field: 'messages', value: { metadata: { phone_number_id: 'phone-a' }, statuses: [{ id: 'msg', status: 'read' }] } }])('atendimento sem gestão não consulta binding/catalog/flag %j', async part => {
    const { deps, service } = fixture();
    expect(await service.process(batch([part], 'any-waba'), channel, observedAt)).toEqual({ kind: 'chat' });
    for (const io of Object.values(deps)) expect(io).not.toHaveBeenCalled();
  });
  it('recusa família desconhecida sem consulta de gestão nem efeito', async () => {
    const { deps, service } = fixture();
    expect(inspectTemplateEventFamilies(batch([{ field: 'unknown', value: {} }]))).toBe('unsupported');
    expect(await service.process(batch([{ field: 'unknown', value: {} }]), channel, observedAt)).toMatchObject({ status: 401 });
    for (const io of Object.values(deps)) expect(io).not.toHaveBeenCalled();
  });
  it.each([batch([management, chat('messages', 'phone-b')]), batch([management], 'wrong-waba'), batch([management, null])])('lote inválido inteiro não lê catálogo nem persiste %j', async payload => {
    const { deps, service } = fixture();
    expect(await service.process(payload, channel, observedAt)).toEqual({ kind: 'refused', status: 401, reason: 'template_batch_invalid' });
    expect(deps.loadCatalog).not.toHaveBeenCalled(); expect(deps.persistTemplateEvents).not.toHaveBeenCalled();
  });
  it.each([{ verifiedAt: null }, { credentialRevision: 1 }, { unitId: 'other' }, { channelId: 'other' }, { provider: 'other' }, { unitOrganizationId: 'other' }, { phoneNumberId: 'other' }, { bindingId: '' }, { bindingGeneration: 0 }, { accountGeneration: Number.MAX_SAFE_INTEGER + 1 }])('binding indisponível/corrente inválido é503 sem efeitos %j', async patch => {
    const { authority, deps, service } = fixture(); Object.assign(authority, patch);
    expect(await service.process(batch([management]), channel, observedAt)).toMatchObject({ status: 503, reason: 'template_dependency_unavailable' });
    expect(deps.loadCatalog).not.toHaveBeenCalled(); expect(deps.persistTemplateEvents).not.toHaveBeenCalled();
  });
  it('rotação antes de reconciliar é503 e binding corrente recupera gestão', async () => {
    const { authority, deps, service } = fixture(); authority.credentialRevision = 1;
    expect(await service.process(batch([management]), channel, observedAt)).toMatchObject({ status: 503 });
    expect(deps.persistTemplateEvents).not.toHaveBeenCalled(); authority.bindingCredentialRevision = 1;
    expect(await service.process(batch([management]), channel, observedAt)).toEqual({ kind: 'persisted', hasChat: false, count: 1 });
  });
  it.each(['loadAuthority', 'loadCatalog', 'persistTemplateEvents'] as const)('falha de %s vira503 sem expor erro cru', async step => {
    const { deps, service } = fixture(); vi.mocked(deps[step]).mockRejectedValueOnce(new Error('private token/body'));
    expect(await service.process(batch([management, chat()]), channel, observedAt)).toEqual({ kind: 'refused', status: 503, reason: 'template_dependency_unavailable' });
    if (step !== 'persistTemplateEvents') expect(deps.persistTemplateEvents).not.toHaveBeenCalled();
  });
  it('não responde antes da transação resolver; persist usa tenant backend e registro sanitizado', async () => {
    const { deps, service } = fixture(); let release!: () => void;
    vi.mocked(deps.persistTemplateEvents).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const processing = service.process(batch([management, chat()]), channel, observedAt).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(deps.persistTemplateEvents).toHaveBeenCalledOnce()); expect(settled).toBe(false);
    expect(deps.persistTemplateEvents).toHaveBeenCalledWith({ capture: expect.objectContaining({ channelId: channel.id, unitId: channel.unit_id, accountId: 'account-a', verifiedAt: observedAt, credentialRevision: 0 }), events: [expect.objectContaining({ name: null, remote_status: null })] });
    release(); expect(await processing).toEqual({ kind: 'persisted', hasChat: true, count: 1 });
  });
  it('reentrada mantém o digest sem relógio de recebimento e só encaminha chat', async () => {
    const { deps, service } = fixture(); const payload = batch([management, chat()]); const raw = JSON.stringify(payload);
    await service.process(payload, channel, observedAt);
    await service.process(payload, channel, '2026-10-05T12:00:00Z');
    const calls = vi.mocked(deps.persistTemplateEvents).mock.calls;
    expect(calls[0][0].events[0].digest).toBe(calls[1][0].events[0].digest);
    expect(JSON.stringify(payload)).toBe(raw);
    expect(splitMetaWebhookPayloadCore(payload)).toEqual([batch([chat()])]);
    expect(splitMetaWebhookPayloadCore(batch([management]))).toEqual([]);
  });
  it('prepare freezes the private sanitized capture without effects until commit', async () => {
    const { authority, deps, service } = fixture();
    const payload = batch([event({ event: 'PAUSED' }), chat()]);
    const prepared = await service.prepare(payload, channel, observedAt);
    expect(prepared.kind).toBe('prepared');
    expect(deps.persistTemplateEvents).not.toHaveBeenCalled();
    if (prepared.kind !== 'prepared') throw new Error('expected preparation');
    expect(Object.isFrozen(prepared)).toBe(true);
    authority.unitId = 'later-mutated-unit';
    payload.entry[0].changes.splice(0);
    expect(await prepared.commit()).toEqual({ kind: 'persisted', hasChat: true, count: 1 });
    const captured = vi.mocked(deps.persistTemplateEvents).mock.calls[0][0];
    expect(captured.capture.unitId).toBe(channel.unit_id);
    expect(captured.events[0].remote_status).toBe('PAUSED');
    expect(Object.isFrozen(captured.capture)).toBe(true);
    expect(Object.isFrozen(captured.events)).toBe(true);
    expect(Object.isFrozen(captured.events[0])).toBe(true);
  });
  it('carrega a captura integral e precisão SQL até a RPC; rejeição stale não libera dispatch misto', async () => {
    const { authority, deps, service } = fixture();
    authority.verifiedAt = '2026-10-04T12:00:00.123456+00:00';
    vi.mocked(deps.persistTemplateEvents).mockRejectedValueOnce({ code: 'PT503', message: 'template_authority_changed' });
    expect(await service.process(batch([management, chat()]), channel, observedAt)).toEqual({ kind: 'refused', status: 503, reason: 'template_dependency_unavailable' });
    expect(vi.mocked(deps.persistTemplateEvents).mock.calls[0][0].capture).toEqual(authority);
    expect(vi.mocked(deps.persistTemplateEvents).mock.calls[0][0].capture.verifiedAt).toBe('2026-10-04T12:00:00.123456+00:00');
  });
});

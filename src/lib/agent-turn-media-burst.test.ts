// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chatSdkMessage, createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { MEDIA_REPLY_TEXT, mediaNoticeText } from '../../supabase/functions/_shared/media-reply-text';

/**
 * Rajada texto + mídia no turno compartilhado (webhook-whatsapp real, harness
 * de Request). A mídia adiada (`media_kind` + `media_notice: 'deferred'`) nunca
 * supera o texto no debounce, não entra no prompt, e o aviso variante só sai
 * depois da resposta, no desfecho `success`.
 */

type Fixture = ReturnType<typeof createAutomationFixture>;
type Chat = ReturnType<Fixture['chat']>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.chat().harness.dispose(); });

const text = (value: string) => chatSdkMessage([{ type: 'text', text: value }]);
const CLAIM = 'rpc:claim_conversation_media_notices';

function setup() {
  const f = createAutomationFixture(); fixtures.push(f);
  return { f, c: f.chat() };
}
const later = (c: Chat, ms = 500) => new Date(c.harness.now + ms).toISOString();
const media = (c: Chat, kind: string, extra: Record<string, unknown> = {}) => ({
  role: 'user', content: '[imagem]', author: 'customer', timestamp: later(c), received_at: later(c),
  event_id: `media-${kind}-${Math.random()}`, media_kind: kind, media_notice: 'deferred', ...extra,
});
const sentTexts = (c: Chat) => c.trace.filter((t) => t.operation === 'provider:post')
  .map((t) => (t.value as { text: { body: string } }).text.body);
const outcomes = (c: Chat) => c.tables.webhook_executions.map((row) => row.outcome);
const evts = (c: Chat) => c.harness.logs.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
/** Roda uma vez `fn` na leitura do debounce (a primeira de `messages` após o append). */
function onDebounceRead(c: Chat, fn: () => void) {
  let done = false;
  c.controls.beforeQuery = async (q) => {
    if (!done && q.table === 'conversations' && q.operation === 'select' && q.columns === 'messages') { done = true; fn(); }
  };
}
const push = (c: Chat, m: Record<string, unknown>) => (c.tables.conversations[0].messages as unknown[]).push(m);

describe('rajada texto + mídia no turno', () => {
  it('mídia mais nova não supera o texto: responde e depois avisa', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Claro, para quantas pessoas?')];
    onDebounceRead(c, () => push(c, media(c, 'image')));
    const res = await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
    expect(res.status).toBe(200);
    expect(outcomes(c)).toEqual(['success']);
    const llm = JSON.stringify(c.sdk.requests[0].input);
    expect(llm).toContain('Quero reservar');
    expect(llm).not.toContain('[imagem]');
    expect(sentTexts(c)).toEqual(['Claro, para quantas pessoas?', mediaNoticeText(['image'])]);
    const msgs = c.tables.conversations[0].messages as { role: string; content: string; author?: string }[];
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: mediaNoticeText(['image']), author: 'automation' });
    expect(evts(c).find((e) => e.evt === 'media_notice_sent')).toMatchObject({ count: 1 });
  });

  it('texto mais novo continua superando', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('ok')];
    onDebounceRead(c, () => push(c, { role: 'user', content: 'e mais uma coisa', author: 'customer', timestamp: later(c), received_at: later(c), event_id: 'newer-text' }));
    await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
    expect(outcomes(c)).toEqual(['debounced_superseded']);
    expect(sentTexts(c)).toEqual([]);
  });

  it('cliente que digitou "[imagem]" (sem media_kind) supera como texto', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('ok')];
    onDebounceRead(c, () => push(c, { role: 'user', content: '[imagem]', author: 'customer', timestamp: later(c), received_at: later(c), event_id: 'typed' }));
    await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
    expect(outcomes(c)).toEqual(['debounced_superseded']);
    expect(c.trace.map((t) => t.operation)).not.toContain(CLAIM);
  });

  it('mídia chegando durante a chamada da IA: aviso depois da resposta', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    c.controls.beforeSdk = async () => { push(c, media(c, 'audio', { content: '[áudio]', timestamp: later(c, 100), received_at: later(c, 100) })); };
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['success']);
    expect(sentTexts(c)).toEqual(['Resposta', mediaNoticeText(['audio'])]);
  });

  it('duas mídias de tipos diferentes: um aviso só, "seu arquivo"', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    onDebounceRead(c, () => { push(c, media(c, 'image')); push(c, media(c, 'audio', { content: '[áudio]' })); });
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    const notices = sentTexts(c).slice(1);
    expect(notices).toEqual([mediaNoticeText(['image', 'audio'])]);
    expect(notices[0]).toContain('seu arquivo');
  });

  it('sem mídia adiada: o claim devolve [] e sai só a resposta', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['success']);
    expect(c.trace.map((t) => t.operation)).toContain(CLAIM);
    expect(sentTexts(c)).toEqual(['Resposta']);
    expect(evts(c).some((e) => e.evt === 'media_notice_sent')).toBe(false);
  });

  const deferredFixture = (c: Chat) => push(c, media(c, 'image', { timestamp: '2026-10-05T14:59:59Z', received_at: '2026-10-05T14:59:59Z' }));

  it('empty_response com adiada: sem claim e sem aviso', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('')];
    onDebounceRead(c, () => deferredFixture(c));
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['empty_response']);
    expect(c.trace.map((t) => t.operation)).not.toContain(CLAIM);
    expect(sentTexts(c).some((t) => t.includes('Recebi também'))).toBe(false);
  });

  it('send_error com adiada: sem claim e sem aviso', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    c.controls.sendStatus = 500;
    onDebounceRead(c, () => deferredFixture(c));
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['send_error']);
    expect(c.trace.map((t) => t.operation)).not.toContain(CLAIM);
    expect(sentTexts(c).some((t) => t.includes('Recebi também'))).toBe(false);
  });

  it('agent_error com adiada: sem claim e sem aviso', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [new Error('synthetic provider down'), new Error('synthetic provider down')];
    onDebounceRead(c, () => deferredFixture(c));
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['agent_error']);
    expect(c.trace.map((t) => t.operation)).not.toContain(CLAIM);
    expect(sentTexts(c).some((t) => t.includes('Recebi também'))).toBe(false);
  });

  it('ai_reply_suppressed_by_human com adiada: sem claim e sem aviso', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    onDebounceRead(c, () => deferredFixture(c));
    c.controls.beforeSdk = async () => { c.tables.conversations[0].status = 'human_active'; };
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['ai_reply_suppressed_by_human']);
    expect(c.trace.map((t) => t.operation)).not.toContain(CLAIM);
    expect(sentTexts(c)).toEqual([]);
  });

  it('p_since é limitado a now − 120 s mesmo com pendente antiga', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    // Pendente de 10 min atrás, sem resposta depois dela.
    push(c, { role: 'user', content: 'antiga', author: 'customer', timestamp: '2026-10-05T14:50:00Z', received_at: '2026-10-05T14:50:00Z', event_id: 'old' });
    push(c, media(c, 'image', { timestamp: '2026-10-05T14:50:01Z', received_at: '2026-10-05T14:50:01Z', event_id: 'old-media' }));
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    const claim = c.trace.find((t) => t.operation === CLAIM)!;
    const since = Date.parse((claim.value as { p_since: string }).p_since);
    expect(since).toBeGreaterThanOrEqual(Date.parse('2026-10-05T15:00:00Z') - 120_000);
    expect(sentTexts(c)).toEqual(['Resposta']);
  });

  it('claim que falha: success, log media_notice_failed e nenhum aviso', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [text('Resposta')];
    c.controls.claimError = true;
    onDebounceRead(c, () => push(c, media(c, 'image')));
    await f.runChatControl({ kind: 'customer_text', text: 'Oi' });
    expect(outcomes(c)).toEqual(['success']);
    expect(evts(c).find((e) => e.evt === 'media_notice_failed')).toMatchObject({ stage: 'claim' });
    expect(sentTexts(c)).toEqual(['Resposta']);
  });

  it('MEDIA_REPLY_TEXT continua intacto', () => {
    expect(MEDIA_REPLY_TEXT).toContain('Por aqui só consigo ler texto');
  });
});

describe('fixture: emulação de record_conversation_media (semântica do SQL)', () => {
  const NOW_ISO = '2026-10-05T15:00:00Z';
  const record = (c: Chat, over: Record<string, unknown> = {}, allowed = true) => c.rpc('record_conversation_media', {
    p_conversation_id: c.ids.conversation,
    p_message: { role: 'user', content: '[imagem]', author: 'customer', timestamp: NOW_ISO, received_at: NOW_ISO, event_id: 'm1', media_kind: 'image', ...over },
    p_notice_allowed: allowed, p_burst_seconds: 60, p_debounce_grace_seconds: 11,
  });
  const userText = (ageSec: number, extra: Record<string, unknown> = {}) => {
    const at = new Date(Date.parse(NOW_ISO) - ageSec * 1000).toISOString();
    return { role: 'user', content: 'oi', author: 'customer', timestamp: at, received_at: at, event_id: `t${ageSec}`, ...extra };
  };
  const last = (c: Chat) => (c.tables.conversations[0].messages as { media_notice?: string }[]).at(-1)!;

  it('texto recente dentro da folga: deferred + variant', async () => {
    const { c } = setup(); push(c, userText(5));
    expect(await record(c)).toEqual({ data: { decision: 'deferred', variant: true }, error: null });
    expect(last(c).media_notice).toBe('deferred');
  });
  it('texto na rajada mas fora da folga e sem lock: notice_now (claimed), variant true', async () => {
    const { c } = setup(); push(c, userText(30));
    expect(await record(c)).toEqual({ data: { decision: 'notice_now', variant: true }, error: null });
    expect(last(c).media_notice).toBe('claimed');
  });
  it('texto na rajada fora da folga com lock vigente: deferred', async () => {
    const { c } = setup(); push(c, userText(30));
    c.tables.conversations[0].ai_lock_until = new Date(Date.parse(NOW_ISO) + 60_000).toISOString();
    expect((await record(c) as { data: { decision: string } }).data.decision).toBe('deferred');
  });
  it('texto velho (fora da rajada): notice_now e variant false', async () => {
    const { c } = setup(); push(c, userText(600));
    expect(await record(c)).toEqual({ data: { decision: 'notice_now', variant: false }, error: null });
  });
  it('texto já respondido não conta como pendente, mas conta no variant', async () => {
    const { c } = setup(); push(c, userText(5)); push(c, { role: 'assistant', content: 'r', author: 'ai', timestamp: NOW_ISO });
    expect(await record(c)).toEqual({ data: { decision: 'notice_now', variant: true }, error: null });
  });
  it('p_notice_allowed=false: suppressed, media_notice none, mesmo com texto recente', async () => {
    const { c } = setup(); push(c, userText(5));
    expect((await record(c, {}, false) as { data: { decision: string } }).data.decision).toBe('suppressed');
    expect(last(c).media_notice).toBe('none');
  });
  it('mesmo event_id: duplicate e nada gravado', async () => {
    const { c } = setup(); await record(c);
    const n = (c.tables.conversations[0].messages as unknown[]).length;
    expect(await record(c)).toEqual({ data: { decision: 'duplicate', variant: false }, error: null });
    expect((c.tables.conversations[0].messages as unknown[]).length).toBe(n);
  });
});

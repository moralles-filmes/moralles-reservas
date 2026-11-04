// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';
import { MEDIA_REPLY_TEXT, mediaNoticeText } from '../../supabase/functions/_shared/media-reply-text';

/** Caminho de mídia do webhook-whatsapp: grava pelo RPC atômico e decide aviso agora/adiado. */
type Fixture = ReturnType<typeof createAutomationFixture>;
type Chat = ReturnType<Fixture['chat']>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.chat().harness.dispose(); });
function setup() { const f = createAutomationFixture(); fixtures.push(f); return { f, c: f.chat() }; }
const sentTexts = (c: Chat) => c.trace.filter((t) => t.operation === 'provider:post')
  .map((t) => (t.value as { text: { body: string } }).text.body);
const outcomes = (c: Chat) => c.tables.webhook_executions.map((row) => row.outcome);
const msgs = (c: Chat) => c.tables.conversations[0].messages as Record<string, unknown>[];
const recentText = (c: Chat) => msgs(c).push({ role: 'user', content: 'Quero reservar', author: 'customer',
  timestamp: new Date(c.harness.now - 1000).toISOString(), received_at: new Date(c.harness.now - 1000).toISOString(), event_id: 'prev-text' });

describe('mídia no webhook-whatsapp', () => {
  it('mídia sem texto: MEDIA_REPLY_TEXT e media_kind no elemento', async () => {
    const { f, c } = setup();
    const res = await f.runChatControl({ kind: 'media' });
    expect(res.status).toBe(200);
    expect(outcomes(c)).toEqual(['media_response']);
    expect(sentTexts(c)).toEqual([MEDIA_REPLY_TEXT]);
    expect(msgs(c)[0]).toMatchObject({ role: 'user', author: 'customer', media_kind: 'audio', media_notice: 'claimed' });
    expect(msgs(c).at(-1)).toMatchObject({ role: 'assistant', content: MEDIA_REPLY_TEXT, author: 'automation' });
  });

  it('mídia com texto recente: adia, nada enviado', async () => {
    const { f, c } = setup();
    recentText(c);
    await f.runChatControl({ kind: 'media' });
    expect(outcomes(c)).toEqual(['media_notice_deferred']);
    expect(sentTexts(c)).toEqual([]);
    expect(msgs(c).at(-1)).toMatchObject({ media_kind: 'audio', media_notice: 'deferred' });
  });

  it('notice_now com variante: texto variante', async () => {
    const { f, c } = setup();
    msgs(c).push({ role: 'user', content: 'Oi', author: 'customer', timestamp: new Date(c.harness.now - 30000).toISOString(), received_at: new Date(c.harness.now - 30000).toISOString(), event_id: 'old-text' },
      { role: 'assistant', content: 'Olá', author: 'automation', timestamp: new Date(c.harness.now - 20000).toISOString() });
    await f.runChatControl({ kind: 'media' });
    expect(outcomes(c)).toEqual(['media_response']);
    expect(sentTexts(c)).toEqual([mediaNoticeText(['audio'])]);
  });

  it('handoff: media_during_handoff, sem envio', async () => {
    const { f, c } = setup();
    c.tables.conversations[0].status = 'human_active';
    await f.runChatControl({ kind: 'media' });
    expect(outcomes(c)).toEqual(['media_during_handoff']);
    expect(sentTexts(c)).toEqual([]);
    expect(msgs(c)[0]).toMatchObject({ media_kind: 'audio', media_notice: 'none' });
  });

  it('gate bloqueado: desfecho de hoje, sem envio', async () => {
    const { f, c } = setup();
    c.tables.organizations[0].billing_status = 'blocked';
    await f.runChatControl({ kind: 'media' });
    expect(outcomes(c)).toEqual(['org_billing_blocked']);
    expect(sentTexts(c)).toEqual([]);
  });

  it('erro do RPC: reentrega, sem envio e sem desfecho de resposta', async () => {
    const { f, c } = setup();
    c.controls.recordError = true;
    const res = await f.runChatControl({ kind: 'media' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(sentTexts(c)).toEqual([]);
    expect(outcomes(c)).not.toContain('media_response');
  });
});

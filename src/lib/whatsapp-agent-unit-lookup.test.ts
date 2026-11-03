// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chatSdkMessage, createAutomationFixture } from '../test/fixtures/whatsapp-automation-fixtures';

/**
 * Leitura de `units` que falha no turno do agente do `webhook-whatsapp` real.
 *
 * Seguir com organização vazia cairia na guarda `invalid_channel_context` do
 * núcleo (`_shared/agent/turn.ts`), que é TERMINAL: a mensagem do cliente seria
 * marcada processada sem histórico, sem resposta e sem nova tentativa. A falha
 * de leitura tem de ser retentável: claim devolvido, nada processado.
 */

type Fixture = ReturnType<typeof createAutomationFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.chat().harness.dispose(); });

function setup() {
  const f = createAutomationFixture(); fixtures.push(f);
  return { f, c: f.chat() };
}

describe('webhook-whatsapp: leitura de units no turno do agente', () => {
  it('erro na leitura é retentável: 500, claim devolvido, sem LLM, sem invalid_channel_context', async () => {
    const { f, c } = setup();
    c.controls.unitSelectError = 'synthetic_units_down';
    const response = await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
    expect(response.status).toBe(500);
    expect(c.unexpected).toEqual([]);
    expect(c.calls.llm).toBe(0);
    const ops = c.trace.map((t) => t.operation);
    expect(ops).toContain('rpc:release_processed_whatsapp_message_claim');
    expect(ops).not.toContain('rpc:complete_processed_whatsapp_message');
    expect(c.tables.webhook_executions.map((row) => row.outcome)).toEqual(['webhook_error']);
  });

  it('controle positivo: com a leitura em ordem o mesmo turno chega ao LLM e termina em success', async () => {
    const { f, c } = setup();
    c.controls.sdkResponses = [chatSdkMessage([{ type: 'text', text: 'ok' }])];
    const response = await f.runChatControl({ kind: 'customer_text', text: 'Quero reservar' });
    expect(response.status).toBe(200);
    expect(c.unexpected).toEqual([]);
    expect(c.calls.llm).toBe(1);
    expect(c.tables.webhook_executions.map((row) => row.outcome)).toEqual(['success']);
  });
});

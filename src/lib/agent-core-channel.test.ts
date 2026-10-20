import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeAgentSystemPrompt, type AgentPromptParts } from '../../supabase/functions/_shared/agent/system-prompt';
import { agentTools } from '../../supabase/functions/_shared/agent/tools';

/**
 * Ponto de extensão por canal do núcleo do agente (`_shared/agent/`).
 *
 * A paridade do WhatsApp é provada byte a byte em `agent-turn-parity.test.ts`.
 * Aqui fica o que aquele harness não alcança: que os pedaços do prompt que
 * mudam por canal entram MESMO pelo contexto (o Instagram vai depender disso na
 * Fase 1), e a cadeia da origem da reserva, que nenhum cenário do harness
 * exercita (`create_reservation` exige o motor de disponibilidade inteiro).
 */

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8').replace(/\r\n/g, '\n');

const parts = (over: Partial<AgentPromptParts> = {}): AgentPromptParts => ({
  includeFaq: false, agentName: 'Yumi', restaurantName: 'Exemplo', identityLine: 'IDENTIDADE_DO_CANAL.',
  todayBR: 'segunda-feira, 05/10/2026', weekdayName: 'segunda-feira', upcomingDaysLines: ['- amanhã: terça-feira'],
  customerFirstName: '', formattingRules: 'FORMATACAO_DO_CANAL', unitAddress: '', restaurantInfoLines: [],
  hallScheduleBlock: null, hoursLines: [], specialLines: [], blockedLines: [], giftbackLines: [], prefsLines: [],
  customPrompt: '', settingsMap: {}, ...over,
});

describe('prompt: identidade e formatação vêm do canal', () => {
  it('a identidade do canal abre a frase do dia, uma vez só', () => {
    const prompt = composeAgentSystemPrompt(parts());
    expect(prompt).toContain('IDENTIDADE_DO_CANAL. Hoje é segunda-feira, 05/10/2026. ');
    expect(prompt.split('IDENTIDADE_DO_CANAL').length - 1).toBe(1);
  });

  it('a formatação do canal entra depois das regras de reserva, uma vez só', () => {
    const prompt = composeAgentSystemPrompt(parts());
    const regra12 = prompt.indexOf('12. Fila de espera');
    const formatacao = prompt.indexOf('\n\nFORMATACAO_DO_CANAL');
    expect(regra12).toBeGreaterThan(-1);
    expect(formatacao, 'a formatação saiu de depois da regra 12').toBeGreaterThan(regra12);
    expect(prompt.split('FORMATACAO_DO_CANAL').length - 1).toBe(1);
  });

  it('o núcleo não carrega a formatação nem a identidade do WhatsApp', () => {
    // Controle positivo do ponto de extensão: se o texto do WhatsApp tivesse
    // ficado no núcleo, outro canal o herdaria.
    const prompt = composeAgentSystemPrompt(parts());
    expect(prompt).not.toContain('FORMATAÇÃO DA RESPOSTA NO WHATSAPP');
    expect(prompt).not.toContain('O número de WhatsApp do cliente');
    const core = read('supabase/functions/_shared/agent/system-prompt.ts');
    expect(core).not.toContain('FORMATAÇÃO DA RESPOSTA NO WHATSAPP');
    expect(core).not.toContain('O número de WhatsApp do cliente');
    const webhook = read('supabase/functions/webhook-whatsapp/index.ts');
    expect(webhook).toContain('`FORMATAÇÃO DA RESPOSTA NO WHATSAPP:\\n` +');
    expect(webhook).toContain('identityLine: `O número de WhatsApp do cliente é ${phone}.`,');
    expect(webhook).toContain('formattingRules: WHATSAPP_FORMATTING_RULES,');
  });
});

describe('ferramentas do agente', () => {
  it('o conjunto exposto ao LLM é o mesmo, na mesma ordem', () => {
    expect(agentTools.map((t) => t.name)).toEqual([
      'check_availability', 'create_reservation', 'get_reservation', 'update_reservation',
      'cancel_reservation', 'list_customer_reservations', 'request_human_handoff',
    ]);
    expect(agentTools.find((t) => t.name === 'cancel_reservation')?.parameters).toMatchObject({ required: ['reservation_code'] });
  });

  it('a origem da reserva atravessa canal → turno → reserveSlot sem literal no meio', () => {
    // Load-bearing: o trigger `enqueue_confirmation_notification` pula a origem
    // do agente; perder o `source` duplica a confirmação ao cliente.
    const tools = read('supabase/functions/_shared/agent/tools.ts');
    const turn = read('supabase/functions/_shared/agent/turn.ts');
    const context = read('supabase/functions/_shared/agent/channel-context.ts');
    const webhook = read('supabase/functions/webhook-whatsapp/index.ts');
    const reserve = tools.slice(tools.indexOf('await reserveSlot(supabase, {'));
    expect(reserve.slice(0, reserve.indexOf('});'))).toContain('source: params.source,');
    expect(turn).toContain('source: ctx.reservationSource,');
    expect(webhook).toContain('reservationSource: "whatsapp",');
    // Só `whatsapp` até a migration que libera `instagram` no CHECK e no trigger.
    expect(context).toMatch(/export type AgentReservationSource = "whatsapp";/);
  });
});

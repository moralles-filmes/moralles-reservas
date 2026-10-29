import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { composeAgentSystemPrompt, loadAgentSystemPrompt, type AgentPromptParts } from '../../supabase/functions/_shared/agent/system-prompt';

// O grafo de `turn.ts` importa SDKs do esm.sh em runtime; a guarda roda antes de
// qualquer uso deles, então aqui basta que o import resolva. Toda chamada falha.
// `turn.ts` entra por import dinâmico com caminho em variável (no teste da
// guarda): import estático levaria o `tsc -b` do front ao grafo Deno dele.
vi.mock('https://esm.sh/@anthropic-ai/sdk@0.27.3', () => ({
  default: class { constructor() { throw new Error('Anthropic instanciado no teste'); } },
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: () => { throw new Error('createClient chamado no teste'); },
}));
import { agentTools } from '../../supabase/functions/_shared/agent/tools';
import { GLOBAL_PERSONA_BASELINE } from '../../supabase/functions/_shared/agent/global-prompt-core';

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
  includeFaq: false, agentName: 'Yumi', restaurantName: 'Exemplo', globalPromptBody: GLOBAL_PERSONA_BASELINE,
    identityLine: 'IDENTIDADE_DO_CANAL.',
  todayBR: 'segunda-feira, 05/10/2026', weekdayName: 'segunda-feira', upcomingDaysLines: ['- amanhã: terça-feira'],
  customerFirstName: '', formattingRules: 'FORMATACAO_DO_CANAL', channelLabel: 'WhatsApp', channelRules: '',
  unitAddress: '', restaurantInfoLines: [],
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

describe('prompt: regra do canal (Task 3.3)', () => {
  // Abertura da regra 12 como o WhatsApp a envia hoje (o snapshot de paridade
  // prende o texto inteiro, byte a byte, pelo webhook real).
  const REGRA_12_WHATSAPP = '12. Fila de espera / lista de espera: NÃO trabalhamos com fila de espera pelo WhatsApp. NUNCA ofereça';

  it('a regra 12 nomeia o canal do contexto', () => {
    const ig = composeAgentSystemPrompt(parts({ channelLabel: 'Instagram' }));
    expect(ig).toContain('NÃO trabalhamos com fila de espera pelo Instagram. NUNCA ofereça');
    expect(ig).not.toContain('fila de espera pelo WhatsApp');
    const wa = composeAgentSystemPrompt(parts({ channelLabel: 'WhatsApp' }));
    expect(wa).toContain(REGRA_12_WHATSAPP);
  });

  it('channelRules vazio não acrescenta nenhum byte; preenchido entra logo depois da formatação', () => {
    const vazio = composeAgentSystemPrompt(parts({ channelRules: '' }));
    expect(vazio).toContain('\n\nFORMATACAO_DO_CANAL\n\n');
    const comRegra = composeAgentSystemPrompt(parts({ channelRules: 'REGRAS_DO_CANAL' }));
    expect(comRegra).toContain('\n\nFORMATACAO_DO_CANAL\n\nREGRAS_DO_CANAL');
    expect(comRegra.replace('\n\nREGRAS_DO_CANAL', '')).toBe(vazio);
  });

  it('o WhatsApp passa o rótulo, a regra vazia e o cliente privado', () => {
    const webhook = read('supabase/functions/webhook-whatsapp/index.ts');
    expect(webhook).toContain('channelLabel: "WhatsApp",');
    expect(webhook).toContain('channelRules: "",');
    const turn = read('supabase/functions/_shared/agent/turn.ts');
    const call = turn.slice(turn.indexOf('await loadAgentSystemPrompt('));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('privateCustomer: ctx.customer,');
    expect(args).toContain('channelLabel: ctx.channelLabel,');
    expect(args).toContain('channelRules: ctx.channelRules,');
  });
});

type PromptClient = Parameters<typeof loadAgentSystemPrompt>[0];

/** Cliente falso que registra toda tabela consultada. */
function recordingClient() {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const data: unknown[] = table === 'vouchers'
        ? [{ code: 'VOUCHER_PRIVADO', discount_percent: 10, expires_at: '2099-12-31' }]
        : [];
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'order', 'limit']) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(ok, ko);
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, tables };
}

describe('prompt do contato declarado não lê vouchers nem preferências', () => {
  const now = new Date();
  const hojeMMDD = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const cadastro = {
    id: 'cust-privado', name: 'Fulana Cadastrada', phone: '11999990000', birthday: `1990-${hojeMMDD}`,
    allergies: 'ALERGIA_PRIVADA', dietary_restrictions: 'RESTRICAO_PRIVADA', vip_notes: 'VIP_PRIVADO',
    preferred_table_location: 'internal',
  };
  // Cada campo privado do cadastro (nome gravado, alergias, restrições, VIP,
  // mesa preferida, aniversário, vouchers) e o cabeçalho do bloco do cliente.
  const PRIVADOS = [
    'ALERGIA_PRIVADA', 'RESTRICAO_PRIVADA', 'VIP_PRIVADO', 'VOUCHER_PRIVADO', 'Fulana',
    'Alergias:', 'Restrições alimentares:', 'VIP:', 'Mesa preferida', '- HOJE é aniversário do cliente.','O que sabemos sobre este cliente:\n',
  ];
  const args = (privateCustomer: typeof cadastro | null) => ({
    unitId: 'unit-1',
    unit: { row: { name: 'Exemplo' }, name: 'Exemplo', slug: null, address: '', ticketMax: null },
    privateCustomer,
    phone: '11999990000',
    identityLine: 'IDENTIDADE.',
    formattingRules: 'FORMATACAO',
    channelLabel: 'Instagram',
    channelRules: '',
    appBaseUrl: () => 'https://exemplo.invalid',
    requestId: 'req-1',
    log: () => {},
  });

  it('com privateCustomer:null, nenhuma consulta a vouchers e nenhum dado do cadastro no prompt', async () => {
    const { client, tables } = recordingClient();
    const out = await loadAgentSystemPrompt(client as unknown as PromptClient, args(null));
    expect(tables.length, 'o cliente falso não registrou nada').toBeGreaterThan(0);
    expect(tables).not.toContain('vouchers');
    for (const p of PRIVADOS) expect(out.text, `vazou "${p}"`).not.toContain(p);
  });

  it('controle positivo: com o cadastro, o mesmo cliente falso enxerga vouchers e preferências', async () => {
    const { client, tables } = recordingClient();
    const out = await loadAgentSystemPrompt(client as unknown as PromptClient, args(cadastro));
    expect(tables).toContain('vouchers');
    for (const p of PRIVADOS) expect(out.text, `faltou "${p}"`).toContain(p);
  });
});

type Finish = (outcome: string, error?: string | null, meta?: Record<string, unknown>) => Promise<void>;
type TurnFactory = (io: Record<string, unknown> & { finish: Finish }) => {
  run(ctx: unknown, inbound: unknown): Promise<void>;
};
const TURN_MODULE = '../../supabase/functions/_shared/agent/turn';

describe('guarda do contexto do turno', () => {
  for (const [campo, over] of [['organizationId', { organizationId: '' }], ['unitId', { unitId: '' }]] as const) {
    it(`${campo} vazio registra invalid_channel_context e não toca banco, LLM nem canal`, async () => {
      const finishes: { outcome: string; error?: string | null; meta?: Record<string, unknown> }[] = [];
      const touched: string[] = [];
      const supabase = {
        from: (t: string) => { touched.push(`from:${t}`); throw new Error('banco tocado'); },
        rpc: (fn: string) => { touched.push(`rpc:${fn}`); throw new Error('rpc tocada'); },
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { touched.push('fetch'); throw new Error('rede tocada'); });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { createAgentTurn } = (await import(/* @vite-ignore */ TURN_MODULE)) as { createAgentTurn: TurnFactory };
        const turn = createAgentTurn({
          supabase,
          requestId: 'req-guard',
          requestStartedAt: Date.now(),
          ingestionSource: 'provider',
          finish: async (outcome, error, meta) => { finishes.push({ outcome, error, meta }); },
          appendToConversation: async () => { touched.push('append'); throw new Error('append'); },
          markExternalSideEffect: () => { touched.push('side_effect'); },
        });
        const ctx = {
          channel: 'instagram', unitId: 'unit-1', organizationId: 'org-1',
          unit: { row: null, name: 'Exemplo', slug: null, address: '', ticketMax: null },
          conversation: { id: 'conv-1', messages: [], status: 'ai_active' },
          customer: { id: 'cust-1', phone: '11999990000' },
          phone: '11999990000', identityLine: 'ID.', formattingRules: 'F', channelLabel: 'Instagram', channelRules: '',
          sanitize: (t: string) => t,
          send: async () => { touched.push('send'); return { ok: true }; },
          reservationSource: 'whatsapp', appBaseUrl: () => 'https://exemplo.invalid', channelId: null,
          ...over,
        };
        await turn.run(ctx, { text: 'oi', timestamp: null, receivedAt: '2026-10-29T12:00:00Z', eventId: 'e1' });
        const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0]));
        expect(finishes.map((f) => f.outcome)).toEqual(['invalid_channel_context']);
        expect(finishes[0].meta?.global_prompt_version, 'a guarda roda antes da carga do prompt global').toBeUndefined();
        expect(logged.some((l) => l.includes('"evt":"agent_context_invalid"'))).toBe(true);
        expect(touched).toEqual([]);
      } finally {
        fetchSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore(); errSpy.mockRestore();
      }
    });
  }
});

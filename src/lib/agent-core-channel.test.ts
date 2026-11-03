import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeAgentSystemPrompt, loadAgentSystemPrompt, type AgentPromptParts } from '../../supabase/functions/_shared/agent/system-prompt';

// O grafo de `turn.ts` importa SDKs do esm.sh em runtime. A guarda roda antes de
// qualquer uso deles; o turno completo (R3-a) fala com um Anthropic falso que
// registra cada requisição e segue o roteiro de `llm.script`.
// `turn.ts` entra por import dinâmico com caminho em variável: import estático
// levaria o `tsc -b` do front ao grafo Deno dele.
const llm = vi.hoisted(() => ({ requests: [] as unknown[], script: [] as unknown[] }));
vi.mock('https://esm.sh/@anthropic-ai/sdk@0.27.3', () => ({
  default: class {
    messages = {
      create: async (params: unknown) => {
        llm.requests.push(JSON.parse(JSON.stringify(params)));
        const content = llm.script.shift() ?? [{ type: 'text', text: 'Posso ajudar.' }];
        const toolUse = (content as { type: string }[]).some((c) => c.type === 'tool_use');
        return {
          id: 'msg_teste', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content,
          stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
      },
    };
  },
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
    // O despacho das ferramentas saiu do `turn.ts` para `tool-dispatch.ts` (Task 3.4).
    const dispatch = read('supabase/functions/_shared/agent/tool-dispatch.ts');
    const context = read('supabase/functions/_shared/agent/channel-context.ts');
    const webhook = read('supabase/functions/webhook-whatsapp/index.ts');
    const reserve = tools.slice(tools.indexOf('await reserveSlot(supabase, {'));
    expect(reserve.slice(0, reserve.indexOf('});'))).toContain('source: params.source,');
    const create = dispatch.slice(dispatch.indexOf('await createReservation(supabase, {'));
    expect(create.slice(0, create.indexOf('});'))).toContain('source: ctx.reservationSource,');
    expect(webhook).toContain('reservationSource: "whatsapp",');
    // `instagram` entra com a migration 20261103120400 (CHECK) e o trigger
    // continua pulando só `whatsapp` (D6): a reserva do Direct é confirmada
    // pelo WhatsApp.
    expect(context).toMatch(/export type AgentReservationSource = "whatsapp" \| "instagram";/);
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

  it('o WhatsApp passa o rótulo, a regra vazia; o cadastro privado só vai sem identidade declarada (R3-a)', () => {
    const webhook = read('supabase/functions/webhook-whatsapp/index.ts');
    expect(webhook).toContain('channelLabel: "WhatsApp",');
    expect(webhook).toContain('channelRules: "",');
    expect(webhook, 'o WhatsApp não tem porta de identidade declarada').not.toContain('claimedIdentity');
    const turn = read('supabase/functions/_shared/agent/turn.ts');
    const call = turn.slice(turn.indexOf('await loadAgentSystemPrompt('));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('privateCustomer: ctx.claimedIdentity ? null : ctx.customer,');
    expect(args).toContain('phone: ctx.phone,');
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

// Relógio congelado ao meio-dia BRT de 05/10/2026: o aniversário do cadastro é
// "hoje" sem depender da hora em que a suíte roda (perto da meia-noite o dia
// local e o dia BRT divergiam).
const AGORA_FIXO = new Date('2026-10-05T15:00:00Z');

describe('prompt do contato declarado não lê vouchers nem preferências', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AGORA_FIXO); });
  afterEach(() => { vi.useRealTimers(); });
  const cadastro = {
    id: 'cust-privado', name: 'Fulana Cadastrada', phone: '11999990000', birthday: '1990-10-05',
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
  const casos: Array<[string, Record<string, unknown>]> = [
    ['organizationId vazio', { organizationId: '' }],
    ['unitId vazio', { unitId: '' }],
    // 3.3 review M1: só espaço é tão vazio quanto vazio. UUID não é conferido aqui.
    ['organizationId só com espaço', { organizationId: '   ' }],
    ['unitId só com espaço', { unitId: ' \t ' }],
    // Só um canal de identidade declarada (com porta) pode chegar sem cliente.
    ['sem porta e cliente nulo', { customer: null, phone: null }],
  ];
  for (const [caso, over] of casos) {
    it(`${caso} registra invalid_channel_context e não toca banco, LLM nem canal`, async () => {
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
      const llmAntes = llm.requests.length;
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
          channel: 'whatsapp', unitId: 'unit-1', organizationId: 'org-1',
          unit: { row: null, name: 'Exemplo', slug: null, address: '', ticketMax: null },
          conversation: { id: 'conv-1', messages: [], status: 'ai_active' },
          customer: { id: 'cust-1', phone: '11999990000' },
          phone: '11999990000', identityLine: 'ID.', formattingRules: 'F', channelLabel: 'WhatsApp', channelRules: '',
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
        expect(llm.requests.length).toBe(llmAntes);
      } finally {
        fetchSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore(); errSpy.mockRestore();
      }
    });
  }
});

/**
 * Turno completo com um client falso permissivo: toda cadeia do PostgREST
 * devolve vazio, salvo o que o turno precisa para chegar ao LLM (conversa ativa,
 * lock concedido, `ai_config` e chave do provider). Registra cada tabela lida.
 */
function turnClient(opts: { requestId: string; messages: () => unknown[] }) {
  const tables: string[] = [];
  const rpcs: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      let columns = '';
      const filters: Record<string, unknown> = {};
      const answer = (single: boolean) => {
        if (table === 'conversations') {
          if (columns === 'messages') return { messages: opts.messages() };
          if (columns === 'status, messages') return { status: 'ai_active', messages: opts.messages() };
          if (columns === 'status, ai_lock_token') return { status: 'ai_active', ai_lock_token: opts.requestId };
        }
        if (table === 'settings' && filters.key === 'ai_config') return { value: { provider: 'claude' } };
        if (table === 'ai_provider_credentials') return single ? { api_key: 'chave-sintetica' } : [{ id: 'cred-1' }];
        if (table === 'vouchers') return single ? null : [{ code: 'VOUCHER_PRIVADO', discount_percent: 10, expires_at: '2099-12-31' }];
        return single ? null : [];
      };
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: answer(true), error: null });
          if (prop === 'then') {
            return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
              Promise.resolve({ data: answer(false), error: null }).then(ok, ko);
          }
          return (...args: unknown[]) => {
            if (prop === 'select' && typeof args[0] === 'string') columns = args[0];
            if (prop === 'eq') filters[String(args[0])] = args[1];
            return builder;
          };
        },
      });
      return builder;
    },
    async rpc(fn: string) {
      rpcs.push(fn);
      if (fn === 'try_claim_conversation_for_ai') return { data: true, error: null };
      return { data: null, error: null };
    },
  };
  return { client, tables, rpcs };
}

describe('turno com identidade declarada nunca leva o cadastro ao prompt (R3-a)', () => {
  // Cliente já ligado por `link_customer_phone` num turno anterior: o adapter
  // entrega o cadastro inteiro em `ctx.customer`, e o prompt não pode vê-lo.
  // Só `Date` congelado (o debounce usa `setTimeout` real): aniversário "hoje"
  // em BRT sem depender da hora da suíte.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AGORA_FIXO); });
  afterEach(() => { vi.useRealTimers(); });
  const cadastro = {
    id: 'cust-ligado', name: 'Fulana Cadastrada', phone: '11988887777', birthday: '1990-10-05',
    allergies: 'ALERGIA_PRIVADA', dietary_restrictions: 'RESTRICAO_PRIVADA', vip_notes: 'VIP_PRIVADO',
    preferred_table_location: 'internal',
  };
  const PRIVADOS = ['ALERGIA_PRIVADA', 'RESTRICAO_PRIVADA', 'VIP_PRIVADO', 'VOUCHER_PRIVADO', 'Fulana', 'Mesa preferida', '- HOJE é aniversário do cliente.', 'O que sabemos sobre este cliente:\n'];
  const systemText = (req: unknown): string => {
    const system = (req as { system: unknown }).system;
    return typeof system === 'string' ? system : (system as { text: string }[]).map((b) => b.text).join('');
  };

  async function rodarTurno(port: unknown) {
    const requestId = 'req-r3a';
    const messages: unknown[] = [];
    const { client, tables } = turnClient({ requestId, messages: () => messages });
    const finishes: string[] = [];
    const sent: string[] = [];
    const links: unknown[] = [];
    const claimedIdentity = port ? {
      reservationIds: async () => [],
      insertReservation: async () => ({ data: null, error: { code: '42501' } }),
      linkPhone: async (input: unknown) => { links.push(input); return { ok: true, customer: cadastro }; },
    } : undefined;
    llm.requests.length = 0;
    // Durante o turno o LLM liga o telefone (o despacho troca o cliente do
    // estado) e só depois responde: o prompt continua sem o cadastro.
    llm.script = port
      ? [[{ type: 'tool_use', id: 'tu-1', name: 'link_customer_phone', input: { phone: '11988887777', name: 'Ana' } }], [{ type: 'text', text: 'Pronto.' }]]
      : [[{ type: 'text', text: 'Pronto.' }]];
    const quiet = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
    try {
      const { createAgentTurn } = (await import(/* @vite-ignore */ TURN_MODULE)) as { createAgentTurn: TurnFactory };
      const turn = createAgentTurn({
        supabase: client,
        requestId,
        requestStartedAt: Date.now(),
        ingestionSource: 'provider',
        finish: async (outcome) => { finishes.push(outcome); },
        appendToConversation: async (_id: string, _prev: unknown[], role: string, content: string, o: { receivedAt?: string } = {}) => {
          messages.push({ role, content, timestamp: o.receivedAt, received_at: o.receivedAt });
          return { messages: [...messages], persisted: true };
        },
        markExternalSideEffect: () => {},
      });
      await turn.run({
        channel: port ? 'instagram' : 'whatsapp', unitId: 'unit-1', organizationId: 'org-1',
        unit: { row: { name: 'Exemplo' }, name: 'Exemplo', slug: null, address: '', ticketMax: null },
        conversation: { id: 'conv-1', messages: [], status: 'ai_active' },
        customer: cadastro, phone: cadastro.phone,
        identityLine: 'ID.', formattingRules: 'F', channelLabel: port ? 'Instagram' : 'WhatsApp', channelRules: '',
        sanitize: (t: string) => t,
        send: async (t: string) => { sent.push(t); return { ok: true }; },
        reservationSource: port ? 'instagram' : 'whatsapp', appBaseUrl: () => 'https://exemplo.invalid', channelId: null,
        ...(claimedIdentity ? { claimedIdentity } : {}),
      }, { text: 'oi', timestamp: null, receivedAt: new Date().toISOString(), eventId: 'e-r3a' });
    } finally {
      for (const s of quiet) s.mockRestore();
    }
    return { tables, finishes, sent, links };
  }

  it('com porta e cliente ligado: nenhum dado do cadastro em nenhuma requisição e nenhuma leitura de vouchers', async () => {
    const { tables, finishes, sent, links } = await rodarTurno(true);
    expect(finishes).toEqual(['success']);
    expect(sent).toEqual(['Pronto.']);
    expect(links, 'o link_customer_phone do roteiro não rodou').toEqual([{ phone: '11988887777', name: 'Ana' }]);
    expect(llm.requests.length, 'o turno não voltou ao LLM depois do link').toBe(2);
    const tools = (llm.requests[0] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools[tools.length - 1]).toBe('link_customer_phone');
    for (const req of llm.requests) {
      const text = systemText(req);
      expect(text, 'o prompt do turno não foi capturado').toContain('Você é');
      for (const p of PRIVADOS) expect(text, `vazou "${p}"`).not.toContain(p);
    }
    expect(tables).not.toContain('vouchers');
  }, 30_000);

  it('controle positivo: sem porta (WhatsApp) o mesmo turno leva o cadastro e lê vouchers', async () => {
    const { tables, finishes } = await rodarTurno(false);
    expect(finishes).toEqual(['success']);
    const text = systemText(llm.requests[0]);
    for (const p of PRIVADOS) expect(text, `faltou "${p}"`).toContain(p);
    expect(tables).toContain('vouchers');
    const tools = (llm.requests[0] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).not.toContain('link_customer_phone');
  }, 30_000);
});

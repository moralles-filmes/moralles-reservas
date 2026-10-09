import { describe, expect, it } from 'vitest';
import {
  catalogHash, renderTemplate, TEMPLATE_CATALOG,
  type TemplateId,
} from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';

const context = { allowedOrigins: ['https://example.com'] };
const tracking = 'https://example.com/acompanhar/00000000-0000-4000-8000-000000000001';
const preferences = `https://example.com/preferencias/mensagens/${'A'.repeat(43)}`;
const footer = 'Para não receber ofertas, use o link de preferências.';
const fixtures = [
  ['res_confirmacao_v1', 'UTILITY', ['Marina', 'Restaurante Exemplo', '20/10/2026', '20:30', '4', 'RES123', tracking],
    'Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).\nCódigo da reserva: {{6}}.\nDetalhes da reserva: {{7}}.\nPara solicitar uma alteração, responda a esta mensagem.'],
  ['res_confirmacao_desconto_v1', 'UTILITY', ['Marina', 'Restaurante Exemplo', '20/10/2026', '20:30', '4', 'RES123', '15', tracking],
    'Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).\nCódigo da reserva: {{6}}. Desconto já aplicado à reserva: {{7}}%.\nDetalhes da reserva: {{8}}.\nPara solicitar uma alteração, responda a esta mensagem.'],
  ['res_lembrete_dia_v1', 'UTILITY', ['Marina', 'Restaurante Exemplo', '20:30', '4', 'RES123', tracking],
    'Olá, {{1}}. Este é o lembrete da sua reserva de hoje em {{2}}, às {{3}}, para {{4}} pessoa(s).\nCódigo da reserva: {{5}}.\nDetalhes da reserva: {{6}}.\nPara solicitar uma alteração, responda a esta mensagem.'],
  ['res_pesquisa_reserva_v1', 'UTILITY', ['Marina', 'RES123', 'Restaurante Exemplo', '19/10/2026'],
    'Olá, {{1}}. Sobre sua reserva {{2}} em {{3}}, marcada para {{4}}: de 1 a 5, como você avalia o atendimento?\nResponda apenas com o número, sendo 1 muito insatisfeito e 5 muito satisfeito.\nObrigado pela sua avaliação.'],
  ['fila_entrada_v1', 'UTILITY', ['Marina', 'Restaurante Exemplo', '12', '4', tracking],
    'Olá, {{1}}. Sua entrada na fila de espera de {{2}} foi registrada.\nSenha da fila: {{3}}. Quantidade de pessoas: {{4}}.\nAcompanhamento: {{5}}.\nAvisaremos quando sua mesa estiver pronta.'],
  ['fila_feedback_v1', 'MARKETING', ['Marina', 'Restaurante Exemplo', '19/10/2026', 'https://example.com/feedback', preferences],
    'Olá, {{1}}. A {{2}} gostaria de saber sua opinião sobre o atendimento referente à sua passagem pela fila em {{3}}.\nAcesse: {{4}}.\nPreferências de mensagens: {{5}}.\nObrigado por compartilhar sua experiência.'],
  ['mkt_voucher_programado_v1', 'MARKETING', ['Marina', 'Restaurante Exemplo', '15', 'VCH12345', '30/10/2026', preferences],
    'Olá, {{1}}. A {{2}} disponibilizou {{3}}% de desconto para sua próxima visita.\nCódigo do voucher: {{4}}. Válido até {{5}}.\nApresente o código ao pagar e consulte as condições do benefício com a unidade.\nPreferências de mensagens: {{6}}.\nVocê pode atualizar sua escolha pelo link.'],
] as const;
const reminder = [...fixtures[2][2]];
const renderReminder = (position: number, value: unknown) => {
  const parameters: unknown[] = [...reminder];
  parameters[position] = value;
  return renderTemplate('res_lembrete_dia_v1', parameters, context);
};

describe('catálogo fixo', () => {
  it('possui os sete IDs e contagens da spec', () => {
    expect(Object.keys(TEMPLATE_CATALOG)).toEqual(fixtures.map(([id]) => id));
    expect(Object.values(TEMPLATE_CATALOG).map(d => d.variables.length)).toEqual([7, 8, 6, 4, 5, 5, 6]);
  });
  it.each(fixtures)('preserva texto, categoria e parâmetros de %s', (id, category, parameters, body) => {
    const definition = TEMPLATE_CATALOG[id];
    expect(definition).toMatchObject({ name: id, language: 'pt_BR', parameterFormat: 'POSITIONAL', version: 1, state: 'active', requestedCategory: category, body });
    expect(definition.footer).toBe(category === 'MARKETING' ? footer : null);
    expect(definition.components).toEqual([{ type: 'BODY', text: body }, ...(category === 'MARKETING' ? [{ type: 'FOOTER', text: footer }] : [])]);
    const result = renderTemplate(id, parameters, context);
    expect(result.body).toBe(body.replace(/\{\{(\d+)\}\}/g, (_, n) => parameters[Number(n) - 1]));
    expect(result.parameters).toEqual(parameters);
    expect(result.footer).toBe(definition.footer);
    expect(result.body).not.toContain('{{');
  });
  it('é profundamente imutável, inclusive fixtures e schemas', () => {
    const frozen = (value: unknown): boolean => value === null || typeof value !== 'object'
      || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(TEMPLATE_CATALOG)).toBe(true);
  });
  it('distingue reserva, fila e voucher', () => {
    expect(renderTemplate('res_lembrete_dia_v1', reminder, context).body).toContain('Código da reserva: RES123.');
    expect(renderTemplate('fila_entrada_v1', fixtures[4][2], context).body).toContain('Senha da fila: 12.');
    expect(renderTemplate('mkt_voucher_programado_v1', fixtures[6][2], context).body).toContain('Código do voucher: VCH12345.');
  });
  it('recusa id desconhecido e quantidade diferente', () => {
    expect(() => renderTemplate('inexistente' as TemplateId, [])).toThrow('template_unknown');
    expect(() => renderTemplate('toString' as TemplateId, [])).toThrow('template_unknown');
    for (const parameters of [reminder.slice(1), [...reminder, 'extra']]) {
      expect(() => renderTemplate('res_lembrete_dia_v1', parameters, context)).toThrow('template_parameter_count');
    }
  });
});

describe('validação por posição', () => {
  it('apara strings e usa cliente somente quando falta o nome', () => {
    for (const value of ['', '   ', null, undefined]) expect(renderReminder(0, value).parameters[0]).toBe('cliente');
    expect(renderReminder(0, ' Marina ').parameters[0]).toBe('Marina');
    expect(renderReminder(1, ' Unidade ').parameters[1]).toBe('Unidade');
  });
  it.each(['\n', '\r', '\t', '\u0000', '\u0085', '\u2028', '\u2029', '\u202e', '\u200b'])('recusa controle Unicode %j', control => {
    for (const position of [0, 1, 4]) expect(() => renderReminder(position, `abc${control}def`)).toThrow('template_parameter_invalid');
  });
  it('não expande conteúdo de variável recursivamente', () => {
    expect(renderReminder(0, '{{2}}').body).toContain('Olá, {{2}}.');
  });
  it('recusa nome/unidade/código excessivo sem truncar', () => {
    for (const [position, limit] of [[0, 100], [1, 120], [4, 32]]) {
      expect(renderReminder(position, 'X'.repeat(limit)).parameters[position]).toHaveLength(limit);
      expect(() => renderReminder(position, 'X'.repeat(limit + 1))).toThrow('template_parameter_invalid');
    }
    for (const value of ['', null, 123, {}]) expect(() => renderReminder(1, value)).toThrow('template_parameter_invalid');
    expect(() => renderReminder(4, '')).toThrow('template_parameter_invalid');
  });
  it.each(['0', '-1', '1.5', '1000000', '1e2', 'NaN', '', NaN, Infinity])('recusa pessoas inválidas %j', value => {
    expect(() => renderReminder(3, value)).toThrow('template_parameter_invalid');
  });
  it('formata pessoas e percentual de forma determinística', () => {
    expect(renderReminder(3, 999999).parameters[3]).toBe('999999');
    const parameters: unknown[] = [...fixtures[1][2]];
    parameters[6] = 15.5;
    expect(renderTemplate('res_confirmacao_desconto_v1', parameters, context).parameters[6]).toBe('15.5');
    parameters[6] = '015.500';
    expect(renderTemplate('res_confirmacao_desconto_v1', parameters, context).parameters[6]).toBe('15.5');
    parameters[6] = 0.0000001;
    expect(renderTemplate('res_confirmacao_desconto_v1', parameters, context).parameters[6]).toBe('0.0000001');
    parameters[6] = 100;
    expect(renderTemplate('res_confirmacao_desconto_v1', parameters, context).parameters[6]).toBe('100');
  });
  it.each([0, 101, NaN, Infinity, -1, '', '15%', '15,5', {}, null])('recusa percentual inválido %j', value => {
    const parameters: unknown[] = [...fixtures[6][2]];
    parameters[2] = value;
    expect(() => renderTemplate('mkt_voucher_programado_v1', parameters, context)).toThrow('template_parameter_invalid');
  });
  it.each(['24:00', '20:60', '1:30', '20:30:00', ''])('recusa hora inválida %j', value => {
    expect(() => renderReminder(2, value)).toThrow('template_parameter_invalid');
  });
  it.each(['31/04/2026', '29/02/2026', '00/10/2026', '01/13/2026', '1/10/2026', '20/10/0000'])('recusa data civil inválida %j', value => {
    const parameters: unknown[] = [...fixtures[3][2]];
    parameters[3] = value;
    expect(() => renderTemplate('res_pesquisa_reserva_v1', parameters)).toThrow('template_parameter_invalid');
  });
  it('aceita data bissexta e limites do voucher', () => {
    const parameters: unknown[] = [...fixtures[6][2]];
    parameters[4] = '29/02/2028';
    parameters[3] = 'X'.repeat(64);
    expect(renderTemplate('mkt_voucher_programado_v1', parameters, context).parameters[3]).toHaveLength(64);
    parameters[3] = 'X'.repeat(65);
    expect(() => renderTemplate('mkt_voucher_programado_v1', parameters, context)).toThrow('template_parameter_invalid');
  });
  it('senha da fila segue representação numérica do banco', () => {
    const parameters: unknown[] = [...fixtures[4][2]];
    parameters[2] = 12;
    expect(renderTemplate('fila_entrada_v1', parameters, context).parameters[2]).toBe('12');
    for (const value of [null, '', 'RES123', -1, 1.5]) {
      parameters[2] = value;
      expect(() => renderTemplate('fila_entrada_v1', parameters, context)).toThrow('template_parameter_invalid');
    }
  });
});

describe('links fail-closed', () => {
  it('exige contexto explícito para modelos com links', () => {
    expect(() => renderTemplate('res_lembrete_dia_v1', reminder)).toThrow('template_parameter_invalid');
    expect(() => renderTemplate('res_lembrete_dia_v1', reminder, { allowedOrigins: [] })).toThrow('template_parameter_invalid');
    expect(renderTemplate('res_pesquisa_reserva_v1', fixtures[3][2]).body).toContain('RES123');
  });
  it.each([
    tracking.replace('https:', 'http:'), tracking.replace('example.com', 'evil.example.com'),
    tracking.replace('example.com', 'example.com.evil.test'), tracking.replace('example.com', 'user:pass@example.com'),
    `${tracking}?phone=5511999999999`, `${tracking}?redirect=https://evil.test`, `${tracking}#fragment`,
    'https://example.com/acompanhar/a', tracking.replace('/acompanhar/', '/redirect/'),
    tracking.replace('/acompanhar/', '/x/../acompanhar/'), tracking.replace('/acompanhar/', '/%61companhar/'),
    `${tracking}/`, tracking.replace('example.com/', 'example.com\\'),
  ])('recusa acompanhamento inseguro %j', link => {
    expect(() => renderReminder(5, link)).toThrow('template_parameter_invalid');
  });
  it('recusa origem com caminho como se fosse uma allowlist de origem', () => {
    expect(() => renderTemplate('res_lembrete_dia_v1', reminder, { allowedOrigins: ['https://example.com/path'] })).toThrow('template_parameter_invalid');
  });
  it.each(['A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + 'B', 'A'.repeat(42) + '=', '../redirect'])('recusa token de preferências fora de base64url 256 bits %j', token => {
    const parameters: unknown[] = [...fixtures[6][2]];
    parameters[5] = `https://example.com/preferencias/mensagens/${token}`;
    expect(() => renderTemplate('mkt_voucher_programado_v1', parameters, context)).toThrow('template_parameter_invalid');
  });
  it('feedback permite destino existente em origem explícita sem query/fragmento', () => {
    const parameters: unknown[] = [...fixtures[5][2]];
    parameters[3] = 'https://reviews.example.test/unit/reviews';
    expect(renderTemplate('fila_feedback_v1', parameters, { allowedOrigins: [...context.allowedOrigins, 'https://reviews.example.test'] }).parameters[3]).toBe(parameters[3]);
    for (const value of ['https://example.com/feedback?name=Marina', 'https://example.com/redirect?url=https://evil.test', `https://example.com/${'x'.repeat(493)}`]) {
      parameters[3] = value;
      expect(() => renderTemplate('fila_feedback_v1', parameters, context)).toThrow('template_parameter_invalid');
    }
    parameters[3] = `https://example.com/${'x'.repeat(492)}`;
    expect(renderTemplate('fila_feedback_v1', parameters, context).parameters[3]).toHaveLength(512);
  });
});

describe('hash canônico', () => {
  it('é SHA256 e exclui exemplos e metadados de análise', async () => {
    const definition = TEMPLATE_CATALOG.res_lembrete_dia_v1;
    const hash = await catalogHash(definition);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await catalogHash({ ...definition, examples: [...definition.examples].reverse(), purpose: 'Outra análise' })).toBe(hash);
  });
  it('inclui nome, idioma, categoria, formato e componentes fixos', async () => {
    const definition = TEMPLATE_CATALOG.res_lembrete_dia_v1;
    const hash = await catalogHash(definition);
    for (const change of [{ name: 'outro' }, { language: 'en_US' }, { requestedCategory: 'MARKETING' }, { parameterFormat: 'NAMED' }, { components: [{ type: 'BODY', text: 'outro corpo' }] }]) {
      expect(await catalogHash({ ...definition, ...change })).not.toBe(hash);
    }
  });
  it('canonicaliza chaves/ordem de componentes e finais de linha sem esconder diferenças desconhecidas', async () => {
    const definition = TEMPLATE_CATALOG.fila_feedback_v1;
    const hash = await catalogHash(definition);
    expect(await catalogHash({ ...definition, components: [...definition.components].reverse().map(c => ({ text: c.text.replace(/\n/g, '\r\n'), type: c.type, example: { body_text: [['fictício']] } })) })).toBe(hash);
    expect(await catalogHash({ ...definition, components: definition.components.map(c => ({ ...c, unknown: { b: 2, a: 1 } })) })).toBe(await catalogHash({ ...definition, components: definition.components.map(c => ({ unknown: { a: 1, b: 2 }, text: c.text, type: c.type })) }));
    expect(await catalogHash({ ...definition, components: definition.components.map(c => ({ ...c, unknown: true })) })).not.toBe(hash);
    expect(await catalogHash({ ...definition, components: [...definition.components, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com' }] }] })).not.toBe(hash);
  });
  it('preserva ordem e texto de componentes desconhecidos', async () => {
    const definition = TEMPLATE_CATALOG.fila_feedback_v1;
    const unknown = [{ type: 'UNKNOWN', text: 'a\r\nb' }, { type: 'UNKNOWN', text: 'c' }];
    const hash = await catalogHash({ ...definition, components: unknown });
    expect(await catalogHash({ ...definition, components: [...unknown].reverse() })).not.toBe(hash);
    expect(await catalogHash({ ...definition, components: [{ type: 'UNKNOWN', text: 'a\nb' }, unknown[1]] })).not.toBe(hash);
  });
});

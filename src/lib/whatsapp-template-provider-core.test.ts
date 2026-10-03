import { describe, expect, it } from 'vitest';
import {
  buildTemplateMessage, buildTemplateSubmission, nextTemplateCursor, parseTemplatePage,
  classifyTemplateMutationResponse,
} from '../../supabase/functions/_shared/whatsapp-template-provider-core.ts';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';

describe('template transport core', () => {
  it('preserva DDD 55 e usa BODY posicional', () => {
    const wire = buildTemplateMessage({ toPhone: '55999990000', name: 'res_pesquisa_reserva_v1',
      language: 'pt_BR', parameters: ['Marina', 'RES123', 'Exemplo', '19/10/2026'] });
    expect(wire.to).toBe('5555999990000');
    expect(wire.type).toBe('template');
    expect(wire.template.components[0].parameters[1]).toEqual({ type: 'text', text: 'RES123' });
    expect(wire.template.language).toEqual({ code: 'pt_BR' });
  });

  it('submissão inclui categoria solicitada, formato e exemplos só no BODY', () => {
    const definition = TEMPLATE_CATALOG.mkt_voucher_programado_v1;
    expect(buildTemplateSubmission(definition)).toEqual({
      name: definition.name, language: 'pt_BR', category: 'MARKETING', parameter_format: 'POSITIONAL',
      components: [
        { type: 'BODY', text: definition.body, example: { body_text: definition.examples } },
        { type: 'FOOTER', text: definition.footer },
      ],
    });
    expect(definition.components[0]).not.toHaveProperty('example');
  });

  it('cursor repetido não faz loop', () => {
    expect(() => nextTemplateCursor('a', new Set(['a']))).toThrow('template_cursor_cycle');
    expect(nextTemplateCursor('next+/=', new Set(['a']))).toBe('next+/=');
  });

  it.each([null, 12, '', ' ', 'cursor\n', '\uD800', 'x'.repeat(4097)])('cursor inválido falha fechado: %s', cursor => {
    expect(() => nextTemplateCursor(cursor, new Set())).toThrow('template_cursor_invalid');
  });

  it('cursor isolado na última página não indica continuação', () => {
    expect(parseTemplatePage({ data: [], paging: { cursors: { after: 'last' } } }).nextCursor).toBeNull();
  });

  it('next apenas indica continuação; preserva componentes desconhecidos e estados remotos', () => {
    const components = [{ type: 'BODY', text: 'Oi {{1}}', custom: { mode: 'remote' } }];
    expect(parseTemplatePage({ data: [{ id: 'remote-1', name: 'example', language: 'pt_BR',
      status: 'FUTURE_STATUS', category: 'FUTURE_CATEGORY', parameter_format: 'NAMED', components,
      rejected_reason: 'INVALID_FORMAT' }], paging: {
      next: 'https://untrusted.invalid/token=private', cursors: { after: 'a+/=' },
    } })).toEqual({ templates: [{ remoteId: 'remote-1', name: 'example', language: 'pt_BR',
      status: 'FUTURE_STATUS', category: 'FUTURE_CATEGORY', parameterFormat: 'NAMED', components,
      quality: null, rejectionCode: 'INVALID_FORMAT' }], nextCursor: 'a+/=' });
  });

  it('ausência de conteúdo/formato não inventa compatibilidade; rejeição textual não escapa', () => {
    const page = parseTemplatePage({ data: [{ id: 'r1', name: 'example', language: 'pt_BR',
      status: 'APPROVED', category: 'UTILITY', rejected_reason: 'private token and customer data' }] });
    expect(page.templates[0]).toMatchObject({ components: null, parameterFormat: null, quality: null, rejectionCode: null });
  });

  it.each([null, {}, { data: [null] }, { data: [{ id: 12 }] },
    { data: [], paging: { next: 'https://evil.invalid' } },
    { data: [], paging: { next: true, cursors: { after: 'a' } } },
  ])('resposta incompleta não vira lista vazia: %j', body => {
    expect(() => parseTemplatePage(body)).toThrow('template_response_invalid');
  });

  it('somente rejeição preproxy documentada permite retry mutante', () => {
    expect(classifyTemplateMutationResponse(429, { statusCode: 429, message: 'Rate limit excedido. Tente novamente em 12s.' }))
      .toMatchObject({ state: 'rejected', retryable: true, retryAfterSeconds: 12, errorCode: 'RATE_LIMITED' });
    expect(classifyTemplateMutationResponse(400, { error: { code: 132000, message: 'private' } }))
      .toMatchObject({ state: 'rejected', retryable: false });
    for (const status of [429, 500, 503, 408]) {
      expect(classifyTemplateMutationResponse(status, { error: { message: 'private' } }))
        .toMatchObject({ state: 'uncertain' });
    }
  });
});

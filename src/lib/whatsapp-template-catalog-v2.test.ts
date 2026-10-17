import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogHash, renderTemplate, TEMPLATE_CATALOG, type TemplateId } from '../../supabase/functions/_shared/whatsapp-template-catalog-core.ts';
import { renderTemplateV2, TEMPLATE_V2_CATALOG, type TemplateV2Id } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2.ts';
import { submissionPayloadHash } from '../../supabase/functions/_shared/whatsapp-template-submission-hash.ts';

const spec = readFileSync(resolve(__dirname, '../../docs/superpowers/specs/2026-10-17-whatsapp-template-copy-v2-design.md'), 'utf8');
const context = { allowedOrigins: ['https://example.com'] };
const expectedHashes: Readonly<Record<TemplateV2Id, readonly [string, string]>> = {
  res_confirmacao_v2: ['2c6c958fea3540a686082cfcfcdb97c07d50f14eda492110998326582681a8cf', 'd8dd3a0de8cf5c1994f801a621a2927cdbe0e95a8b683bc84a3a1edbfbd961b2'],
  res_confirmacao_desconto_v2: ['849e18669840b4d768635728943a8ab283169f027be42849551c4ece2dcbc8cd', '7a5feea79c1677fbf32dcd63a0e6401cd82db1680812f8b4fab0456c90c130c9'],
  res_lembrete_dia_v2: ['a5f46ba2e3e3befe852ae7168225d2117070d9c19ef20d57f99785a4d13b7e3b', '93d19b8747d7dbbd3af06e6a564a6d3dd9fbac2e2d97b2b77e72f8cd35c5e6f6'],
  res_pesquisa_reserva_v2: ['5192c9331f94743273dfe12082d84b81dfdae72377989bb139cb9bb5c030cbd6', '2823e01a31bcc293aae6735e1ed00f7e50a3305ad9cae0d18af667247d5aa665'],
  fila_entrada_v2: ['02280d702f9e7d510cf934be027c9e8c66241829df9d64e7253a48d93b8dd41f', '660ab4655eebf4486a0511b51ddc286b6b1266692c5848def12b67e732c1746c'],
  fila_feedback_v2: ['3a14c44bf14122506f6fead845bda012119ec3b59866da3cd7766de1534fff91', 'cc0613ede57717e6df2db3e784280622d19139a2c74233d2861aeeb9409fff2e'],
  mkt_voucher_programado_v2: ['6c712bc43b0cb51192bec4392983c5b5f20ff31cb5b5dced862a1131b5b6de3b', 'd6954b9a606871a06a9b8d31b8691021f42db1dd3e44a6b0d825dc9808f7a162'],
  fila_mesa_pronta_v2: ['5893c535677f123d799cbcfcd5815456f1838982745bc023cf166d4352870dd7', 'db6bf21efdb8aced77486ec4ae7cc0672ea767130ad25ca9c73e7c0e6e9d4c25'],
  res_cancelada_v2: ['3ade2fc5eb5353fcb2de7da65b71b5e76cce2ea88eaad207aaf42cd6edf51423', '1aeb3f759c31c89b7639051048a39e79de00d47e2988caa73c6e3d28dcf6f9be'],
};

function specBody(id: TemplateV2Id): string {
  const heading = `### \`${id}\``;
  const start = spec.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = spec.indexOf('```text\n', start);
  expect(fence).toBeGreaterThanOrEqual(0);
  const finish = spec.indexOf('\n```', fence + 8);
  expect(finish).toBeGreaterThan(fence);
  return spec.slice(fence + 8, finish);
}

const v1Id = (id: TemplateV2Id): TemplateId => id.replace(/_v2$/, '_v1') as TemplateId;

describe('rascunho v2 isolado', () => {
  it('mantém o catálogo operacional v1 com nove nomes e rejeita v2 no renderer operacional', () => {
    expect(Object.keys(TEMPLATE_CATALOG)).toHaveLength(9);
    expect(Object.keys(TEMPLATE_CATALOG).every(id => id.endsWith('_v1'))).toBe(true);
    expect(Object.keys(TEMPLATE_V2_CATALOG)).toHaveLength(9);
    expect(Object.keys(TEMPLATE_V2_CATALOG).every(id => id.endsWith('_v2'))).toBe(true);
    expect(() => renderTemplate('res_confirmacao_v2' as TemplateId, [])).toThrow('template_unknown');
  });

  it.each(Object.keys(TEMPLATE_V2_CATALOG) as TemplateV2Id[])('%s espelha posição, exemplos, gatilho e categoria v1 sem editar a definição publicada', async id => {
    const v1 = TEMPLATE_CATALOG[v1Id(id)];
    const v2 = TEMPLATE_V2_CATALOG[id];
    expect(v2).toMatchObject({ id, name: id, version: 2, state: 'draft', language: 'pt_BR', parameterFormat: 'POSITIONAL',
      purpose: v1.purpose, requestedCategory: v1.requestedCategory, allowedTriggers: v1.allowedTriggers });
    expect(v2.variables).toEqual(v1.variables);
    expect(v2.examples).toEqual(v1.examples);
    expect(v2.footer).toBe(v1.footer);
    expect(v2.components).toEqual([{ type: 'BODY', text: v2.body }, ...(v1.footer ? [{ type: 'FOOTER', text: v1.footer }] : [])]);
    expect(v2.body).toBe(specBody(id));
    expect(v2.body.length).toBeLessThanOrEqual(1024);
    expect(v2.body).toContain('\n\n');
    expect(v2.body).not.toContain('pessoa(s)');
    const emojis = [...v2.body.matchAll(/\p{Extended_Pictographic}/gu)];
    expect(emojis).toHaveLength(id === 'res_cancelada_v2' ? 0 : 1);
    const rendered = renderTemplateV2(id, v2.examples[0], context);
    expect(rendered.parameters).toEqual(v1.examples[0]);
    expect(rendered.footer).toBe(v1.footer);
    expect(rendered.body).not.toContain('{{');
    expect(rendered.body).toContain('\n\n');
    for (const parameter of v2.examples[0].filter(value => value.startsWith('https://'))) {
      expect(rendered.body.split(parameter)[1]).toMatch(/^(?:\n|$)/);
      expect(rendered.body).not.toContain(`${parameter}.`);
    }
    expect(await catalogHash(v2)).toBe(expectedHashes[id][0]);
    expect(await submissionPayloadHash(v2)).toBe(expectedHashes[id][1]);
  });

  it('prevê uma pessoa e quatro pessoas sem concordância artificial nem dados reais', () => {
    const definition = TEMPLATE_V2_CATALOG.res_confirmacao_v2;
    const one = [...definition.examples[0]]; one[4] = '1';
    const four = [...definition.examples[0]]; four[4] = '4';
    expect(renderTemplateV2(definition.id, one, context).body).toContain('Pessoas na reserva: 1.');
    expect(renderTemplateV2(definition.id, four, context).body).toContain('Pessoas na reserva: 4.');
    expect(renderTemplateV2('fila_entrada_v2', ['Marina', 'Restaurante Exemplo', '12', '1', definition.examples[0][6]], context).body)
      .toContain('Pessoas no seu grupo: 1.');
  });

  it('usa o mesmo validador v1 e não aceita parâmetro ausente nem URL alterada', () => {
    const definition = TEMPLATE_V2_CATALOG.res_confirmacao_v2;
    expect(() => renderTemplateV2(definition.id, definition.examples[0].slice(1), context)).toThrow('template_parameter_count');
    const bad = [...definition.examples[0]]; bad[6] += '?redirect=evil';
    expect(() => renderTemplateV2(definition.id, bad, context)).toThrow('template_parameter_invalid');
    expect(() => renderTemplateV2('toString' as TemplateV2Id, [])).toThrow('template_unknown');
  });

  it('detecta drift do texto e dos exemplos no hash do payload completo', async () => {
    const definition = TEMPLATE_V2_CATALOG.res_confirmacao_v2;
    const [content, payload] = expectedHashes[definition.id];
    expect(await catalogHash({ ...definition, components: [{ type: 'BODY', text: `${definition.body}!` }] })).not.toBe(content);
    expect(await submissionPayloadHash({ ...definition, examples: [['Outro nome', ...definition.examples[0].slice(1)]] })).not.toBe(payload);
  });

  it('congela profundamente o rascunho e mantém as afirmações ligadas aos gatilhos', () => {
    const frozen = (value: unknown): boolean => value === null || typeof value !== 'object'
      || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(TEMPLATE_V2_CATALOG)).toBe(true);
    expect(TEMPLATE_V2_CATALOG.res_confirmacao_desconto_v2.body).toContain('já está aplicado');
    expect(TEMPLATE_V2_CATALOG.mkt_voucher_programado_v2.body).toContain('disponibilizou um voucher');
    expect(TEMPLATE_V2_CATALOG.fila_entrada_v2.body).toContain('foi registrada');
    expect(TEMPLATE_V2_CATALOG.fila_mesa_pronta_v2.body).toContain('está pronta');
    expect(TEMPLATE_V2_CATALOG.res_cancelada_v2.body).toContain('foi cancelada');
  });
});

import {
  renderTemplateDefinition, TEMPLATE_CATALOG,
  type TemplateDefinition, type TemplateId, type TemplateRender, type TemplateRenderContext,
} from './whatsapp-template-catalog-core.ts';

type V2Name<T extends string> = T extends `${infer Stem}_v1` ? `${Stem}_v2` : never;
export type TemplateV2Id = V2Name<TemplateId>;

/** Local copy candidate. Its draft state and separate map cannot enter the v1 operational selector. */
export type TemplateV2Definition = Omit<TemplateDefinition, 'id' | 'name' | 'version' | 'state'> & Readonly<{
  id: TemplateV2Id;
  name: TemplateV2Id;
  version: 2;
  state: 'draft';
}>;

function draft(v1: TemplateDefinition, name: TemplateV2Id, body: string): TemplateV2Definition {
  if (name !== `${v1.id.slice(0, -3)}_v2`) throw new Error('template_version_mismatch');
  return {
    ...v1, id: name, name, version: 2, state: 'draft', body,
    components: [{ type: 'BODY', text: body }, ...(v1.footer ? [{ type: 'FOOTER' as const, text: v1.footer }] : [])],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Nine proposed texts, unavailable to v1 seeding, snapshots, automation and dispatch. */
export const TEMPLATE_V2_CATALOG: Readonly<Record<TemplateV2Id, TemplateV2Definition>> = deepFreeze({
  res_confirmacao_v2: draft(TEMPLATE_CATALOG.res_confirmacao_v1, 'res_confirmacao_v2',
    'Olá, {{1}}! Sua reserva na unidade {{2}} está confirmada. 🍽️\n\nDia {{3}}, às {{4}}. Pessoas na reserva: {{5}}.\nCódigo da reserva: {{6}}.\n\nConfira os detalhes: {{7}}\n\nSe precisar alterar algo, responda por aqui.'),
  res_confirmacao_desconto_v2: draft(TEMPLATE_CATALOG.res_confirmacao_desconto_v1, 'res_confirmacao_desconto_v2',
    'Olá, {{1}}! Sua reserva na unidade {{2}} está confirmada. 🍽️\n\nDia {{3}}, às {{4}}. Pessoas na reserva: {{5}}.\nCódigo da reserva: {{6}}.\nO desconto de {{7}}% já está aplicado a esta reserva.\n\nConfira os detalhes: {{8}}\n\nSe precisar alterar algo, responda por aqui.'),
  res_lembrete_dia_v2: draft(TEMPLATE_CATALOG.res_lembrete_dia_v1, 'res_lembrete_dia_v2',
    'Olá, {{1}}! Passando para lembrar: sua reserva na unidade {{2}} é hoje, às {{3}}. 🕒\n\nPessoas na reserva: {{4}}. Código: {{5}}.\nDetalhes: {{6}}\n\nPrecisa ajustar algo? Responda por aqui.'),
  res_pesquisa_reserva_v2: draft(TEMPLATE_CATALOG.res_pesquisa_reserva_v1, 'res_pesquisa_reserva_v2',
    'Olá, {{1}}! Queremos saber como foi o atendimento da sua reserva {{2}} na unidade {{3}}, em {{4}}. 💬\n\nDe 1 a 5, qual nota você daria? Responda apenas com o número.\n\nSua opinião nos ajuda a melhorar. Obrigado!'),
  fila_entrada_v2: draft(TEMPLATE_CATALOG.fila_entrada_v1, 'fila_entrada_v2',
    'Olá, {{1}}! Sua entrada na fila de espera da unidade {{2}} foi registrada. ⏳\n\nSenha da fila: {{3}}. Pessoas no seu grupo: {{4}}.\nAcompanhe a fila: {{5}}\n\nAvisaremos por aqui quando sua mesa estiver pronta.'),
  fila_feedback_v2: draft(TEMPLATE_CATALOG.fila_feedback_v1, 'fila_feedback_v2',
    'Olá, {{1}}! Como foi sua experiência na fila da unidade {{2}} em {{3}}? 💬\n\nSe quiser compartilhar sua opinião, acesse: {{4}}\n\nPreferências de mensagens: {{5}}\n\nObrigado por nos ajudar a melhorar.'),
  mkt_voucher_programado_v2: draft(TEMPLATE_CATALOG.mkt_voucher_programado_v1, 'mkt_voucher_programado_v2',
    'Olá, {{1}}! A unidade {{2}} disponibilizou um voucher para sua próxima visita. 🎁\n\nDesconto: {{3}}%. Código: {{4}}. Válido até {{5}}.\nApresente o código ao pagar e consulte as condições com a unidade.\n\nPreferências de mensagens: {{6}}'),
  fila_mesa_pronta_v2: draft(TEMPLATE_CATALOG.fila_mesa_pronta_v1, 'fila_mesa_pronta_v2',
    'Olá, {{1}}! Sua mesa na unidade {{2}} está pronta. 🍽️\n\nSenha da fila: {{3}}.\n\nPor favor, dirija-se à recepção.'),
  res_cancelada_v2: draft(TEMPLATE_CATALOG.res_cancelada_v1, 'res_cancelada_v2',
    'Olá, {{1}}. Sua reserva na unidade {{2}} foi cancelada.\n\nData: {{3}}, às {{4}}. Pessoas na reserva: {{5}}.\nCódigo da reserva: {{6}}.\n\nSe foi um engano ou quiser remarcar, responda por aqui.'),
});

/** Preview only. This does not select a version for a production intent or authorize submission. */
export function renderTemplateV2(id: TemplateV2Id, input: readonly unknown[], context?: TemplateRenderContext): TemplateRender {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_V2_CATALOG, id)) throw new Error('template_unknown');
  return renderTemplateDefinition(TEMPLATE_V2_CATALOG[id], input, context);
}

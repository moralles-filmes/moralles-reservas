/** Pure platform catalog: transport, eligibility and resource authorization belong to callers. */
export type TemplateId =
  | 'res_confirmacao_v1' | 'res_confirmacao_desconto_v1' | 'res_lembrete_dia_v1'
  | 'res_pesquisa_reserva_v1' | 'fila_entrada_v1' | 'fila_feedback_v1'
  | 'mkt_voucher_programado_v1' | 'fila_mesa_pronta_v1' | 'res_cancelada_v1';

type VariableKind = 'customer' | 'unit' | 'date' | 'time' | 'people'
  | 'reservation_code' | 'queue_code' | 'voucher_code' | 'percent'
  | 'tracking_url' | 'feedback_url' | 'preferences_url';
type TemplateVariable = Readonly<{ name: string; kind: VariableKind; maxLength?: number }>;
type TemplateComponent = Readonly<{ type: 'BODY' | 'FOOTER'; text: string }>;

export interface TemplateDefinition {
  readonly id: TemplateId;
  readonly name: TemplateId;
  readonly version: 1;
  readonly language: 'pt_BR';
  readonly requestedCategory: 'UTILITY' | 'MARKETING';
  readonly parameterFormat: 'POSITIONAL';
  readonly purpose: string;
  readonly allowedTriggers: readonly string[];
  /** Catalog lifecycle; independent of remote approval/provisioning status. */
  readonly state: 'active' | 'superseded' | 'retired';
  readonly body: string;
  readonly footer: string | null;
  readonly components: readonly TemplateComponent[];
  readonly variables: readonly TemplateVariable[];
  readonly examples: readonly (readonly string[])[];
}

export interface TemplateRender {
  readonly body: string;
  readonly footer: string | null;
  readonly parameters: readonly string[];
}

export interface TemplateRenderContext {
  readonly allowedOrigins: readonly string[];
}

const FOOTER = 'Para não receber ofertas, use o link de preferências.';
const EXAMPLE_TRACKING = 'https://example.com/acompanhar/00000000-0000-4000-8000-000000000001';
const EXAMPLE_PREFERENCES = `https://example.com/preferencias/mensagens/${'A'.repeat(43)}`;
const variable = (name: string, kind: VariableKind, maxLength?: number): TemplateVariable => ({ name, kind, ...(maxLength === undefined ? {} : { maxLength }) });
const customer = variable('cliente', 'customer', 100);
const unit = variable('unidade', 'unit', 120);
const date = variable('data', 'date', 10);
const time = variable('hora', 'time', 5);
const people = variable('pessoas', 'people', 6);
const reservationCode = variable('codigo_reserva', 'reservation_code', 32);
const tracking = variable('acompanhamento', 'tracking_url', 512);
const percent = variable('percentual', 'percent');
const preferences = variable('preferencias', 'preferences_url', 512);

function definition(
  id: TemplateId, category: TemplateDefinition['requestedCategory'], purpose: string,
  allowedTriggers: readonly string[], body: string, variables: readonly TemplateVariable[],
  examples: readonly string[],
): TemplateDefinition {
  const footer = category === 'MARKETING' ? FOOTER : null;
  return {
    id, name: id, version: 1, language: 'pt_BR', requestedCategory: category,
    parameterFormat: 'POSITIONAL', purpose, allowedTriggers, state: 'active', body, footer,
    components: [{ type: 'BODY', text: body }, ...(footer ? [{ type: 'FOOTER' as const, text: footer }] : [])],
    variables, examples: [examples],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const TEMPLATE_CATALOG: Readonly<Record<TemplateId, TemplateDefinition>> = deepFreeze({
  res_confirmacao_v1: definition(
    'res_confirmacao_v1', 'UTILITY', 'Confirmação de reserva', ['reservation_confirmed'],
    'Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).\nCódigo da reserva: {{6}}.\nDetalhes da reserva: {{7}}.\nPara solicitar uma alteração, responda a esta mensagem.',
    [customer, unit, date, time, people, reservationCode, tracking],
    ['Marina', 'Restaurante Exemplo', '20/10/2026', '20:30', '4', 'RES123', EXAMPLE_TRACKING],
  ),
  res_confirmacao_desconto_v1: definition(
    'res_confirmacao_desconto_v1', 'UTILITY', 'Confirmação de reserva com desconto aplicado', ['reservation_confirmed'],
    'Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).\nCódigo da reserva: {{6}}. Desconto já aplicado à reserva: {{7}}%.\nDetalhes da reserva: {{8}}.\nPara solicitar uma alteração, responda a esta mensagem.',
    [customer, unit, date, time, people, reservationCode, percent, tracking],
    ['Marina', 'Restaurante Exemplo', '20/10/2026', '20:30', '4', 'RES123', '15', EXAMPLE_TRACKING],
  ),
  res_lembrete_dia_v1: definition(
    'res_lembrete_dia_v1', 'UTILITY', 'Lembrete no dia da reserva', ['reservation_reminder'],
    'Olá, {{1}}. Este é o lembrete da sua reserva de hoje em {{2}}, às {{3}}, para {{4}} pessoa(s).\nCódigo da reserva: {{5}}.\nDetalhes da reserva: {{6}}.\nPara solicitar uma alteração, responda a esta mensagem.',
    [customer, unit, time, people, reservationCode, tracking],
    ['Marina', 'Restaurante Exemplo', '20:30', '4', 'RES123', EXAMPLE_TRACKING],
  ),
  res_pesquisa_reserva_v1: definition(
    'res_pesquisa_reserva_v1', 'UTILITY', 'Pesquisa sobre reserva', ['reservation_survey'],
    'Olá, {{1}}. Sobre sua reserva {{2}} em {{3}}, marcada para {{4}}: de 1 a 5, como você avalia o atendimento?\nResponda apenas com o número, sendo 1 muito insatisfeito e 5 muito satisfeito.\nObrigado pela sua avaliação.',
    [customer, reservationCode, unit, date], ['Marina', 'RES123', 'Restaurante Exemplo', '19/10/2026'],
  ),
  fila_entrada_v1: definition(
    'fila_entrada_v1', 'UTILITY', 'Registro de entrada na fila', ['waitlist_entered'],
    'Olá, {{1}}. Sua entrada na fila de espera de {{2}} foi registrada.\nSenha da fila: {{3}}. Quantidade de pessoas: {{4}}.\nAcompanhamento: {{5}}.\nAvisaremos quando sua mesa estiver pronta.',
    [customer, unit, variable('senha_fila', 'queue_code', 10), people, tracking],
    ['Marina', 'Restaurante Exemplo', '12', '4', EXAMPLE_TRACKING],
  ),
  fila_feedback_v1: definition(
    'fila_feedback_v1', 'MARKETING', 'Pesquisa pós-fila', ['waitlist_feedback'],
    'Olá, {{1}}. A {{2}} gostaria de saber sua opinião sobre o atendimento referente à sua passagem pela fila em {{3}}.\nAcesse: {{4}}.\nPreferências de mensagens: {{5}}.\nObrigado por compartilhar sua experiência.',
    [customer, unit, date, variable('destino_feedback', 'feedback_url', 512), preferences],
    ['Marina', 'Restaurante Exemplo', '19/10/2026', 'https://example.com/feedback', EXAMPLE_PREFERENCES],
  ),
  mkt_voucher_programado_v1: definition(
    'mkt_voucher_programado_v1', 'MARKETING', 'Voucher programado já emitido', ['voucher_birthday', 'voucher_frequency'],
    'Olá, {{1}}. A {{2}} disponibilizou {{3}}% de desconto para sua próxima visita.\nCódigo do voucher: {{4}}. Válido até {{5}}.\nApresente o código ao pagar e consulte as condições do benefício com a unidade.\nPreferências de mensagens: {{6}}.\nVocê pode atualizar sua escolha pelo link.',
    [customer, unit, percent, variable('codigo_voucher', 'voucher_code', 64), variable('validade', 'date', 10), preferences],
    ['Marina', 'Restaurante Exemplo', '15', 'VCH12345', '30/10/2026', EXAMPLE_PREFERENCES],
  ),
  fila_mesa_pronta_v1: definition(
    'fila_mesa_pronta_v1', 'UTILITY', 'Aviso de mesa pronta da fila', ['waitlist_table_ready'],
    'Olá, {{1}}. Sua mesa em {{2}} está pronta.\nSenha da fila: {{3}}.\nPor favor, dirija-se à recepção.',
    [customer, unit, variable('senha_fila', 'queue_code', 10)], ['Marina', 'Restaurante Exemplo', '12'],
  ),
  res_cancelada_v1: definition(
    'res_cancelada_v1', 'UTILITY', 'Aviso de reserva cancelada', ['reservation_cancelled'],
    'Olá, {{1}}. Sua reserva em {{2}} foi cancelada.\nData: {{3}}. Horário: {{4}}. Pessoas: {{5}}.\nCódigo da reserva: {{6}}.\nSe foi engano ou quiser remarcar, responda a esta mensagem.',
    [customer, unit, date, time, people, reservationCode], ['Marina', 'Restaurante Exemplo', '20/10/2026', '20:30', '4', 'RES123'],
  ),
});

// Reject controls before trimming, including bidi/format controls and line separators.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TRACKING_PATH = new RegExp(`^/acompanhar/${UUID}$`, 'i');
// 32 bytes encode into 43 base64url characters; final character has two zero pad bits.
const PREFERENCES_PATH = /^\/preferencias\/mensagens\/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const invalid = (): never => { throw new Error('template_parameter_invalid'); };

function validDate(value: string): boolean {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const [, dd, mm, yyyy] = match;
  const day = Number(dd), month = Number(mm), year = Number(yyyy);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validUrl(value: string, kind: VariableKind, context?: TemplateRenderContext): boolean {
  // URL parser normalizes backslashes, dot segments and escapes; reject them before parsing.
  if (!/^https:\/\//.test(value) || /[\s\\%]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
    if (!context?.allowedOrigins.some(origin => {
      const allowed = new URL(origin);
      return allowed.protocol === 'https:' && !allowed.username && !allowed.password
        && !allowed.search && !allowed.hash && allowed.pathname === '/'
        && origin === allowed.origin && url.origin === allowed.origin;
    })) return false;
    // Exact serialization also refuses normalized paths, empty query/fragment and credentials.
    if (url.href !== value) return false;
    if (kind === 'tracking_url') return TRACKING_PATH.test(url.pathname);
    if (kind === 'preferences_url') return PREFERENCES_PATH.test(url.pathname);
    return kind === 'feedback_url';
  } catch { return false; }
}

function validateParameter(schema: TemplateVariable, input: unknown, context?: TemplateRenderContext): string {
  if (schema.kind === 'customer' && (input === null || input === undefined)) return 'cliente';
  const numeric = schema.kind === 'percent' || schema.kind === 'people' || schema.kind === 'queue_code';
  if (typeof input !== 'string' && !(numeric && typeof input === 'number')) return invalid();
  if (typeof input === 'string' && UNSAFE_TEXT.test(input)) return invalid();
  const value = typeof input === 'string' ? input.trim() : String(input);
  if (!value && schema.kind === 'customer') return 'cliente';
  if (!value || (schema.maxLength !== undefined && value.length > schema.maxLength)) return invalid();
  switch (schema.kind) {
    case 'percent': {
      if (typeof input === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return invalid();
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0 || number > 100) return invalid();
      const decimal = String(number);
      if (!decimal.includes('e')) return decimal;
      // Positive percentages below 1 can use exponent notation in JS; emit decimal text.
      const [mantissa, exponent] = decimal.split('e');
      const digits = mantissa.replace('.', '');
      const point = mantissa.indexOf('.') < 0 ? mantissa.length : mantissa.indexOf('.');
      const shifted = point + Number(exponent);
      return shifted <= 0 ? `0.${'0'.repeat(-shifted)}${digits}`
        : `${digits.slice(0, shifted)}.${digits.slice(shifted)}`;
    }
    case 'people':
    case 'queue_code': {
      if (!/^\d+$/.test(value)) return invalid();
      const number = Number(value);
      const max = schema.kind === 'people' ? 999999 : 2147483647;
      if (!Number.isSafeInteger(number) || number <= 0 || number > max) return invalid();
      return String(number);
    }
    case 'date': if (!validDate(value)) return invalid(); break;
    case 'time': if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid(); break;
    case 'tracking_url':
    case 'feedback_url':
    case 'preferences_url': if (!validUrl(value, schema.kind, context)) return invalid(); break;
  }
  return value;
}

/** Returns the same values for provider parameters and preview/history; never expands variables recursively. */
export function renderTemplate(id: TemplateId, input: readonly unknown[], context?: TemplateRenderContext): TemplateRender {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_CATALOG, id)) throw new Error('template_unknown');
  const template = TEMPLATE_CATALOG[id];
  if (!Array.isArray(input) || input.length !== template.variables.length) throw new Error('template_parameter_count');
  const parameters = template.variables.map((schema, position) => validateParameter(schema, input[position], context));
  const body = template.body.replace(/\{\{(\d+)\}\}/g, (_match, position: string) => {
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= parameters.length) throw new Error('template_placeholder_invalid');
    return parameters[index];
  });
  return { body, footer: template.footer, parameters };
}

interface HashDefinition {
  readonly name: string;
  readonly language: string;
  readonly requestedCategory: string;
  readonly parameterFormat: string;
  readonly components: readonly Readonly<Record<string, unknown>>[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** SHA256 of fixed submission fields. Unknown remote component fields remain in the digest. */
export async function catalogHash<T extends HashDefinition>(definition: T): Promise<string> {
  const components = definition.components.map(component => {
    // Meta's known component example field is submission metadata, not fixed content.
    const { example: _example, ...rest } = component;
    const fixed: Record<string, unknown> = { ...rest };
    if ((fixed.type === 'BODY' || fixed.type === 'FOOTER') && typeof fixed.text === 'string') {
      fixed.text = fixed.text.replace(/\r\n?/g, '\n');
    }
    return canonical(fixed);
  });
  // Only our known component set has order-independent semantics. Unknown arrays keep order.
  if (definition.components.every(component => component.type === 'BODY' || component.type === 'FOOTER')) {
    components.sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  const serialized = JSON.stringify(canonical({
    name: definition.name, language: definition.language, requestedCategory: definition.requestedCategory,
    parameterFormat: definition.parameterFormat, components,
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

import { automationDeadline, type AutomationPreflightReason, type AutomationTemplateId, type AutomationVersionSelection, type ScheduledIntent } from './whatsapp-automation-core.ts';
import { canonicalBrPhone, toE164BrPhone } from './phone.ts';
import { brtFactAt } from './whatsapp-message-ttl-core.ts';
import { renderTemplate, type TemplateId } from './whatsapp-template-catalog-core.ts';
import { renderTemplateV2, type TemplateV2Id } from './whatsapp-template-catalog-v2.ts';
import { catalogDefinition } from './whatsapp-template-cohort.ts';
import { DEFAULT_ENTERED_BODY, DEFAULT_FEEDBACK_BODY, DEFAULT_TABLE_READY_BODY, renderWaitlistTemplate } from './waitlist-defaults.ts';

export type AutomationResourceTable = 'reservations' | 'waitlist' | 'vouchers' | 'voucher_rules' |
  'customers' | 'units' | 'organizations' | 'settings';
export interface AutomationResourceIO {
  readOne(table: AutomationResourceTable, columns: string, predicates: Readonly<Record<string, string>>): Promise<unknown>;
  now(): number;
}

/** Preserve the existing TEXT templates/chips; official rendering remains catalog-only. */
export async function renderScheduledText(resource: ScheduledResource, io: {
  readOne(table: string, columns: string, predicates: Readonly<Record<string, string>>): Promise<unknown>;
  appBaseUrl: string; allowedOrigins: readonly string[];
}, preferenceToken?: string) {
  if (!resource.templateId.endsWith('_v1')) throw new Error('render_invalid');
  // Validate configured links/required values with the same renderer before legacy substitution.
  const official = renderScheduledTemplate(resource, io.appBaseUrl, io.allowedOrigins, preferenceToken);
  const r = resource, kind = r.intent.kind;
  const base = new URL(io.appBaseUrl).origin;
  const tracking = `${base}/acompanhar/${r.intent.reservationId ?? r.intent.waitlistId}`;
  const day = r.date?.split('-').reverse().join('/') ?? '';
  let body: string;
  if (kind === 'confirmation') {
    body = `✅ *Reserva Confirmada!*\n\nOlá ${r.customerName}, sua reserva está confirmada.\n\n` +
      `📅 Data: ${day}\n⏰ Horário: ${r.time}\n👥 Pessoas: ${r.people}\n` +
      (r.discount !== null && r.discount > 0 ? `💸 Desconto: ${r.discount}% off\n` : '') +
      `🔑 Código: #${r.code}\n\nPara alterar ou cancelar, é só responder aqui. Até logo! 😊`;
  } else if (kind === 'cancellation') {
    // Same TEXT that send-cancellation sends today; time comes normalized to HH:MM.
    body = `❌ *Reserva Cancelada*\n\nOlá ${r.customerName}, sua reserva foi cancelada.\n\n` +
      `📅 Data: ${day}\n⏰ Horário: ${r.time}\n👥 Pessoas: ${r.people}\n🔑 Código: #${r.code}\n\n` +
      `Se foi engano ou quiser remarcar, é só responder aqui que ajudamos. 🙏`;
  } else if (kind === 'waitlist_entered' || kind === 'waitlist_feedback' || kind === 'waitlist_table_ready') {
    const event = kind === 'waitlist_entered' ? 'entered' : kind === 'waitlist_table_ready' ? 'table_ready' : 'feedback';
    const saved = record(await io.readOne('waitlist_message_templates', 'customized,body', { unit_id: r.unitId, event }));
    const template = saved?.customized === true && typeof saved.body === 'string' && saved.body.trim() ? saved.body
      : kind === 'waitlist_entered' ? DEFAULT_ENTERED_BODY : kind === 'waitlist_table_ready' ? DEFAULT_TABLE_READY_BODY : DEFAULT_FEEDBACK_BODY;
    body = renderWaitlistTemplate(template, { cliente_nome: r.customerName || 'cliente', unidade_nome: r.unitName,
      party_size: r.people, codigo_fila: typeof r.code === 'number' ? r.code : Number(r.code),
      link_status: kind === 'waitlist_feedback' ? `${base}/r/${r.unitSlug}` : tracking });
  } else if (kind === 'voucher_issued') {
    const saved = record(await io.readOne('settings', 'value', { unit_id: r.unitId, key: 'giftback_message_template' }));
    // Same saved TEXT contract as giftback.ts without its remote SDK import in the frontend graph.
    const template = typeof saved?.value === 'string' && saved.value ? saved.value :
      '🎁 Você ganhou {{discount}}% de desconto na sua próxima visita ao {{unidade}}!\n\nCódigo: *{{codigo}}*\nVálido até *{{validade}}*.\n\nApresente esse código quando for pagar.';
    body = template.replaceAll('{{discount}}', String(r.discount)).replaceAll('{{unidade}}', r.unitName)
      .replaceAll('{{codigo}}', String(r.code)).replaceAll('{{validade}}', day);
  } else {
    const saved = record(await io.readOne('reservation_message_templates', 'customized,body', { unit_id: r.unitId, event: kind }));
    const defaultBody = kind === 'reminder_d1'
      ? 'Olá, {{cliente_nome}}! 👋\n\nLembrete da sua reserva hoje às {{horario}} para {{party_size}} pessoa(s) em {{unidade_nome}}.\n\nCódigo: #{{codigo}}\n\nAcompanhe sua reserva: {{link_acompanhamento}}\n\nPara alterar ou cancelar, é só responder esta mensagem. Te esperamos! 🍽️'
      : 'Oi, {{cliente_nome}}! 🙂\n\nEsperamos que tenha gostado da sua visita ao {{unidade_nome}} ontem.\n\nDe 1 a 5, como você avalia sua experiência? (responda só o número)\n\nObrigado por nos ajudar a melhorar! 💛';
    body = saved?.customized === true && typeof saved.body === 'string' && saved.body.trim() ? saved.body : defaultBody;
    const vars: Record<string, string> = { cliente_nome: r.customerName || 'cliente', codigo: String(r.code), unidade_nome: r.unitName };
    if (kind === 'reminder_d1') Object.assign(vars, { horario: r.time, party_size: String(r.people), link_acompanhamento: tracking });
    for (const [key, value] of Object.entries(vars)) body = body.replaceAll(`{{${key}}}`, value);
  }
  if (kind === 'waitlist_feedback' || kind === 'voucher_issued') body += `\n\nPreferências: ${base}/preferencias/mensagens/${preferenceToken}`;
  if (!body.trim() || body.length > 4096) throw new Error('render_invalid');
  return { ...official, body, safeLogBody: body.replace(/\/preferencias\/mensagens\/[A-Za-z0-9_-]{43}/g, '/preferencias/mensagens/[redacted]') };
}
export interface ScheduledResource {
  intent: ScheduledIntent;
  unitId: string; organizationId: string; customerId: string | null;
  phone: string; e164: string; customerName: string; unitName: string; unitSlug: string | null;
  timezone: string; templateId: AutomationTemplateId; date: string | null; time: string | null;
  code: string | number; people: number | null; discount: number | null; benefitExpiry: string | null;
  createdAt: string | null; issuedAt: string | null; source: string | null;
  expiresAt: string; snapshot: string; expected: ScheduledResourceExpected;
}

/** The caller supplies only a decoded ledger pin, never a browser/provider version hint. */
export function pinScheduledTemplate(resource: ScheduledResource, selection: AutomationVersionSelection, initialCatalogKey: AutomationTemplateId | null): ScheduledResource {
  const key = selection.version === 1 ? resource.templateId : `${resource.templateId.slice(0, -3)}_v2`;
  const definition = catalogDefinition(key, selection.version);
  if (!definition || (initialCatalogKey !== null && initialCatalogKey !== definition.id)
    || (selection.version === 2 && initialCatalogKey === null)) throw new Error('template_pin_changed');
  return { ...resource, templateId: definition.id };
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ReservationExpected = { id: string; unit_id: string; customer_id: string; date: string; time: string;
  status: string; payment_status: string | null; source: string; party_size: number; reservation_code: string;
  applied_discount_percent: number | null; satisfaction_rating: number | null };
type WaitlistExpected = { id: string; unit_id: string; customer_id: string | null; customer_name: string | null;
  customer_phone: string; party_size: number; code: number; status: string; created_at: string; seated_at: string | null };
type VoucherExpected = { id: string; unit_id: string; customer_id: string; rule_id: string; code: string;
  discount_percent: number; status: string; issued_at: string; created_at: string; expires_at: string };
/** Equality assertions only; the last SQL operation derives identity/authority from its job. Never persisted. */
export type ScheduledResourceExpected = {
  version: 1;
  customer: { id: string; organization_id: string; name: string | null; phone: string; do_not_contact: false; deleted_at: null } | null;
  unit: { id: string; organization_id: string; name: string; slug: string | null; timezone: string | null };
  rule: { id: string; unit_id: string; trigger_type: 'birthday' | 'frequency' } | null;
  setting: { key: string | null; present: boolean; value: Json };
} & ({ kind: 'confirmation' | 'reminder_d1' | 'survey_d1' | 'cancellation'; resource: ReservationExpected } |
  { kind: 'waitlist_entered' | 'waitlist_feedback' | 'waitlist_table_ready'; resource: WaitlistExpected } |
  { kind: 'voucher_issued'; resource: VoucherExpected });
export type ScheduledResourceResult = { ok: true; resource: ScheduledResource } |
  { ok: false; reason: AutomationPreflightReason };
const columns = {
  reservations: 'id,unit_id,customer_id,date,time,status,payment_status,source,party_size,reservation_code,applied_discount_percent,satisfaction_rating,cancelled_at',
  waitlist: 'id,unit_id,customer_id,customer_name,customer_phone,party_size,code,status,created_at,seated_at,notified_at,notified_server_at',
  vouchers: 'id,unit_id,customer_id,rule_id,code,discount_percent,status,issued_at,created_at,expires_at',
  customers: 'id,organization_id,name,phone,do_not_contact,deleted_at',
} as const;
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
function instant(value: unknown): string | null {
  return typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
const captureInvalid = (): never => { throw new Error('resource_capture_invalid'); };
function capturedText(value: unknown): string { return typeof value === 'string' ? value : captureInvalid(); }
function capturedCode(value: unknown): string { const code = capturedText(value); return code.trim() ? code : captureInvalid(); }
function capturedNullableText(value: unknown): string | null { return value === null ? null : capturedText(value); }
function capturedUuid(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : captureInvalid();
}
function capturedInteger(value: unknown, min: number, max = 2147483647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : captureInvalid();
}
function capturedNullableInteger(value: unknown, min: number, max: number): number | null {
  return value === null ? null : capturedInteger(value, min, max);
}
function capturedInstant(value: unknown): string {
  if (typeof value !== 'string' || !date(value.slice(0, 10))
    || !/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return captureInvalid();
  return instant(value) ?? captureInvalid();
}
function capturedJson(value: unknown, depth = 0): Json {
  if (depth > 32) return captureInvalid();
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : captureInvalid();
  if (Array.isArray(value)) return value.map(x => capturedJson(x, depth + 1));
  const row = record(value);
  if (!row) return captureInvalid();
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, capturedJson(v, depth + 1)]));
}
function captureExpected(intent: ScheduledIntent, row: Record<string, unknown>, unit: Record<string, unknown>,
  customer: Record<string, unknown> | null, rule: Record<string, unknown> | null, key: string | null,
  setting: Record<string, unknown> | null): ScheduledResourceExpected {
  const common: Pick<ScheduledResourceExpected, 'version' | 'unit' | 'customer' | 'rule' | 'setting'> = { version: 1,
    unit: { id: capturedUuid(unit.id), organization_id: capturedUuid(unit.organization_id), name: capturedText(unit.name),
      slug: capturedNullableText(unit.slug), timezone: capturedNullableText(unit.timezone) },
    customer: customer ? { id: capturedUuid(customer.id), organization_id: capturedUuid(customer.organization_id),
      name: capturedNullableText(customer.name), phone: capturedText(customer.phone),
      do_not_contact: customer.do_not_contact === false ? false as const : captureInvalid(),
      deleted_at: customer.deleted_at === null ? null : captureInvalid() } : null,
    rule: rule ? { id: capturedUuid(rule.id), unit_id: capturedUuid(rule.unit_id),
      trigger_type: rule.trigger_type === 'birthday' || rule.trigger_type === 'frequency' ? rule.trigger_type : captureInvalid() } : null,
    setting: { key, present: setting !== null, value: setting ? capturedJson(setting.value) : null } };
  const identity = { id: capturedUuid(row.id), unit_id: capturedUuid(row.unit_id) };
  if (intent.kind === 'confirmation' || intent.kind === 'reminder_d1' || intent.kind === 'survey_d1' || intent.kind === 'cancellation') {
    const source = capturedText(row.source), payment = capturedNullableText(row.payment_status), rawTime = capturedText(row.time);
    if (!['web','whatsapp'].includes(source) || (payment !== null && !['not_required','pending_payment','paid','failed','refunded','expired'].includes(payment))
      || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(rawTime)) return captureInvalid();
    return { ...common, kind: intent.kind, resource: { ...identity, customer_id: capturedUuid(row.customer_id), date: date(row.date) ?? captureInvalid(),
      time: rawTime, source, status: capturedText(row.status), payment_status: payment, party_size: capturedInteger(row.party_size, 1, 999999),
      reservation_code: capturedCode(row.reservation_code), applied_discount_percent: capturedNullableInteger(row.applied_discount_percent, 0, 100),
      satisfaction_rating: capturedNullableInteger(row.satisfaction_rating, 1, 5) } };
  }
  if (intent.kind === 'waitlist_entered' || intent.kind === 'waitlist_feedback' || intent.kind === 'waitlist_table_ready') return { ...common, kind: intent.kind, resource: { ...identity,
    customer_id: row.customer_id === null ? null : capturedUuid(row.customer_id), customer_name: capturedNullableText(row.customer_name),
    customer_phone: capturedText(row.customer_phone), party_size: capturedInteger(row.party_size, 1, 999999), code: capturedInteger(row.code, 1),
    status: capturedText(row.status), created_at: capturedInstant(row.created_at), seated_at: row.seated_at === null ? null : capturedInstant(row.seated_at) } };
  return { ...common, kind: intent.kind, resource: { ...identity, customer_id: capturedUuid(row.customer_id), rule_id: capturedUuid(row.rule_id),
    code: capturedCode(row.code), discount_percent: capturedInteger(row.discount_percent, 1, 100), status: capturedText(row.status),
    issued_at: capturedInstant(row.issued_at), created_at: capturedInstant(row.created_at), expires_at: capturedInstant(row.expires_at) } };
}
function localParts(value: number, timezone: string): { day: string; time: string } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value);
  const part = (key: string) => p.find(x => x.type === key)?.value ?? '';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}:${part('second')}` };
}
const refuse = (reason: AutomationPreflightReason): ScheduledResourceResult => ({ ok: false, reason });

/** Real resource/tenant/eligibility decisions; injected functions only read I/O. */
export function createAutomationResourceService(io: AutomationResourceIO) {
  async function loadScheduledResource(intent: ScheduledIntent): Promise<ScheduledResourceResult> {
    try {
      const table = intent.reservationId ? 'reservations' : intent.waitlistId ? 'waitlist' : 'vouchers';
      const id = intent.reservationId ?? intent.waitlistId ?? intent.voucherId;
      if (typeof id !== 'string') return refuse('recipient_changed');
      const row = record(await io.readOne(table, columns[table], { id }));
      if (!row || row.id !== id || typeof row.unit_id !== 'string' || row.unit_id !== intent.unitId) return refuse('recipient_changed');
      const unit = record(await io.readOne('units', 'id,organization_id,name,slug,timezone', { id: row.unit_id }));
      if (!unit || unit.id !== row.unit_id || typeof unit.organization_id !== 'string') return refuse('recipient_changed');
      const organization = record(await io.readOne('organizations', 'id', { id: unit.organization_id }));
      if (!organization || organization.id !== unit.organization_id) return refuse('recipient_changed');
      const timezone = unit.timezone == null ? 'America/Sao_Paulo' : text(unit.timezone);
      let nowLocal: { day: string; time: string };
      try {
        if (!timezone) return refuse('invalid_timezone');
        nowLocal = localParts(io.now(), timezone);
      } catch { return refuse('invalid_timezone'); }
      let customer: Record<string, unknown> | null = null;
      const waitlistPhone = table === 'waitlist' && typeof row.customer_phone === 'string' ? canonicalBrPhone(row.customer_phone) : null;
      if (row.customer_id !== null) {
        if (typeof row.customer_id !== 'string') return refuse('customer_not_alive');
        customer = record(await io.readOne('customers', columns.customers, { id: row.customer_id }));
        if (!customer || customer.id !== row.customer_id) return refuse('customer_not_alive');
      } else if (table === 'waitlist' && waitlistPhone) {
        customer = record(await io.readOne('customers', columns.customers, { organization_id: unit.organization_id, phone: waitlistPhone }));
      } else return refuse('customer_not_alive');
      if (customer && (customer.organization_id !== unit.organization_id || customer.deleted_at !== null || typeof customer.id !== 'string')) return refuse('customer_not_alive');
      if (customer && customer.do_not_contact !== false) return refuse('do_not_contact');
      const phone = table === 'waitlist' ? waitlistPhone : typeof customer?.phone === 'string' ? canonicalBrPhone(customer.phone) : null;
      if (!phone || !/^[1-9]\d{9,10}$/.test(phone)) return refuse('recipient_changed');
      if (table === 'waitlist' && customer && (typeof customer.phone !== 'string' || canonicalBrPhone(customer.phone) !== phone)) return refuse('recipient_changed');
      if (!customer && intent.kind !== 'waitlist_entered' && intent.kind !== 'waitlist_table_ready') return refuse('customer_not_alive');
      const expiresAt = automationDeadline(intent.kind, intent.factAt);
      if (io.now() > Date.parse(expiresAt)) return refuse('expired');
      let templateId: TemplateId;
      let resourceDate: string | null = null, time: string | null = null, benefitExpiry: string | null = null;
      let code: string | number, people: number | null = null, discount: number | null = null;
      let rule: Record<string, unknown> | null = null;
      if (table === 'reservations') {
        // Cancellation is the only kind whose eligible state is cancelled; payment is irrelevant there.
        if (intent.kind === 'cancellation') {
          if (row.status !== 'cancelled') return refuse('reservation_not_cancelled');
          if (typeof row.cancelled_at !== 'string' || !instant(row.cancelled_at)
            || Date.parse(row.cancelled_at) !== Date.parse(intent.factAt)) return refuse('reservation_changed');
        }
        else if (row.status === 'pending') return refuse('reservation_pending');
        else if (row.status !== 'confirmed') return refuse('reservation_not_confirmed');
        if (intent.kind === 'confirmation' && row.payment_status !== null && row.payment_status !== 'not_required' && row.payment_status !== 'paid') return refuse('payment_incompatible');
        resourceDate = date(row.date);
        time = typeof row.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(row.time) ? row.time.slice(0, 5) : null;
        if (!resourceDate || !time) return refuse('render_invalid');
        if (intent.kind !== 'survey_d1') {
          const currentStart = brtFactAt(resourceDate, time);
          if (!currentStart || io.now() > Date.parse(currentStart) || `${nowLocal.day}T${nowLocal.time}` > `${resourceDate}T${time}:00`) return refuse('reservation_past');
          if (intent.kind === 'reminder_d1' && resourceDate !== nowLocal.day) return refuse('reservation_wrong_day');
        } else {
          if (row.satisfaction_rating !== null) return refuse('survey_already_answered');
          if (resourceDate !== localParts(Date.parse(intent.factAt), 'America/Sao_Paulo').day) return refuse('reservation_changed');
        }
        discount = number(row.applied_discount_percent);
        templateId = intent.kind === 'confirmation' ? discount !== null && discount > 0 ? 'res_confirmacao_desconto_v1' : 'res_confirmacao_v1'
          : intent.kind === 'reminder_d1' ? 'res_lembrete_dia_v1' : intent.kind === 'cancellation' ? 'res_cancelada_v1' : 'res_pesquisa_reserva_v1';
        code = text(row.reservation_code) ?? ''; people = number(row.party_size);
      } else if (table === 'waitlist') {
        if (intent.kind === 'waitlist_entered' && row.status !== 'waiting') return refuse('waitlist_not_waiting');
        if (intent.kind === 'waitlist_table_ready' && (row.status !== 'notified' || row.seated_at !== null
          || row.notified_at !== intent.factAt || row.notified_server_at !== intent.factAt)) return refuse('waitlist_not_waiting');
        if (intent.kind === 'waitlist_feedback') {
          const seated = instant(row.seated_at);
          if (row.status !== 'seated' || !seated) return refuse('waitlist_not_seated');
          if (localParts(Date.parse(seated), 'America/Sao_Paulo').day !== localParts(Date.parse(intent.factAt), 'America/Sao_Paulo').day) return refuse('waitlist_wrong_day');
          resourceDate = localParts(Date.parse(seated), timezone).day;
        }
        templateId = intent.kind === 'waitlist_entered' ? 'fila_entrada_v1' : intent.kind === 'waitlist_table_ready' ? 'fila_mesa_pronta_v1' : 'fila_feedback_v1';
        code = number(row.code) ?? text(row.code) ?? ''; people = number(row.party_size);
      } else {
        if (row.status !== 'active') return refuse('voucher_not_active');
        benefitExpiry = instant(row.expires_at);
        if (!benefitExpiry || io.now() >= Date.parse(benefitExpiry)) return refuse('voucher_expired');
        if (typeof row.rule_id !== 'string') return refuse('voucher_changed');
        rule = record(await io.readOne('voucher_rules', 'id,unit_id,trigger_type', { id: row.rule_id, unit_id: row.unit_id }));
        if (!rule || rule.id !== row.rule_id || rule.unit_id !== unit.id || (rule.trigger_type !== 'birthday' && rule.trigger_type !== 'frequency')) return refuse('voucher_changed');
        templateId = 'mkt_voucher_programado_v1';
        discount = number(row.discount_percent); code = text(row.code) ?? '';
        resourceDate = localParts(Date.parse(benefitExpiry), timezone).day;
      }
      // Operator-explicit actions (confirmation, cancellation, table ready) have no per-unit enablement setting.
      const key = intent.kind === 'confirmation' || intent.kind === 'cancellation' || intent.kind === 'waitlist_table_ready' ? null : intent.kind === 'voucher_issued' ? 'giftback_whatsapp_enabled' : `${intent.kind}_enabled`;
      const setting = key ? record(await io.readOne('settings', 'value', { unit_id: row.unit_id, key })) : null;
      if (setting?.value === false || setting?.value === 'false') return refuse('dispatch_paused');
      let expected: ScheduledResourceExpected;
      try { expected = captureExpected(intent, row, unit, customer, rule, key, setting); }
      catch { return refuse('render_invalid'); }
      return { ok: true, resource: { intent, unitId: row.unit_id, organizationId: unit.organization_id,
        customerId: customer ? text(customer.id) : null, phone, e164: toE164BrPhone(phone),
        customerName: text(table === 'waitlist' ? row.customer_name : customer?.name) ?? '', unitName: text(unit.name) ?? '',
        unitSlug: text(unit.slug), timezone, templateId, date: resourceDate, time, code, people, discount, benefitExpiry,
        createdAt: instant(row.created_at), issuedAt: instant(row.issued_at), source: text(row.source), expiresAt,
        snapshot: JSON.stringify({ row, customer, unit, rule, setting }), expected } };
    } catch { return refuse('dependency_unavailable'); }
  }
  return { loadScheduledResource };
}

/** Links and positional values come solely from the loaded resource. Token is ephemeral. */
export function renderScheduledTemplate(resource: ScheduledResource, appBaseUrl: string, allowedOrigins: readonly string[], preferenceToken?: string) {
  const base = new URL(appBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !allowedOrigins.includes(base.origin)) throw new Error('render_invalid');
  const tracking = `${base.origin}/acompanhar/${resource.intent.reservationId ?? resource.intent.waitlistId}`;
  const preference = `${base.origin}/preferencias/mensagens/${preferenceToken ?? ''}`;
  const day = resource.date ? resource.date.split('-').reverse().join('/') : '';
  const r = resource;
  const version = r.templateId.endsWith('_v2') ? 2 : 1;
  const definition = catalogDefinition(r.templateId, version);
  if (!definition) throw new Error('render_invalid');
  const parameterId = version === 1 ? r.templateId : `${r.templateId.slice(0, -3)}_v1`;
  let parameters: unknown[];
  switch (parameterId) {
    case 'res_confirmacao_v1': parameters = [r.customerName,r.unitName,day,r.time,r.people,r.code,tracking]; break;
    case 'res_confirmacao_desconto_v1': parameters = [r.customerName,r.unitName,day,r.time,r.people,r.code,r.discount,tracking]; break;
    case 'res_lembrete_dia_v1': parameters = [r.customerName,r.unitName,r.time,r.people,r.code,tracking]; break;
    case 'res_pesquisa_reserva_v1': parameters = [r.customerName,r.code,r.unitName,day]; break;
    case 'fila_entrada_v1': parameters = [r.customerName,r.unitName,r.code,r.people,tracking]; break;
    case 'fila_feedback_v1':
      if (!r.unitSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.unitSlug)) throw new Error('render_invalid');
      parameters = [r.customerName,r.unitName,day,`${base.origin}/r/${r.unitSlug}`,preference]; break;
    case 'mkt_voucher_programado_v1': parameters = [r.customerName,r.unitName,r.discount,r.code,day,preference]; break;
    case 'fila_mesa_pronta_v1': parameters = [r.customerName,r.unitName,r.code]; break;
    case 'res_cancelada_v1': parameters = [r.customerName,r.unitName,day,r.time,r.people,r.code]; break;
    default: throw new Error('render_invalid');
  }
  const rendered = definition.version === 2 ? renderTemplateV2(definition.id as TemplateV2Id, parameters, { allowedOrigins })
    : renderTemplate(definition.id, parameters, { allowedOrigins });
  const body = rendered.body + (rendered.footer ? `\n${rendered.footer}` : '');
  if (body.length > 4096) throw new Error('render_invalid');
  return { ...rendered, body, safeLogBody: body.replace(/\/preferencias\/mensagens\/[A-Za-z0-9_-]{43}/g, '/preferencias/mensagens/[redacted]') };
}

import type { AlertType } from './ops-alert-core.ts';

export const OPS_ALERT_EMAIL_TEMPLATE_VERSION = 'ops-email-v1';
export const OPS_ALERT_EMAIL_MAX_BODY_BYTES = 2048;
export const OPS_ALERT_EMAIL_MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const OPS_ALERT_EMAIL_MAX_INTEGER = 2_147_483_647; // PostgreSQL integer arguments.

export type OpsAlertEmailPayload = {
  event: AlertType;
  unit_id: string;
  channel_id: string | null;
  generated_at: string;
  count?: number;
  oldest_age_seconds?: number;
};

export type PersistedOpsAlertEmail = OpsAlertEmailPayload | {
  event: 'synthetic_test';
  unit_id: null;
  channel_id: null;
  generated_at: string;
};

export type OpsAlertEmailRequestResult =
  | { ok: true; payload: OpsAlertEmailPayload }
  | { ok: false; status: 400 | 413 | 415; code: 'invalid_payload' | 'payload_too_large' | 'unsupported_media_type' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const encoder = new TextEncoder();

// Fixed template vocabulary. The digest hashes sample rendered outputs; any
// renderer change, including a branch outside those samples, must bump the
// template version so previous approvals cannot silently survive.
const TEMPLATE = {
  subjectPrefix: '[Moralles Reservas] Alerta WhatsApp: ',
  titles: {
    inbound_dead_letter: 'evento de entrada sem processamento',
    inbound_backlog_stalled: 'fila de entrada acumulada',
    datafy_subscription_failed: 'falha na assinatura Datafy',
    synthetic_test: 'teste do receptor operacional',
  },
  unitLabel: 'Unidade',
  channelLabel: 'Canal',
  countLabel: 'Eventos sem processamento',
  ageLabel: 'Idade da fila (segundos)',
  utcLabel: 'Horário UTC',
  brtLabel: 'Horário BRT',
  absentLabel: 'não informado',
  htmlOpen: '<!doctype html><html lang="pt-BR"><body><h1>',
  htmlMiddle: '</h1><dl>',
  htmlClose: '</dl></body></html>',
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function canonicalTime(value: unknown, nowMs: number, enforceFutureSkew: boolean): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;
  const [, yy, mm, dd, hh, min, sec, fractional = '', zone, sign, offsetHour, offsetMinute] = match;
  const year = Number(yy), month = Number(mm), day = Number(dd);
  const hour = Number(hh), minute = Number(min), second = Number(sec);
  const millis = Number((fractional + '000').slice(0, 3));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, second, millis);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  let offsetMs = 0;
  if (zone !== 'Z') {
    const oh = Number(offsetHour), om = Number(offsetMinute);
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return null;
    offsetMs = (oh * 60 + om) * 60_000 * (sign === '+' ? 1 : -1);
  }
  const timestamp = check.getTime() - offsetMs;
  if (!Number.isFinite(timestamp) || (enforceFutureSkew && timestamp > nowMs + OPS_ALERT_EMAIL_MAX_FUTURE_SKEW_MS)) return null;
  const normalized = new Date(timestamp);
  if (normalized.getUTCFullYear() < 1 || normalized.getUTCFullYear() > 9999) return null;
  return normalized.toISOString();
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= OPS_ALERT_EMAIL_MAX_INTEGER;
}

function normalizePayload(value: unknown, nowMs: number, allowSynthetic: boolean, enforceFutureSkew: boolean): PersistedOpsAlertEmail | null {
  if (!record(value) || typeof value.event !== 'string') return null;
  const generatedAt = canonicalTime(value.generated_at, nowMs, enforceFutureSkew);
  if (!generatedAt) return null;
  if (allowSynthetic && value.event === 'synthetic_test') {
    if (!exactKeys(value, ['event', 'unit_id', 'channel_id', 'generated_at']) || value.unit_id !== null || value.channel_id !== null) return null;
    return { event: 'synthetic_test', unit_id: null, channel_id: null, generated_at: generatedAt };
  }
  if (value.event !== 'inbound_dead_letter' && value.event !== 'inbound_backlog_stalled' && value.event !== 'datafy_subscription_failed') return null;
  const unitId = canonicalUuid(value.unit_id);
  const channelId = value.channel_id === null ? null : canonicalUuid(value.channel_id);
  if (!unitId || (value.channel_id !== null && !channelId)) return null;
  const base = { unit_id: unitId, channel_id: channelId, generated_at: generatedAt };
  if (value.event === 'inbound_dead_letter') {
    if (!exactKeys(value, ['event', 'unit_id', 'channel_id', 'generated_at', 'count']) || !nonnegativeInteger(value.count)) return null;
    return { ...base, event: 'inbound_dead_letter', count: value.count };
  }
  if (value.event === 'inbound_backlog_stalled') {
    if (!exactKeys(value, ['event', 'unit_id', 'channel_id', 'generated_at', 'oldest_age_seconds']) || !nonnegativeInteger(value.oldest_age_seconds)) return null;
    return { ...base, event: 'inbound_backlog_stalled', oldest_age_seconds: value.oldest_age_seconds };
  }
  if (!exactKeys(value, ['event', 'unit_id', 'channel_id', 'generated_at'])) return null;
  return { ...base, event: 'datafy_subscription_failed' };
}

export function parseOpsAlertEmailRequestBody(body: string, contentType: string | null, nowMs = Date.now()): OpsAlertEmailRequestResult {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType ?? '')) {
    return { ok: false, status: 415, code: 'unsupported_media_type' };
  }
  if (encoder.encode(body).byteLength > OPS_ALERT_EMAIL_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: 'payload_too_large' };
  }
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return { ok: false, status: 400, code: 'invalid_payload' }; }
  const payload = normalizePayload(raw, nowMs, false, true);
  return payload && payload.event !== 'synthetic_test'
    ? { ok: true, payload }
    : { ok: false, status: 400, code: 'invalid_payload' };
}

export function createSyntheticOpsAlertEmail(nowMs = Date.now()): PersistedOpsAlertEmail {
  return { event: 'synthetic_test', unit_id: null, channel_id: null, generated_at: new Date(nowMs).toISOString() };
}

export function canonicalOpsAlertEmailPayload(value: unknown): string {
  const payload = normalizePayload(value, Date.now(), true, false);
  if (!payload) throw new Error('invalid_payload');
  if (payload.event === 'synthetic_test') {
    return JSON.stringify([payload.event, payload.unit_id, payload.channel_id, payload.generated_at]);
  }
  return JSON.stringify([payload.event, payload.unit_id, payload.channel_id,
    payload.event === 'inbound_dead_letter' ? payload.count : null,
    payload.event === 'inbound_backlog_stalled' ? payload.oldest_age_seconds : null,
    payload.generated_at]);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function opsAlertEmailPayloadDigest(value: unknown): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalOpsAlertEmailPayload(value))));
}

export async function opsAlertEmailTemplateDigest(): Promise<string> {
  const fixtureTime = '2026-01-02T03:04:05.000Z';
  const unit = '11111111-1111-4111-8111-111111111111';
  const channel = '22222222-2222-4222-8222-222222222222';
  const fixtures: PersistedOpsAlertEmail[] = [
    { event: 'inbound_dead_letter', unit_id: unit, channel_id: channel, generated_at: fixtureTime, count: 17 },
    { event: 'inbound_backlog_stalled', unit_id: unit, channel_id: null, generated_at: fixtureTime, oldest_age_seconds: 3611 },
    { event: 'datafy_subscription_failed', unit_id: unit, channel_id: channel, generated_at: fixtureTime },
    { event: 'synthetic_test', unit_id: null, channel_id: null, generated_at: fixtureTime },
  ];
  const material = JSON.stringify([OPS_ALERT_EMAIL_TEMPLATE_VERSION, TEMPLATE, fixtures.map(renderOpsAlertEmail)]);
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(material)));
}

export function isOpsAlertEmailTokenConfigured(token: string | null | undefined): token is string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(token) || token.length % 4 === 1) return false;
  try {
    const decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4));
    if (decoded.length < 32) return false;
    const canonical = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return canonical === token;
  } catch { return false; }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return mismatch === 0;
}

export async function opsAlertEmailTokenMatches(provided: string | null | undefined, configured: string | null | undefined): Promise<boolean> {
  if (!isOpsAlertEmailTokenConfigured(configured)) return false;
  const [givenDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided ?? '')),
    crypto.subtle.digest('SHA-256', encoder.encode(configured)),
  ]);
  return constantTimeEqual(new Uint8Array(givenDigest), new Uint8Array(configuredDigest));
}

export async function opsAlertEmailConfigHmac(token: string, from: string, to: string): Promise<string> {
  if (!isOpsAlertEmailTokenConfigured(token) || !from || !to) throw new Error('config_missing');
  const templateDigest = await opsAlertEmailTemplateDigest();
  const material = JSON.stringify([from, to, OPS_ALERT_EMAIL_TEMPLATE_VERSION, templateDigest]);
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(material)));
}

export async function isOpsAlertEmailConfigApproved(token: string | null | undefined, from: string | null | undefined, to: string | null | undefined, approvedHmac: string | null | undefined): Promise<boolean> {
  if (!isOpsAlertEmailTokenConfigured(token) || !from || !to || !approvedHmac || !HEX_256_PATTERN.test(approvedHmac)) return false;
  const actual = await opsAlertEmailConfigHmac(token, from, to);
  return constantTimeEqual(encoder.encode(actual), encoder.encode(approvedHmac));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function displayTimes(iso: string): { utc: string; brt: string } {
  const timestamp = Date.parse(iso);
  const utc = new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
  const brt = new Date(timestamp - 3 * 60 * 60_000).toISOString().replace('T', ' ').replace('Z', ' BRT');
  return { utc, brt };
}

export function renderOpsAlertEmail(value: unknown): { subject: string; text: string; html: string } {
  const payload = normalizePayload(value, Date.now(), true, false);
  if (!payload) throw new Error('invalid_payload');
  const title = TEMPLATE.titles[payload.event];
  const times = displayTimes(payload.generated_at);
  const fields: [string, string][] = [
    [TEMPLATE.unitLabel, payload.unit_id ?? TEMPLATE.absentLabel],
    [TEMPLATE.channelLabel, payload.channel_id ?? TEMPLATE.absentLabel],
  ];
  if (payload.event === 'inbound_dead_letter') fields.push([TEMPLATE.countLabel, String(payload.count)]);
  if (payload.event === 'inbound_backlog_stalled') fields.push([TEMPLATE.ageLabel, String(payload.oldest_age_seconds)]);
  fields.push([TEMPLATE.utcLabel, times.utc], [TEMPLATE.brtLabel, times.brt]);
  return {
    subject: TEMPLATE.subjectPrefix + title,
    text: [title, ...fields.map(([label, item]) => `${label}: ${item}`)].join('\n'),
    html: TEMPLATE.htmlOpen + escapeHtml(title) + TEMPLATE.htmlMiddle
      + fields.map(([label, item]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(item)}</dd>`).join('')
      + TEMPLATE.htmlClose,
  };
}

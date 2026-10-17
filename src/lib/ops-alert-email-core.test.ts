import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  OPS_ALERT_EMAIL_MAX_BODY_BYTES,
  OPS_ALERT_EMAIL_TEMPLATE_VERSION,
  canonicalOpsAlertEmailPayload,
  createSyntheticOpsAlertEmail,
  isOpsAlertEmailConfigApproved,
  isOpsAlertEmailTokenConfigured,
  opsAlertEmailConfigHmac,
  opsAlertEmailPayloadDigest,
  opsAlertEmailTemplateDigest,
  opsAlertEmailTokenMatches,
  parseOpsAlertEmailRequestBody,
  renderOpsAlertEmail,
} from '../../supabase/functions/_shared/ops-alert-email-core';

vi.stubGlobal('crypto', webcrypto);

const NOW = Date.parse('2026-10-17T18:00:00.000Z');
const UNIT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const TOKEN = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const BASE = { event: 'datafy_subscription_failed', unit_id: UNIT, channel_id: CHANNEL, generated_at: '2026-10-17T17:55:00.000Z' };

function parse(value: unknown, contentType = 'application/json', nowMs = NOW) {
  return parseOpsAlertEmailRequestBody(JSON.stringify(value), contentType, nowMs);
}

describe('ops-alert-email contract', () => {
  it('accepts only the three closed production events and normalizes IDs and ISO time', () => {
    const offset = { ...BASE, unit_id: UNIT.toUpperCase(), generated_at: '2026-10-17T14:55:00-03:00' };
    expect(parse(offset)).toEqual({ ok: true, payload: BASE });
    expect(parse({ ...BASE, event: 'inbound_dead_letter', count: 0 })).toMatchObject({ ok: true });
    expect(parse({ ...BASE, event: 'inbound_dead_letter', count: 2_147_483_647 })).toMatchObject({ ok: true });
    expect(parse({ ...BASE, event: 'inbound_backlog_stalled', oldest_age_seconds: 1 })).toMatchObject({ ok: true });
    expect(parse({ ...BASE, channel_id: null })).toMatchObject({ ok: true });
  });

  it('rejects synthetic input, free fields, phone, credentials and malformed event fields', () => {
    const bad: unknown[] = [
      { ...BASE, event: 'synthetic_test', unit_id: null, channel_id: null },
      { ...BASE, to: 'someone@example.test' },
      { ...BASE, subject: 'test' },
      { ...BASE, text: 'private conversation' },
      { ...BASE, phone: '5511999999999' },
      { ...BASE, token: 'fixture-secret' },
      { ...BASE, count: 1 },
      { ...BASE, channel_id: 'not-a-uuid' },
      { ...BASE, unit_id: '<script>' },
      { ...BASE, event: 'inbound_dead_letter' },
      { ...BASE, event: 'inbound_dead_letter', count: -1 },
      { ...BASE, event: 'inbound_dead_letter', count: 1.5 },
      { ...BASE, event: 'inbound_dead_letter', count: 2_147_483_648 },
      { ...BASE, event: 'inbound_dead_letter', count: Number.MAX_SAFE_INTEGER + 1 },
      { ...BASE, event: 'inbound_backlog_stalled', oldest_age_seconds: null },
      { ...BASE, event: 'inbound_backlog_stalled', oldest_age_seconds: 1, count: 1 },
      null, [], 'string',
    ];
    for (const value of bad) expect(parse(value)).toEqual({ ok: false, status: 400, code: 'invalid_payload' });
  });

  it('enforces media type, UTF-8 byte limit and malformed JSON responses', () => {
    expect(parse(BASE, 'text/plain')).toEqual({ ok: false, status: 415, code: 'unsupported_media_type' });
    expect(parse(BASE, 'application/json; charset=utf-8')).toMatchObject({ ok: true });
    expect(parseOpsAlertEmailRequestBody('', 'application/json', NOW)).toEqual({ ok: false, status: 400, code: 'invalid_payload' });
    const body = JSON.stringify(BASE);
    const exact = body + ' '.repeat(OPS_ALERT_EMAIL_MAX_BODY_BYTES - Buffer.byteLength(body));
    expect(Buffer.byteLength(exact)).toBe(2048);
    expect(parseOpsAlertEmailRequestBody(exact, 'application/json', NOW)).toMatchObject({ ok: true });
    expect(parseOpsAlertEmailRequestBody(exact + ' ', 'application/json', NOW)).toEqual({ ok: false, status: 413, code: 'payload_too_large' });
    expect(parseOpsAlertEmailRequestBody('é'.repeat(1025), 'application/json', NOW)).toMatchObject({ status: 413 });
  });

  it('rejects invalid calendar dates and timestamps beyond five minutes in the future', () => {
    for (const date of ['2026-02-30T12:00:00Z', '2026-10-17T12:00:60Z', '2026-10-17T12:00:00+14:01',
      '2026-10-17T12:00:00', '2026-10-17T18:05:00.001Z', '0001-01-01T00:00:00+14:00']) {
      expect(parse({ ...BASE, generated_at: date })).toMatchObject({ ok: false, status: 400 });
    }
    expect(parse({ ...BASE, generated_at: '2026-10-17T18:05:00.000Z' })).toMatchObject({ ok: true });
  });

  it('makes digest independent of JSON key order and equivalent ISO offsets', async () => {
    const same = { generated_at: '2026-10-17T14:55:00-03:00', channel_id: CHANNEL.toUpperCase(), unit_id: UNIT, event: BASE.event };
    expect(canonicalOpsAlertEmailPayload(same)).toBe(canonicalOpsAlertEmailPayload(BASE));
    expect(await opsAlertEmailPayloadDigest(same)).toBe(await opsAlertEmailPayloadDigest(BASE));
    expect(await opsAlertEmailPayloadDigest({ ...BASE, generated_at: '2026-10-17T17:55:01Z' })).not.toBe(await opsAlertEmailPayloadDigest(BASE));
    expect(() => canonicalOpsAlertEmailPayload({ ...BASE, phone: 'hidden' })).toThrow('invalid_payload');
  });

  it('renders only persisted fixed fields in UTC and BRT', () => {
    const email = renderOpsAlertEmail({ ...BASE, event: 'inbound_dead_letter', count: 2 });
    expect(email.subject).toContain('evento de entrada sem processamento');
    expect(email.text).toContain(`Unidade: ${UNIT}`);
    expect(email.text).toContain('2026-10-17 17:55:00.000 UTC');
    expect(email.text).toContain('2026-10-17 14:55:00.000 BRT');
    expect(email.html).toContain(`<dd>${CHANNEL}</dd>`);
    expect(email.html).not.toMatch(/<script>|someone@example\.test|private conversation|5511999999999|fixture-secret/);
    expect(() => renderOpsAlertEmail({ ...BASE, unit_id: '<script>alert(1)</script>' })).toThrow('invalid_payload');
    expect(renderOpsAlertEmail(createSyntheticOpsAlertEmail(NOW)).text).toContain('teste do receptor operacional');
  });

  it('uses a canonical 32-byte base64url token and compares it without exposing details', async () => {
    expect(TOKEN).toHaveLength(43);
    expect(isOpsAlertEmailTokenConfigured(TOKEN)).toBe(true);
    expect(isOpsAlertEmailTokenConfigured('a'.repeat(32))).toBe(false);
    expect(isOpsAlertEmailTokenConfigured('A'.repeat(43) + '\n')).toBe(false);
    expect(isOpsAlertEmailTokenConfigured(TOKEN + '=')).toBe(false);
    expect(await opsAlertEmailTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(await opsAlertEmailTokenMatches('wrong', TOKEN)).toBe(false);
    expect(await opsAlertEmailTokenMatches(null, TOKEN)).toBe(false);
    expect(await opsAlertEmailTokenMatches(TOKEN, null)).toBe(false);
  });

  it('binds from, to, version and rendered template to the approval HMAC', async () => {
    expect(OPS_ALERT_EMAIL_TEMPLATE_VERSION).toBe('ops-email-v1');
    const digest = await opsAlertEmailTemplateDigest();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const approved = await opsAlertEmailConfigHmac(TOKEN, 'alerts@example.test', 'operator@example.test');
    expect(approved).toMatch(/^[0-9a-f]{64}$/);
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'alerts@example.test', 'operator@example.test', approved)).toBe(true);
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'other@example.test', 'operator@example.test', approved)).toBe(false);
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'alerts@example.test', 'other@example.test', approved)).toBe(false);
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'alerts@example.test', 'operator@example.test', '0'.repeat(64))).toBe(false);
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'alerts@example.test', 'operator@example.test', '')).toBe(false);
    const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const olderTemplate = JSON.stringify(['alerts@example.test', 'operator@example.test', OPS_ALERT_EMAIL_TEMPLATE_VERSION, '0'.repeat(64)]);
    const otherTemplateHmac = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(olderTemplate))).toString('hex');
    expect(await isOpsAlertEmailConfigApproved(TOKEN, 'alerts@example.test', 'operator@example.test', otherTemplateHmac)).toBe(false);
  });
});

import {
  OPS_ALERT_EMAIL_MAX_BODY_BYTES,
  OPS_ALERT_EMAIL_TEMPLATE_VERSION,
  createSyntheticOpsAlertEmail,
  isOpsAlertEmailConfigApproved,
  isOpsAlertEmailTokenConfigured,
  opsAlertEmailConfigHmac,
  opsAlertEmailPayloadDigest,
  opsAlertEmailTokenMatches,
  parseOpsAlertEmailRequestBody,
  renderOpsAlertEmail,
  type PersistedOpsAlertEmail,
} from '../_shared/ops-alert-email-core.ts';

const RECEIVER_PATHS = [
  '/functions/v1/whatsapp-ops-alert-email',
  '/whatsapp-ops-alert-email',
];
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 7_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_PATTERN = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}\.[^\s@<>]{2,63}$/;

type SqlResult<T> = { data: T | null; error: unknown };
type ReserveResult = {
  decision: 'reserved' | 'replay' | 'blocked';
  attempt_id?: string;
  reason?: 'window' | 'capacity';
};

export type OpsEmailConfig = {
  token: string | null;
  to: string | null;
  from: string | null;
  resendKey: string | null;
  approvedHmac: string | null;
};

export type OpsEmailDatabase = {
  reserve(args: {
    p_unit_id: string | null;
    p_alert_type: string;
    p_channel_id: string | null;
    p_count: number | null;
    p_oldest_age_seconds: number | null;
    p_generated_at: string;
    p_payload_digest: string;
    p_template_version: string;
    p_config_hmac: string;
  }): Promise<SqlResult<ReserveResult>>;
  complete(attemptId: string, status: 'accepted' | 'uncertain', providerId: string | null): Promise<SqlResult<boolean>>;
  checkReservationReady(): Promise<SqlResult<{ ready: boolean; remaining: number }>>;
};

export type OpsEmailDependencies = {
  db: OpsEmailDatabase;
  config: OpsEmailConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: { request_id: string; stage: string; code: string }) => void;
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function validAddress(value: string | null, allowDisplayName: boolean): boolean {
  if (!value || value.length > 320 || /[\r\n\x00-\x1f\x7f]/.test(value)) return false;
  if (ADDRESS_PATTERN.test(value)) return true;
  if (!allowDisplayName) return false;
  const match = /^([^<>]{1,100}) <([^<>]+)>$/.exec(value);
  return !!match && ADDRESS_PATTERN.test(match[2]) && match[1].trim().length > 0;
}

function hasBaseConfig(config: OpsEmailConfig): config is OpsEmailConfig & { token: string; to: string; from: string; resendKey: string } {
  return isOpsAlertEmailTokenConfigured(config.token)
    && validAddress(config.to, false)
    && validAddress(config.from, true)
    && typeof config.resendKey === 'string'
    && config.resendKey.length > 0
    && !/[\s\x00-\x1f\x7f]/.test(config.resendKey);
}

async function withinTwoSeconds<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error('sql_timeout')), 2_000); }),
    ]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

async function readBoundedBody(request: Request): Promise<{ body?: string; tooLarge: boolean }> {
  if (!request.body) return { body: '', tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OPS_ALERT_EMAIL_MAX_BODY_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(result), tooLarge: false };
  } catch {
    return { tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

type ResendResult = { ok: true; id: string } | { ok: false; code: string };

async function sendResend(
  attemptId: string,
  payload: PersistedOpsAlertEmail,
  config: OpsEmailConfig & { to: string; from: string; resendKey: string },
  fetchImpl: typeof fetch,
): Promise<ResendResult> {
  const email = renderOpsAlertEmail(payload);
  const body = JSON.stringify({ from: config.from, to: [config.to], subject: email.subject, text: email.text, html: email.html });
  try {
    const response = await fetchImpl(RESEND_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': attemptId,
      },
      body,
    });
    if (!response.ok) return { ok: false, code: `resend_http_${response.status}` };
    let responseBody: unknown;
    try { responseBody = await response.json(); } catch { return { ok: false, code: 'resend_invalid_response' }; }
    const id = (responseBody as { id?: unknown } | null)?.id;
    return typeof id === 'string' && ID_PATTERN.test(id)
      ? { ok: true, id }
      : { ok: false, code: 'resend_missing_id' };
  } catch {
    return { ok: false, code: 'resend_transport_error' };
  }
}

/** Pure request boundary. Only index.ts supplies the production database and fetch. */
export function createOpsAlertEmailHandler({ db, config, fetchImpl = fetch, now = Date.now, log = () => {} }: OpsEmailDependencies) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const fail = (stage: string, code: string, status: number) => {
      log({ request_id: requestId, stage, code });
      return json({ code }, status);
    };
    const path = new URL(request.url).pathname;
    const isBase = RECEIVER_PATHS.includes(path);
    const isTest = RECEIVER_PATHS.some((base) => path === `${base}/test`);
    if (!isBase && !isTest) return fail('route', 'not_found', 404);
    if (request.method !== 'GET' && request.method !== 'POST') return fail('method', 'method_not_allowed', 405);
    if (isTest && request.method !== 'POST') return fail('method', 'method_not_allowed', 405);

    if (!isOpsAlertEmailTokenConfigured(config.token)) return fail('configuration', 'unavailable', 503);
    if (!await opsAlertEmailTokenMatches(request.headers.get('x-ops-alert-key'), config.token)) {
      return fail('auth', 'unauthorized', 401);
    }
    // Authentication precedes any body read or JSON parsing.
    if (!hasBaseConfig(config)) return request.method === 'GET'
      ? json({ ready: false, code: 'configuration' }, 503)
      : fail('configuration', 'unavailable', 503);

    let fingerprint: string;
    try { fingerprint = await opsAlertEmailConfigHmac(config.token, config.from, config.to); }
    catch { return fail('configuration', 'unavailable', 503); }
    const approved = await isOpsAlertEmailConfigApproved(config.token, config.from, config.to, config.approvedHmac);
    if (request.method === 'GET' || !isTest) {
      if (!approved) return request.method === 'GET'
        ? json({ ready: false, code: 'approval' }, 503)
        : fail('configuration', 'unavailable', 503);
    }

    if (request.method === 'GET') {
      try {
        const result = await withinTwoSeconds(db.checkReservationReady());
        if (result.error || !result.data || !Number.isInteger(result.data.remaining)
          || result.data.remaining < 0 || result.data.remaining > 50) return json({ ready: false, code: 'database' }, 503);
        if (result.data.remaining === 0) return json({ ready: false, code: 'capacity' }, 503);
        if (result.data.ready !== true) return json({ ready: false, code: 'database' }, 503);
        return json({ ready: true }, 200);
      } catch { return json({ ready: false, code: 'database' }, 503); }
    }

    const { body, tooLarge } = await readBoundedBody(request);
    if (tooLarge) return fail('request', 'payload_too_large', 413);
    if (body === undefined) return fail('request', 'invalid_payload', 400);
    let payload: PersistedOpsAlertEmail;
    if (isTest) {
      if (body.length > 0) return fail('request', 'invalid_payload', 400);
      payload = createSyntheticOpsAlertEmail(now());
    } else {
      const parsed = parseOpsAlertEmailRequestBody(body, request.headers.get('content-type'), now());
      if (parsed.ok === false) return fail('request', parsed.code, parsed.status);
      payload = parsed.payload;
    }

    const digest = await opsAlertEmailPayloadDigest(payload);
    let reservation: ReserveResult;
    try {
      const result = await withinTwoSeconds(db.reserve({
        p_unit_id: payload.unit_id,
        p_alert_type: payload.event,
        p_channel_id: payload.channel_id,
        p_count: payload.event === 'inbound_dead_letter' ? payload.count ?? null : null,
        p_oldest_age_seconds: payload.event === 'inbound_backlog_stalled' ? payload.oldest_age_seconds ?? null : null,
        p_generated_at: payload.generated_at,
        p_payload_digest: digest,
        p_template_version: OPS_ALERT_EMAIL_TEMPLATE_VERSION,
        p_config_hmac: fingerprint,
      }));
      if (result.error || !result.data) return fail('reserve', 'unavailable', 503);
      reservation = result.data;
    } catch { return fail('reserve', 'unavailable', 503); }
    if (reservation.decision === 'blocked') {
      if (reservation.reason !== 'capacity' && reservation.reason !== 'window') return fail('reserve', 'unavailable', 503);
      return fail('limit', 'rate_limited', reservation.reason === 'capacity' ? 503 : 429);
    }
    if (reservation.decision === 'replay') {
      if (typeof reservation.attempt_id !== 'string' || !UUID_PATTERN.test(reservation.attempt_id)) return fail('reserve', 'unavailable', 503);
      return json(isTest ? { accepted: true, replay: true, fingerprint } : { accepted: true, replay: true }, 200);
    }
    if (reservation.decision !== 'reserved' || typeof reservation.attempt_id !== 'string' || !UUID_PATTERN.test(reservation.attempt_id)) {
      return fail('reserve', 'unavailable', 503);
    }

    const attemptId = reservation.attempt_id;
    const result = await sendResend(attemptId, payload, config, fetchImpl);
    if (result.ok === false) {
      // Any result without a confirmed provider id needs human reconciliation.
      // The SQL completion RPC deliberately cannot mark it rejected or release budget.
      try {
        const marked = await withinTwoSeconds(db.complete(attemptId, 'uncertain', null));
        if (marked.error || marked.data !== true) log({ request_id: requestId, stage: 'complete', code: 'unavailable' });
      } catch {
        // Reservation itself still prevents automatic retry, but an operator must
        // know the terminal SQL update did not get confirmation.
        log({ request_id: requestId, stage: 'complete', code: 'unavailable' });
      }
      log({ request_id: requestId, stage: 'provider', code: result.code });
      return json({ code: 'delivery_failed' }, 503);
    }
    try {
      const completed = await withinTwoSeconds(db.complete(attemptId, 'accepted', result.id));
      if (completed.error || completed.data !== true) return fail('complete', 'unavailable', 503);
    } catch { return fail('complete', 'unavailable', 503); }
    return json(isTest ? { accepted: true, fingerprint } : { accepted: true }, 200);
  };
}

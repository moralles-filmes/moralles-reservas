import type { OpsAlertPayload } from './ops-alert-core.ts';
import { isOpsAlertEmailTokenConfigured } from './ops-alert-email-core.ts';

const RECEIVER_PATH = '/functions/v1/whatsapp-ops-alert-email';
const SEND_TIMEOUT_MS = 20_000;
const READINESS_TIMEOUT_MS = 5_000;
const MAX_ACK_BYTES = 512;

export type SecureOpsAlertConfig = {
  endpoint: string | undefined;
  projectUrl: string | undefined;
  token: string | undefined;
};

export type SecureAlertDelivery = { delivered: boolean; reason?: 'unconfigured' | 'delivery_failed' };

/** Read only a tiny JSON acknowledgement; gateway pages and oversized bodies fail closed. */
async function readSmallJson(response: Response): Promise<Record<string, unknown> | null> {
  if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' || !response.body) return null;
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_ACK_BYTES)) return null;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_ACK_BYTES);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_ACK_BYTES) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** A token may only be sent to this project's exact receiver URL. */
export function secureOpsAlertEndpoint(config: SecureOpsAlertConfig): string | null {
  const { endpoint, projectUrl, token } = config;
  // Shape alone cannot prove entropy; secret creation must generate 32 random bytes.
  if (!isOpsAlertEmailTokenConfigured(token) || !projectUrl || !endpoint) return null;
  try {
    const project = new URL(projectUrl);
    if (project.protocol !== 'https:' || project.username || project.password || project.search || project.hash
      || (project.pathname !== '/' && project.pathname !== '')
      || (projectUrl !== project.origin && projectUrl !== `${project.origin}/`)) return null;
    const expected = `${project.origin}${RECEIVER_PATH}`;
    if (endpoint !== expected) return null;
    const target = new URL(endpoint);
    if (target.protocol !== 'https:' || target.origin !== project.origin || target.pathname !== RECEIVER_PATH
      || target.search || target.hash || target.username || target.password) return null;
    return expected;
  } catch { return null; }
}

/** Only the receiver's explicit acknowledgement advances the producer ledger. */
export function createSecureOpsAlertSender(config: SecureOpsAlertConfig, fetchImpl: typeof fetch = fetch) {
  return async (payload: OpsAlertPayload): Promise<SecureAlertDelivery> => {
    const endpoint = secureOpsAlertEndpoint(config);
    if (!endpoint) return { delivered: false, reason: 'unconfigured' };
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', 'x-ops-alert-key': config.token! },
        body: JSON.stringify(payload),
      });
      if (response.status !== 200) return { delivered: false, reason: 'delivery_failed' };
      const ack = await readSmallJson(response);
      return ack?.accepted === true ? { delivered: true } : { delivered: false, reason: 'delivery_failed' };
    } catch { return { delivered: false, reason: 'delivery_failed' }; }
  };
}

/** Health never infers readiness from sender configuration or an unauthenticated 200. */
export async function readSecureOpsAlertReadiness(config: SecureOpsAlertConfig, fetchImpl: typeof fetch = fetch): Promise<{
  senderConfigured: boolean; receiverReady: boolean;
}> {
  const endpoint = secureOpsAlertEndpoint(config);
  if (!endpoint) return { senderConfigured: false, receiverReady: false };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
      headers: { 'x-ops-alert-key': config.token! },
    });
    if (response.status !== 200) return { senderConfigured: true, receiverReady: false };
    const data = await readSmallJson(response);
    return { senderConfigured: true, receiverReady: data?.ready === true };
  } catch { return { senderConfigured: true, receiverReady: false }; }
}

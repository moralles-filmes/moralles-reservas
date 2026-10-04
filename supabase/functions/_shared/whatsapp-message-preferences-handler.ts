import { hashPreferenceTechnicalKey, hashPreferenceToken, isPreferenceToken, type PromotionDecision } from './whatsapp-message-preferences-core.ts';

export type PreferenceView = {valid: true; unitLabel: string; choice: PromotionDecision};
export type PreferencesDependencies = {
  allowedOrigins: readonly string[];
  lookup(hash: string): Promise<PreferenceView | null>;
  optOut(hash: string): Promise<boolean>;
  rateGate(bucketHash: string): Promise<boolean>;
};
const MAX_BODY_BYTES = 2048;
async function boundedJson(request: Request): Promise<unknown> {
  const size = request.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BODY_BYTES)) throw new Error('body_large');
  if (!request.body) throw new Error('body_invalid');
  const reader = request.body.getReader(); let bytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', {fatal: true});
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('body_large'); }
      text += decoder.decode(part.value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
/** This factory is the production handler too: no runtime, network or logging imports. */
export function createPreferencesHandler(deps: PreferencesDependencies): (request: Request) => Promise<Response> {
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = origin !== null && deps.allowedOrigins.includes(origin);
    const headers = new Headers({'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'vary': 'Origin'});
    if (allowed) { headers.set('access-control-allow-origin', origin); headers.set('access-control-allow-methods', 'GET, POST, OPTIONS'); headers.set('access-control-allow-headers', 'content-type, x-preference-token'); }
    const reply = (status: number, body: unknown = {valid: false}) => new Response(status === 204 ? null : JSON.stringify(body), {status, headers});
    if (request.method === 'OPTIONS') return reply(allowed ? 204 : 403);
    if (!['GET','POST'].includes(request.method)) return reply(405);
    if (origin !== null && !allowed || request.method === 'POST' && !allowed) return reply(403);
    try {
      // Forwarded context is pacing only. Never store arbitrary header text or capability.
      const address = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
      const technical = address && address.length <= 64 && /^[0-9a-fA-F:.]+$/.test(address) ? address : 'unknown';
      if (!await deps.rateGate(await hashPreferenceTechnicalKey('preferences:v1:' + technical))) return reply(429);
      let token: unknown;
      if (request.method === 'GET') {
        if (new URL(request.url).search) return reply(400);
        token = request.headers.get('x-preference-token');
      } else {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415);
        let body: unknown;
        try { body = await boundedJson(request); } catch (error) { return reply(error instanceof Error && error.message === 'body_large' ? 413 : 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'action,token' || (body as {action: unknown}).action !== 'opt_out') return reply(400);
        token = (body as {token: unknown}).token;
      }
      if (!isPreferenceToken(token)) return reply(400);
      const hash = await hashPreferenceToken(token);
      if (request.method === 'POST') return await deps.optOut(hash) ? reply(200, {valid:true,choice:'opt_out'}) : reply(200);
      const view = await deps.lookup(hash);
      return reply(200, view ? {valid:true,unitLabel:view.unitLabel,choice:view.choice} : {valid:false});
    } catch { return reply(503); }
  };
}

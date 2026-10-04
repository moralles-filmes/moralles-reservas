export type PromotionDecision = 'unknown' | 'opt_in' | 'opt_out';
export function canSendPromotion(input: {decision: string | null; doNotContact: boolean; deletedAt: string | null}): boolean {
  return input.decision === 'opt_in' && input.doNotContact === false && input.deletedAt === null;
}
/** 32 bytes have four unused low bits in their final base64url character. */
export function isPreferenceToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token);
}
export async function hashPreferenceToken(token: string): Promise<string> {
  if (!isPreferenceToken(token)) throw new Error('preference_token_invalid');
  return hashPreferenceTechnicalKey(token);
}
export async function hashPreferenceTechnicalKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function createPreferenceToken(): Promise<{token: string; hash: string}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {token, hash: await hashPreferenceToken(token)};
}

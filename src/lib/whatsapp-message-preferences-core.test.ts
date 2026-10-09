import { describe, expect, it } from 'vitest';
import { canSendPromotion, createPreferenceToken, hashPreferenceToken, isPreferenceToken } from '../../supabase/functions/_shared/whatsapp-message-preferences-core.ts';

describe('promotion capability', () => {
  it('requires individual current opt-in and a living contact without DNC', () => {
    for (const decision of ['unknown', 'opt_out', null]) expect(canSendPromotion({decision, doNotContact:false, deletedAt:null})).toBe(false);
    expect(canSendPromotion({decision:'opt_in', doNotContact:false, deletedAt:null})).toBe(true);
    expect(canSendPromotion({decision:'opt_in', doNotContact:true, deletedAt:null})).toBe(false);
    expect(canSendPromotion({decision:'opt_in', doNotContact:false, deletedAt:'2026-10-03'})).toBe(false);
  });
  it('uses 256 random bits and stores only the deterministic SHA256 hash', async () => {
    const a = await createPreferenceToken(), b = await createPreferenceToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.hash).toBe(await hashPreferenceToken(a.token));
    expect(a.hash).not.toBe(a.token);
  });
  it('rejects noncanonical encodings, padding and extra data', () => {
    expect(isPreferenceToken('A'.repeat(43))).toBe(true);
    for (const token of ['A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42)+'B', 'A'.repeat(42)+'=', 'A'.repeat(42)+'+', null]) expect(isPreferenceToken(token)).toBe(false);
  });
});

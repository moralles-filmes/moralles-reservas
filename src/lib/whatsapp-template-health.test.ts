import { describe, expect, it, vi } from 'vitest';
import { refreshVerifiedDatafyTemplateHealth } from '../../supabase/functions/_shared/whatsapp-template-health.ts';

describe('Datafy template health identity', () => {
  it('does not record connected health for another number, then recovers only on an exact match', async () => {
    const recordConnected = vi.fn(async () => undefined);
    const requestMe = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { phone_number_id: '222222', waba_id: 'different' } })
      .mockResolvedValueOnce({ status: 200, body: { phone_number_id: '111111' } });
    const deps = { expectedPhoneNumberId: '111111', requestMe, recordConnected };
    await expect(refreshVerifiedDatafyTemplateHealth(deps)).rejects.toThrow('template_identity_mismatch');
    expect(recordConnected).not.toHaveBeenCalled();
    await refreshVerifiedDatafyTemplateHealth(deps);
    expect(recordConnected).toHaveBeenCalledOnce();
  });

  it('refuses an absent pin, malformed or failed discovery without recording connected health', async () => {
    const recordConnected = vi.fn(async () => undefined);
    const requestMe = vi.fn(async () => ({ status: 200, body: { phone_number_id: '111111' } }));
    await expect(refreshVerifiedDatafyTemplateHealth({ expectedPhoneNumberId: undefined, requestMe, recordConnected }))
      .rejects.toThrow('template_identity_unavailable');
    expect(requestMe).not.toHaveBeenCalled();
    await expect(refreshVerifiedDatafyTemplateHealth({ expectedPhoneNumberId: '111111',
      requestMe: async () => ({ status: 200, body: {} }), recordConnected }))
      .rejects.toThrow('template_identity_mismatch');
    await expect(refreshVerifiedDatafyTemplateHealth({ expectedPhoneNumberId: '111111',
      requestMe: async () => ({ status: 403, body: { phone_number_id: '111111' } }), recordConnected }))
      .rejects.toThrow('template_health_unavailable');
    expect(recordConnected).not.toHaveBeenCalled();
  });
});

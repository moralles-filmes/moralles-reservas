import { describe, expect, it, vi } from 'vitest';
import { createTemplateAccountService } from '../../supabase/functions/_shared/whatsapp-template-account.ts';

function fixture(body: unknown = { phone_number_id: '123', waba_id: '456' }) {
  const bind = vi.fn(async () => ({ accountId: 'account', generation: 1 }));
  const request = vi.fn(async () => ({ status: 200, body }));
  const loadChannel = vi.fn(async () => ({ id: 'channel', unit_id: 'unit', provider: 'datafy',
    template_credential_revision: 4, credentials: { access_token: 'fake', phone_number_id: '123', business_account_id: '999' } }));
  const service = createTemplateAccountService({ loadChannel, bind,
    getProvider: provider => ({ capabilities: { templateManagement: provider === 'datafy' }, cloudApiRequest: request }) });
  return { ...service, bind, request, loadChannel };
}
describe('verified template account', () => {
  it('uses authenticated discovery and pins revision; inactive channel preparation is allowed', async () => {
    const f = fixture();
    await expect(f.ensureTemplateAccount('channel')).resolves.toEqual({ accountId: 'account', generation: 1 });
    expect(f.request).toHaveBeenCalledWith(expect.anything(), { method: 'GET', path: 'me' });
    expect(f.bind).toHaveBeenCalledWith({ channelId: 'channel', unitId: 'unit', provider: 'datafy',
      credentialRevision: 4, phoneNumberId: '123', wabaId: '456' });
  });
  it.each([{}, { phone_number_id: '999', waba_id: '456' }, { phone_number_id: '123' },
    { phone_number_id: '123', waba_id: '../456' }])('refuses unverified identity', async body => {
    const f = fixture(body);
    await expect(f.ensureTemplateAccount('channel')).rejects.toThrow('template_account_unavailable');
    expect(f.bind).not.toHaveBeenCalled();
  });
  it('does not turn sendText support into direct Meta template capability', async () => {
    const f = fixture();
    f.loadChannel.mockResolvedValueOnce({ ...(await f.loadChannel()), provider: 'official' });
    await expect(f.ensureTemplateAccount('channel')).rejects.toThrow('template_account_unsupported');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('propagates transactional refusal instead of returning a discovered but unbound account', async () => {
    const f = fixture();
    f.bind.mockRejectedValueOnce(new Error('template_binding_changed'));
    await expect(f.ensureTemplateAccount('channel')).rejects.toThrow('template_binding_changed');
  });
});

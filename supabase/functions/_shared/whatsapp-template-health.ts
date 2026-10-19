import { parseDatafyAccount } from './datafy-client.ts';

/** A /me response proves health only for the number pinned to this channel. */
export async function refreshVerifiedDatafyTemplateHealth(deps: {
  expectedPhoneNumberId: unknown;
  requestMe(): Promise<{ status: number; body: unknown }>;
  recordConnected(): Promise<void>;
}): Promise<void> {
  const expected = deps.expectedPhoneNumberId;
  if (typeof expected !== 'string' || !/^\d{1,64}$/.test(expected))
    throw new Error('template_identity_unavailable');
  const response = await deps.requestMe();
  if (response.status < 200 || response.status >= 300) throw new Error('template_health_unavailable');
  const account = parseDatafyAccount(response.body);
  if (!account || account.phoneNumberId !== expected) throw new Error('template_identity_mismatch');
  await deps.recordConnected();
}

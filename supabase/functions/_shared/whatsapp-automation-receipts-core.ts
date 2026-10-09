import type { StatusUpdate } from './whatsapp-provider-core.ts';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const providers = ['official', 'datafy', 'zapi', 'waha', 'uazapi'];
export interface ReceiptChannelSnapshot { id: string; unit_id: string; provider: string; template_credential_revision: number; external_instance_id: string | null }
export interface SanitizedReceipt { provider_message_id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; provider_timestamp: null }
export function receiptSnapshot(value: unknown): ReceiptChannelSnapshot {
  if (!record(value) || !uuid(value.id) || !uuid(value.unit_id) || typeof value.provider !== 'string' || !providers.includes(value.provider)
    || typeof value.template_credential_revision !== 'number' || !Number.isSafeInteger(value.template_credential_revision) || value.template_credential_revision < 0
    || (value.external_instance_id !== null && typeof value.external_instance_id !== 'string')) throw new Error('receipt_authority_invalid');
  return { id: value.id, unit_id: value.unit_id, provider: value.provider, template_credential_revision: value.template_credential_revision, external_instance_id: typeof value.external_instance_id === 'string' ? value.external_instance_id : null };
}
/** Registry mapping remains authoritative; this validates its recognized batch, before dedupe. */
export function validateReceiptBatch(provider: string, payload: unknown, updates: StatusUpdate[]): SanitizedReceipt[] {
  const event = record(payload) && record(payload.event) ? payload.event : null;
  if (updates.length > 500 || (provider === 'uazapi' && event && Array.isArray(event.MessageIDs) && event.MessageIDs.length > 500)) throw new Error('receipt_batch_too_large');
  return updates.map(update => {
    if (typeof update.providerMessageId !== 'string' || update.providerMessageId.length < 1 || update.providerMessageId.length > 512
      || /[\x00-\x1f\x7f-\x9f]/.test(update.providerMessageId) || !['sent', 'delivered', 'read', 'failed'].includes(update.status)) throw new Error('receipt_batch_invalid');
    return { provider_message_id: update.providerMessageId, status: update.status, provider_timestamp: null };
  });
}

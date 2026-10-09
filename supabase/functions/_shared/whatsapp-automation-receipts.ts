import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { StatusUpdate } from './whatsapp-provider-core.ts';
import { receiptSnapshot, validateReceiptBatch } from './whatsapp-automation-receipts-core.ts';

type Admission = { kind: 'legacy' | 'recorded' } | { kind: 'refused'; status: 400 | 401 | 413 | 503; reason: string };
/** Called only for parsed statuses on the original authenticated provider request. */
export async function admitAutomationReceipts(db: SupabaseClient, channel: unknown, payload: unknown, updates: StatusUpdate[], channelSecret: unknown): Promise<Admission> {
  try {
    // No cohort read for chat/echo/connection or unrecognized callback families.
    if (!updates.length) return { kind: 'legacy' };
    if (!channel || typeof channel !== 'object' || !('unit_id' in channel) || typeof channel.unit_id !== 'string') throw new Error('receipt_authority_invalid');
    const { data, error } = await db.from('whatsapp_automation_adoptions').select('unit_id').eq('unit_id', channel.unit_id).maybeSingle();
    if (error) throw new Error('receipt_dependency_unavailable');
    if (!data) return { kind: 'legacy' };
    const snapshot = receiptSnapshot(channel);
    if (snapshot.provider === 'zapi' && (typeof channelSecret !== 'string' || !channelSecret.trim())) return { kind: 'refused', status: 503, reason: 'receipt_authority_unversioned' };
    const events = validateReceiptBatch(snapshot.provider, payload, updates);
    const result = await db.rpc('record_whatsapp_automation_receipts', {
      p_channel_id: snapshot.id, p_unit_id: snapshot.unit_id, p_provider: snapshot.provider,
      p_credential_revision: snapshot.template_credential_revision, p_external_instance_id: snapshot.external_instance_id, p_events: events,
    });
    if (result.error) throw new Error('receipt_dependency_unavailable');
    const value: unknown = result.data;
    if (!value || typeof value !== 'object' || !('state' in value)) throw new Error('receipt_dependency_unavailable');
    if (value.state === 'authority_changed') return { kind: 'refused', status: 401, reason: 'receipt_authority_changed' };
    if (value.state === 'not_adopted') return { kind: 'legacy' };
    if (value.state !== 'recorded') throw new Error('receipt_dependency_unavailable');
    return { kind: 'recorded' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'receipt_batch_invalid') return { kind: 'refused', status: 400, reason };
    if (reason === 'receipt_batch_too_large') return { kind: 'refused', status: 413, reason };
    return { kind: 'refused', status: 503, reason: 'receipt_dependency_unavailable' };
  }
}

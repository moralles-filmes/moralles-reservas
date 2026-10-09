import { describe, expect, it } from 'vitest';
import { validateReceiptBatch, receiptSnapshot } from '../../supabase/functions/_shared/whatsapp-automation-receipts-core';
describe('receipt admission boundary', () => {
  it('retains nullable native time and validates before dedupe', () => {
    expect(validateReceiptBatch('zapi', {}, [{ providerMessageId: 'm1', status: 'read' }])).toEqual([
      { provider_message_id: 'm1', status: 'read', provider_timestamp: null }]);
    expect(() => validateReceiptBatch('zapi', {}, Array(501).fill({ providerMessageId: 'm1', status: 'read' }))).toThrow('receipt_batch_too_large');
  });
  it('checks actual UazAPI MessageIDs before the existing parser slice', () => {
    expect(() => validateReceiptBatch('uazapi', { event: { Type: 'Read', MessageIDs: Array(501).fill('m1') } }, [{ providerMessageId: 'm1', status: 'read' }])).toThrow('receipt_batch_too_large');
  });
  it.each(['', 'x'.repeat(513), 'x\u0000', 'x\u0085'])('rejects recognized malformed native id', id => {
    expect(() => validateReceiptBatch('zapi', {}, [{ providerMessageId: id, status: 'read' }])).toThrow('receipt_batch_invalid');
  });
  it('snapshot refuses absent revision and untyped nullable external anchor', () => {
    const channel = { id: '10000000-0000-0000-0000-000000000001', unit_id: '10000000-0000-0000-0000-000000000002', provider: 'zapi', template_credential_revision: 0, external_instance_id: null };
    expect(receiptSnapshot(channel).external_instance_id).toBeNull();
    expect(() => receiptSnapshot({ ...channel, template_credential_revision: undefined })).toThrow('receipt_authority_invalid');
    expect(() => receiptSnapshot({ ...channel, external_instance_id: {} })).toThrow('receipt_authority_invalid');
  });
});

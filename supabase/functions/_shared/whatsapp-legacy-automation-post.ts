/** Private server-side intent. Never deserialize this structure from HTTP. */
export type LegacyAutomationIntent = {
  kind: 'confirmation' | 'reminder_d1' | 'survey_d1' | 'cancellation'
    | 'waitlist_entered' | 'waitlist_feedback' | 'waitlist_table_ready' | 'voucher_issued';
  resourceId: string;
  origin: 'send-confirmation' | 'send-whatsapp' | 'send-cancellation';
};
export const LEGACY_AUTOMATION_REFUSED = 'legacy_automation_refused';
export const LEGACY_AUTOMATION_UNCERTAIN = 'legacy_automation_uncertain';
export function isLegacyAutomationSuppressed(result: { error?: unknown }): boolean {
  return result.error === LEGACY_AUTOMATION_REFUSED || result.error === LEGACY_AUTOMATION_UNCERTAIN;
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const reasons = ['intent_invalid','resource_refused','channel_changed','adoption_active','intent_owned',
  'history_accepted','history_uncertain','dependency_unavailable'] as const;
type RefusalReason = typeof reasons[number];
type Refusal = { allowed: false; reason: RefusalReason };
export type LegacyAutomationClaim = { allowed: true; intentId: string; fence: string };
export interface LegacyAutomationPostIO {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
const unavailable = (): Refusal => ({ allowed: false, reason: 'dependency_unavailable' });
function refusal(value: Row | null): Refusal | null {
  return value?.allowed === false && Object.keys(value).sort().join(',') === 'allowed,reason'
    && reasons.includes(value.reason as RefusalReason) ? value as Refusal : null;
}
export function createLegacyAutomationPostGuard(io: LegacyAutomationPostIO) {
  async function call(name: string, args: Record<string, unknown>): Promise<Row | null> {
    try {
      const result = await io.rpc(name, args);
      return result.error ? null : record(result.data);
    } catch { return null; }
  }
  return {
    async claim(intent: LegacyAutomationIntent, channelId: string, credentialRevision: number): Promise<LegacyAutomationClaim | Refusal> {
      if (!uuid(intent.resourceId) || !uuid(channelId) || !Number.isSafeInteger(credentialRevision) || credentialRevision < 0)
        return { allowed: false, reason: 'intent_invalid' };
      const value = await call('claim_whatsapp_legacy_automation_post', { p_kind: intent.kind, p_resource_id: intent.resourceId,
        p_channel_id: channelId, p_expected_credential_revision: credentialRevision, p_origin: intent.origin });
      return value?.allowed === true && Object.keys(value).sort().join(',') === 'allowed,fence,intent_id'
        && uuid(value.intent_id) && uuid(value.fence) ? { allowed: true, intentId: value.intent_id, fence: value.fence } : refusal(value) ?? unavailable();
    },
    async confirm(claim: LegacyAutomationClaim, channelId: string, credentialRevision: number): Promise<{ allowed: true } | Refusal> {
      const value = await call('confirm_whatsapp_legacy_automation_post', { p_intent_id: claim.intentId, p_fence: claim.fence,
        p_channel_id: channelId, p_expected_credential_revision: credentialRevision });
      if (value?.allowed === true && Object.keys(value).join(',') === 'allowed') return { allowed: true };
      const denied = refusal(value);
      // Only an explicit, closed refusal proves that this confirmation did not
      // authorize a POST. A lost/invalid reply may have committed posting.
      if (denied) await call('release_whatsapp_legacy_automation_claim', { p_intent_id: claim.intentId,
        p_fence: claim.fence, p_reason: 'confirmation_refused' });
      return denied ?? unavailable();
    },
    async finish(claim: LegacyAutomationClaim, outcome: 'accepted' | 'uncertain', providerMessageId?: string): Promise<'accepted' | 'uncertain'> {
      const messageId = typeof providerMessageId === 'string' && providerMessageId.length > 0 && providerMessageId.length <= 512
        && !/[\x00-\x1f\x7f-\x9f]/.test(providerMessageId) ? providerMessageId : null;
      const expected = outcome === 'accepted' && messageId !== null ? 'accepted' : 'uncertain';
      const value = await call('finish_whatsapp_legacy_automation_post', { p_intent_id: claim.intentId, p_fence: claim.fence,
        p_outcome: expected, p_provider_message_id: expected === 'accepted' ? messageId : null });
      return expected === 'accepted' && value?.recorded === true && value.state === 'accepted'
        && Object.keys(value).sort().join(',') === 'recorded,state' ? 'accepted' : 'uncertain';
    },
  };
}

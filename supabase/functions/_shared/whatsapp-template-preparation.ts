/** Durable connection preparation. SQL is the authority for enrollment, policy and grant. */
export interface TemplatePreparationClaim { onboarding_id: string; channel_id: string; unit_id: string; organization_id?: string; credential_revision: number }
export interface TemplatePreparationSnapshot {
  onboarding_id?: string;
  onboarding_state?: string | null;
  reason_code?: TemplatePreparationReason | null;
  next_attempt_at?: string | null;
  enrollment: 'eligible' | 'disabled' | 'legacy' | 'excluded';
  state: 'pending' | 'discovering' | 'ready' | 'needs_review' | null;
}
export interface TemplatePreparationChannel {
  id: string; unit_id: string; provider: string; status: string; is_active: boolean | null;
  template_credential_revision: number; last_health_check_at: string | null;
}
export interface TemplatePreparationBinding {
  id: string; account_id: string; generation: number; channel_credential_revision: number;
  verified_at: string | null;
}
export type TemplatePreparationReason = 'connection_pending' | 'health_stale' | 'binding_pending'
  | 'provider_unavailable' | 'policy_changed' | 'manual_review';
export interface TemplatePreparationDependencies {
  read(unitId: string, channelId: string): Promise<TemplatePreparationSnapshot>;
  loadChannel(channelId: string): Promise<TemplatePreparationChannel | null>;
  refreshHealth(channel: TemplatePreparationChannel): Promise<void>;
  ensureAccount(channelId: string): Promise<void>;
  loadBinding(channelId: string): Promise<TemplatePreparationBinding | null>;
  authorize(claim: TemplatePreparationClaim, binding: TemplatePreparationBinding): Promise<boolean>;
  requestSync(accountId: string): Promise<void>;
  mark(claim: TemplatePreparationClaim, state: 'pending' | 'discovering' | 'ready' | 'needs_review', reason: TemplatePreparationReason | null): Promise<boolean>;
  now(): number;
}

export function createTemplatePreparationService(deps: TemplatePreparationDependencies) {
  const healthy = (channel: TemplatePreparationChannel, maxAgeMs: number) => {
    const checkedAt = channel.last_health_check_at ? Date.parse(channel.last_health_check_at) : NaN;
    return channel.status === 'connected' && Number.isFinite(checkedAt)
      && checkedAt <= deps.now() && deps.now() - checkedAt <= maxAgeMs;
  };
  async function prepare(claim: TemplatePreparationClaim, alreadyClaimed = false): Promise<{ state: 'ready' | 'pending' | 'needs_review' | 'skipped'; reason?: TemplatePreparationReason }> {
    const snapshot = await deps.read(claim.unit_id, claim.channel_id);
    if (snapshot.enrollment !== 'eligible' || snapshot.onboarding_id !== claim.onboarding_id) return { state: 'skipped' };
    if (snapshot.state === 'needs_review') return { state: 'needs_review', reason: 'manual_review' };
    if (snapshot.state === 'ready') {
      // A ready, inactive pre-cutover channel is invisible to the general health worker.
      // This heartbeat only renews GET health; it never rebinds, regrants or requests sync.
      const channel = await deps.loadChannel(claim.channel_id);
      if (!channel || channel.id !== claim.channel_id || channel.unit_id !== claim.unit_id || channel.provider !== 'datafy'
        || channel.template_credential_revision !== claim.credential_revision) return { state: 'needs_review', reason: 'policy_changed' };
      if (channel.is_active !== true && !healthy(channel, 3 * 60_000)) {
        try { await deps.refreshHealth(channel); }
        catch {
          return await deps.mark(claim, 'ready', 'provider_unavailable')
            ? { state: 'pending', reason: 'provider_unavailable' } : { state: 'skipped' };
        }
        const updated = await deps.loadChannel(claim.channel_id);
        if (!updated || updated.id !== claim.channel_id || updated.unit_id !== claim.unit_id || updated.provider !== 'datafy'
          || updated.template_credential_revision !== claim.credential_revision)
          return { state: 'needs_review', reason: 'policy_changed' };
        if (!healthy(updated, 5 * 60_000)) {
          return await deps.mark(claim, 'ready', 'health_stale')
            ? { state: 'pending', reason: 'health_stale' } : { state: 'skipped' };
        }
        if (!await deps.mark(claim, 'ready', null)) return { state: 'skipped' };
      } else if (snapshot.reason_code && healthy(channel, 5 * 60_000)) {
        if (!await deps.mark(claim, 'ready', null)) return { state: 'skipped' };
      }
      return { state: 'ready' };
    }
    if (snapshot.onboarding_state !== 'completed') {
      return await deps.mark(claim, 'pending', 'connection_pending')
        ? { state: 'pending', reason: 'connection_pending' } : { state: 'skipped' };
    }
    if (!alreadyClaimed && snapshot.next_attempt_at && Date.parse(snapshot.next_attempt_at) > deps.now()
      && snapshot.reason_code !== 'connection_pending') return { state: 'skipped' };
    if (!await deps.mark(claim, 'discovering', null)) return { state: 'skipped' };
    const pending = async (reason: TemplatePreparationReason) => {
      return await deps.mark(claim, 'pending', reason)
        ? { state: 'pending' as const, reason } : { state: 'skipped' as const };
    };
    const review = async (reason: TemplatePreparationReason) => {
      return await deps.mark(claim, 'needs_review', reason)
        ? { state: 'needs_review' as const, reason } : { state: 'skipped' as const };
    };
    try {
      let channel = await deps.loadChannel(claim.channel_id);
      if (!channel || channel.id !== claim.channel_id || channel.unit_id !== claim.unit_id || channel.provider !== 'datafy'
        || channel.template_credential_revision !== claim.credential_revision) return review('policy_changed');
      if (!healthy(channel, 4 * 60_000)) {
        await deps.refreshHealth(channel);
        channel = await deps.loadChannel(claim.channel_id);
        if (!channel || channel.id !== claim.channel_id || channel.unit_id !== claim.unit_id || channel.provider !== 'datafy'
          || channel.template_credential_revision !== claim.credential_revision) return review('policy_changed');
      }
      if (channel.status !== 'connected') return pending('connection_pending');
      if (!healthy(channel, 5 * 60_000)) return pending('health_stale');
      await deps.ensureAccount(claim.channel_id);
      const binding = await deps.loadBinding(claim.channel_id);
      if (!binding || !binding.verified_at || binding.channel_credential_revision !== claim.credential_revision) return pending('binding_pending');
      if (!await deps.authorize(claim, binding)) return review('policy_changed');
      await deps.requestSync(binding.account_id);
      if (!await deps.mark(claim, 'ready', null)) return { state: 'skipped' };
      return { state: 'ready' };
    } catch {
      return pending('provider_unavailable');
    }
  }
  return { prepare };
}

import { describe, expect, it } from 'vitest';
import { dispatchV2Variants } from './template-dispatch-versions';
import { SERVICE_KINDS, servicePreferencesSchema } from './service-preferences';

const unitId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000001';

function ineligibleSnapshot() {
  return {
    auto_cohort: true, eligible: false, rollout_ready: false, global_dispatch_enabled: false,
    admin_paused: false, can_manage: true,
    unit_id: unitId, channel_id: channelId, binding_id: null,
    binding_generation: null, credential_revision: 0,
    provider_subscription_confirmed: true,
    kinds: SERVICE_KINDS.map(kind => ({ kind, enabled: false, revision: 0,
      enabled_at: null, ready: false, reason_code: 'binding_changed', variants: [] })),
  };
}

describe('snapshot de avisos de serviço', () => {
  it('accepts a connected Datafy channel without a binding while keeping the cohort ineligible', () => {
    expect(servicePreferencesSchema.safeParse(ineligibleSnapshot()).success).toBe(true);
  });

  it('rejects an incomplete ready variant or contradictory enabled state', () => {
    const current = ineligibleSnapshot();
    const invalid = { ...current, eligible: true, rollout_ready: true,
      binding_id: '30000000-0000-4000-8000-000000000001', binding_generation: 1,
      kinds: current.kinds.map(item => ({ ...item, ready: true, reason_code: 'ready',
        variants: dispatchV2Variants[item.kind].map(logical_id => ({ logical_id, status: 'APPROVED', ready: true })) })) };
    invalid.kinds[0].enabled = true;
    expect(servicePreferencesSchema.safeParse(invalid).success).toBe(false);
  });
});

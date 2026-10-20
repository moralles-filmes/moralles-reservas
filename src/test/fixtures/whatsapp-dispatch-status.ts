import { SCHEDULED_KINDS } from '../../../supabase/functions/_shared/whatsapp-automation-core';
import { dispatchV2Variants, type StoreDispatchEntry } from '@/features/whatsapp/template-dispatch-versions';

/** Closed business projection. It grants no release/cost/consent authority. */
export function syntheticDispatchStatus(version: 1 | 2 | null = 1, readiness: StoreDispatchEntry['readiness'] = 'pending_meta') {
  return { channel_id: version === null ? null : '30000000-0000-4000-8000-000000000001', generation: version === null ? null : 1,
    credential_revision: version === null ? null : 0, entries: SCHEDULED_KINDS.map(kind => ({ kind, template_version: version,
    logical_id: version === null ? null : dispatchV2Variants[kind][0].replace(/_v2$/, `_v${version}`),
    readiness: version === null ? 'awaiting_channel' as const : readiness,
    reason_code: version === null ? 'channel_unavailable' as const : readiness === 'ready' ? 'ready' as const
      : readiness === 'awaiting_dispatch' ? 'dispatch_paused' as const : readiness === 'rejected' ? 'meta_rejected' as const : 'meta_pending' as const,
  })) };
}

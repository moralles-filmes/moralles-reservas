export const DELIVERY_STATES = ['queued', 'claimed', 'posting', 'accepted', 'blocked', 'expired', 'uncertain', 'retry_wait', 'needs_review', 'failed', 'reconciled', 'paused', 'rejected'] as const;
export const DELIVERY_KINDS = ['confirmation', 'reminder_d1', 'survey_d1', 'waitlist_entered', 'waitlist_feedback', 'voucher_issued', 'cancellation', 'waitlist_table_ready'] as const;
export const DELIVERY_REASONS = [
  'channel_unconfigured', 'binding_unconfigured', 'template_unconfigured', 'reservation_pending', 'payment_incompatible', 'reservation_not_confirmed', 'reservation_not_cancelled',
  'reservation_changed', 'reservation_past', 'reservation_wrong_day', 'survey_already_answered', 'waitlist_not_waiting', 'waitlist_not_seated',
  'waitlist_wrong_day', 'waitlist_changed', 'voucher_not_active', 'voucher_expired', 'voucher_changed', 'customer_not_alive', 'recipient_changed',
  'do_not_contact', 'invalid_timezone', 'service_suspended', 'channel_unavailable', 'channel_changed', 'binding_changed', 'dispatch_paused',
  'consent_changed', 'cost_not_authorized', 'template_unavailable', 'template_sync_failed', 'render_invalid', 'render_missing', 'promotion_frequency',
  'dependency_unavailable', 'expired', 'final_service_suspended', 'final_channel_changed', 'final_consent_changed', 'final_resource_changed',
  'final_gate_paused', 'post_lease_expired', 'post_ambiguous', 'response_invalid', 'documented_preproxy_429', 'provider_rejected', 'auth_rejected',
  'template_rejected', 'unknown_reason',
] as const;
export type DeliveryState = typeof DELIVERY_STATES[number];
export interface AutomationDeliveryRow {
  job_id: string; kind: typeof DELIVERY_KINDS[number]; state: DeliveryState; pin_phase: 'bound' | 'preconfiguration';
  reason: typeof DELIVERY_REASONS[number] | null; created_at: string; expires_at: string; finished_at: string | null;
  reconcile_required: boolean; has_pending_receipt: boolean; outstanding: boolean;
  reservation_id: string | null; waitlist_id: string | null; voucher_id: string | null;
}
export interface AutomationDeliveryStateV1 {
  version: 1; generated_at: string; counts: Record<DeliveryState, number> & { total: number; outstanding: number };
  oldest_nonterminal_at: string | null; rows: AutomationDeliveryRow[]; has_more: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]) => Object.keys(v).sort().join(',') === [...expected].sort().join(',');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function invalid(): never { throw new Error('automation_delivery_state_invalid'); }
function enumeration<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  for (const known of values) if (value === known) return known;
  return invalid();
}
/** Validate the complete authenticated response. A malformed page is an error, never partial data. */
export function parseAutomationDeliveryState(value: unknown, requestedLimit: number): AutomationDeliveryStateV1 {
  if (!record(value) || !keys(value, ['version', 'generated_at', 'counts', 'oldest_nonterminal_at', 'rows', 'has_more'])
    || value.version !== 1 || !timestamp(value.generated_at) || typeof value.has_more !== 'boolean'
    || (value.oldest_nonterminal_at !== null && !timestamp(value.oldest_nonterminal_at))
    || !Array.isArray(value.rows) || value.rows.length > Math.max(1, Math.min(requestedLimit, 100))) return invalid();
  const c = value.counts;
  if (!record(c) || !keys(c, [...DELIVERY_STATES, 'total', 'outstanding']) || !Object.values(c).every(integer)) return invalid();
  const counts = Object.fromEntries(DELIVERY_STATES.map(state => [state, c[state]])) as Record<DeliveryState, number>;
  if (!integer(c.total) || !integer(c.outstanding) || Object.values(counts).reduce((sum, n) => sum + n, 0) !== c.total
    || c.outstanding > c.total || (value.oldest_nonterminal_at === null) !== (c.outstanding === 0) || value.rows.length > c.total) return invalid();
  const ids = new Set<string>(), pageCounts = new Map<DeliveryState, number>();
  const rows = value.rows.map((r): AutomationDeliveryRow => {
    if (!record(r) || !keys(r, ['job_id', 'kind', 'state', 'pin_phase', 'reason', 'created_at', 'expires_at', 'finished_at', 'reconcile_required',
      'has_pending_receipt', 'outstanding', 'reservation_id', 'waitlist_id', 'voucher_id']) || !uuid(r.job_id) || ids.has(r.job_id.toLowerCase())
      || !timestamp(r.created_at) || !timestamp(r.expires_at) || (r.finished_at !== null && !timestamp(r.finished_at))
      || typeof r.reconcile_required !== 'boolean' || typeof r.has_pending_receipt !== 'boolean' || typeof r.outstanding !== 'boolean') return invalid();
    const kind = enumeration(r.kind, DELIVERY_KINDS), state = enumeration(r.state, DELIVERY_STATES);
    const pin_phase = enumeration(r.pin_phase, ['bound', 'preconfiguration']);
    const reason = r.reason === null ? null : enumeration(r.reason, DELIVERY_REASONS);
    const resource = kind === 'voucher_issued' ? 'voucher_id' : kind.startsWith('waitlist_') ? 'waitlist_id' : 'reservation_id';
    for (const key of ['reservation_id', 'waitlist_id', 'voucher_id']) if (key === resource ? !uuid(r[key]) : r[key] !== null) return invalid();
    if (pin_phase === 'preconfiguration' && (!['blocked', 'paused', 'needs_review', 'expired'].includes(state) || r.reconcile_required)) return invalid();
    ids.add(r.job_id.toLowerCase()); pageCounts.set(state, (pageCounts.get(state) ?? 0) + 1);
    const nullableId = (v: unknown): string | null => v === null ? null : uuid(v) ? v : invalid();
    return { job_id: r.job_id, kind, state, pin_phase, reason, created_at: r.created_at, expires_at: r.expires_at, finished_at: timestamp(r.finished_at) ? r.finished_at : null,
      reconcile_required: r.reconcile_required, has_pending_receipt: r.has_pending_receipt, outstanding: r.outstanding,
      reservation_id: nullableId(r.reservation_id), waitlist_id: nullableId(r.waitlist_id), voucher_id: nullableId(r.voucher_id) };
  });
  for (const [state, count] of pageCounts) if (count > counts[state]) return invalid();
  if (rows.filter(row => row.outstanding).length > c.outstanding) return invalid();
  return { version: 1, generated_at: value.generated_at, counts: { ...counts, total: c.total, outstanding: c.outstanding },
    oldest_nonterminal_at: timestamp(value.oldest_nonterminal_at) ? value.oldest_nonterminal_at : null, rows, has_more: value.has_more };
}

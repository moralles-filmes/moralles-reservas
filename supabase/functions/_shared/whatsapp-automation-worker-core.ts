type Candidate = { job_id: string; channel_id: string };
export interface WorkerAllocationV1 {
  version: 1; selected_at: string; sql_minute: number; priority: 'rechecks' | 'repairs'; mode: 'work' | 'maintenance'; expired_count: number;
  allocation: { total_limit: 0 | 20; auxiliary_limit: 0 | 5; rechecks: number; repairs: number; normal_limit: number; normal_count: number };
  normal: (Candidate & { action: 'dispatch' | 'resolve_posting_lease' })[];
  rechecks: Candidate[]; repairs: Candidate[];
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const integer = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function invalid(): never { throw new Error('automation_allocation_invalid'); }
/** Reject the entire SQL protocol before starting any candidate. No partial rows. */
export function parseWorkerAllocation(value: unknown): WorkerAllocationV1 {
  if (!record(value) || !keys(value, 'version,selected_at,sql_minute,priority,mode,expired_count,allocation,normal,rechecks,repairs')
    || value.version !== 1 || typeof value.selected_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.selected_at)
    || !Number.isFinite(Date.parse(value.selected_at)) || !integer(value.sql_minute, Number.MAX_SAFE_INTEGER)
    || value.priority !== (value.sql_minute % 2 === 0 ? 'rechecks' : 'repairs')
    || (value.mode !== 'work' && value.mode !== 'maintenance') || !integer(value.expired_count, 20)) return invalid();
  const a = value.allocation;
  if (!record(a) || !keys(a, 'total_limit,auxiliary_limit,rechecks,repairs,normal_limit,normal_count')
    || !integer(a.rechecks, 5) || !integer(a.repairs, 5) || !integer(a.normal_count, 20) || !integer(a.normal_limit, 20)) return invalid();
  const seen = new Set<string>();
  function rows(input: unknown, normal: true): WorkerAllocationV1['normal'];
  function rows(input: unknown, normal: false): Candidate[];
  function rows(input: unknown, normal: boolean): (Candidate & { action?: 'dispatch' | 'resolve_posting_lease' })[] {
    if (!Array.isArray(input) || input.length > (normal ? 20 : 5)) return invalid();
    return input.map(row => {
      if (!record(row) || !keys(row, normal ? 'job_id,channel_id,action' : 'job_id,channel_id')
        || !uuid(row.job_id) || !uuid(row.channel_id) || seen.has(row.job_id.toLowerCase())) return invalid();
      seen.add(row.job_id.toLowerCase());
      if (normal) {
        if (row.action !== 'dispatch' && row.action !== 'resolve_posting_lease') return invalid();
        return { job_id: row.job_id, channel_id: row.channel_id, action: row.action };
      }
      return { job_id: row.job_id, channel_id: row.channel_id };
    });
  }
  const normal = rows(value.normal, true), rechecks = rows(value.rechecks, false), repairs = rows(value.repairs, false);
  const work = value.mode === 'work', total = work ? 20 : 0, auxiliary = work ? 5 : 0;
  if (a.total_limit !== total || a.auxiliary_limit !== auxiliary || a.rechecks !== rechecks.length || a.repairs !== repairs.length
    || a.normal_count !== normal.length || a.rechecks + a.repairs > auxiliary || a.normal_limit !== total - a.rechecks - a.repairs
    || a.normal_count > a.normal_limit || seen.size > total) return invalid();
  return { version: 1, selected_at: value.selected_at, sql_minute: value.sql_minute, priority: value.sql_minute % 2 === 0 ? 'rechecks' : 'repairs', mode: value.mode,
    expired_count: value.expired_count, allocation: { total_limit: total, auxiliary_limit: auxiliary, rechecks: a.rechecks,
      repairs: a.repairs, normal_limit: a.normal_limit, normal_count: a.normal_count }, normal, rechecks, repairs };
}
export interface AutomationWorkIO {
  select(): Promise<unknown>; now(): number;
  /** One invocation of the actual same-job dispatcher; it performs at most one claim. */
  dispatchExisting(jobId: string): Promise<unknown>;
  claimExpiredPosting(jobId: string): Promise<unknown>;
  repair(jobId: string): Promise<unknown>;
}
export async function runAutomationWork(io: AutomationWorkIO, deadline: number) {
  const allocation = parseWorkerAllocation(await io.select()); // One call, no response retry/refill.
  const result = { expired_count: allocation.expired_count, actions: 0, claim_budget_used: 0, errors: 0, deadline_reached: false };
  const candidates = [
    ...allocation.normal.map(row => ({ ...row, run: row.action === 'resolve_posting_lease' ? io.claimExpiredPosting : io.dispatchExisting, claims: 1 })),
    ...allocation.rechecks.map(row => ({ ...row, run: io.dispatchExisting, claims: 1 })),
    ...allocation.repairs.map(row => ({ ...row, run: io.repair, claims: 0 })),
  ];
  // All actions sequential also serializes every channel. Deadline never aborts a started POST.
  for (const candidate of candidates) {
    if (io.now() >= deadline) { result.deadline_reached = true; break; }
    result.actions++;
    result.claim_budget_used += candidate.claims; // Reserve even when remote claim refuses/throws.
    try { await candidate.run(candidate.job_id); } catch { result.errors++; }
  }
  return result;
}

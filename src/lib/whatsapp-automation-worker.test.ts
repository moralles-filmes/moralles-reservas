import { describe, expect, it, vi } from 'vitest';
import { automationRetryDelayMs, nextRetryDelay } from '../../supabase/functions/_shared/whatsapp-automation-core';
import { parseWorkerAllocation, runAutomationWork } from '../../supabase/functions/_shared/whatsapp-automation-worker-core';

const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const allocation = () => ({ version: 1, selected_at: '2026-10-09T12:00:00Z', sql_minute: 29860560,
  priority: 'rechecks', mode: 'work', expired_count: 0,
  allocation: { total_limit: 20, auxiliary_limit: 5, rechecks: 1, repairs: 1, normal_limit: 18, normal_count: 2 },
  normal: [{ job_id: id(1), channel_id: id(100), action: 'resolve_posting_lease' }, { job_id: id(2), channel_id: id(100), action: 'dispatch' }],
  rechecks: [{ job_id: id(3), channel_id: id(100) }], repairs: [{ job_id: id(4), channel_id: id(100) }] });

describe('bounded automation worker', () => {
  it('aliases the existing five-attempt ladder', () => {
    expect(nextRetryDelay).toBe(automationRetryDelayMs);
    expect([1, 2, 3, 4, 5].map(nextRetryDelay)).toEqual([60000, 240000, 960000, 3840000, null]);
  });
  it.each(['extra', 'duplicate', 'budget', 'parity', 'timestamp', 'action'])('rejects whole invalid allocation: %s', fault => {
    const value = allocation();
    if (fault === 'extra') Object.assign(value, { secret: 'never accepted' });
    if (fault === 'duplicate') value.repairs[0].job_id = value.normal[0].job_id;
    if (fault === 'budget') value.allocation.normal_limit = 20;
    if (fault === 'parity') value.priority = 'repairs';
    if (fault === 'timestamp') value.selected_at = '2026-10-09';
    if (fault === 'action') value.normal[0].action = 'retry';
    expect(() => parseWorkerAllocation(value)).toThrow('automation_allocation_invalid');
  });
  it('uses one selection and one claim for expired posting, no dispatch for repair', async () => {
    const calls: string[] = [];
    const io = { select: vi.fn(async () => allocation()), now: () => 0,
      claimExpiredPosting: vi.fn(async (job: string) => { calls.push(`claim:${job}`); }),
      dispatchExisting: vi.fn(async (job: string) => { calls.push(`dispatch:${job}`); }),
      repair: vi.fn(async (job: string) => { calls.push(`repair:${job}`); }) };
    const result = await runAutomationWork(io, 1000);
    expect(io.select).toHaveBeenCalledOnce();
    expect(io.claimExpiredPosting).toHaveBeenCalledOnce();
    expect(io.claimExpiredPosting).toHaveBeenCalledWith(id(1));
    expect(io.dispatchExisting).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ actions: 4, claim_budget_used: 3, errors: 0 });
    expect(calls).toHaveLength(4);
  });
  it('does not retry a lost selector response or act on malformed DTO', async () => {
    const dispatchExisting = vi.fn();
    const io = { select: vi.fn(async () => { throw new Error('lost'); }), now: () => 0,
      claimExpiredPosting: vi.fn(), dispatchExisting, repair: vi.fn() };
    await expect(runAutomationWork(io, 1000)).rejects.toThrow('lost');
    expect(io.select).toHaveBeenCalledOnce(); expect(dispatchExisting).not.toHaveBeenCalled();
  });
  it('counts failed actions and lets in-flight action finish beyond deadline', async () => {
    let now = 0;
    const io = { select: async () => allocation(), now: () => now,
      claimExpiredPosting: vi.fn(async () => { now = 2000; throw new Error('transient'); }),
      dispatchExisting: vi.fn(), repair: vi.fn() };
    const result = await runAutomationWork(io, 1000);
    expect(result).toMatchObject({ actions: 1, claim_budget_used: 1, errors: 1, deadline_reached: true });
    expect(io.dispatchExisting).not.toHaveBeenCalled();
  });
  it('saturated work remains serial and counts refused claims without refilling', async () => {
    const dto = allocation();
    dto.normal = Array.from({ length: 15 }, (_, i) => ({ job_id: id(i + 1), channel_id: id(100), action: i === 0 ? 'resolve_posting_lease' : 'dispatch' }));
    dto.rechecks = [16, 17, 18].map(i => ({ job_id: id(i), channel_id: id(100) }));
    dto.repairs = [19, 20].map(i => ({ job_id: id(i), channel_id: id(100) }));
    dto.allocation = { total_limit: 20, auxiliary_limit: 5, rechecks: 3, repairs: 2, normal_limit: 15, normal_count: 15 };
    let active = 0, maximum = 0; const seen: string[] = [];
    const action = async (job: string) => { active++; maximum = Math.max(maximum, active); seen.push(job); await Promise.resolve(); active--; throw new Error('refused claim'); };
    const select = vi.fn(async () => dto), repair = vi.fn(async (job: string) => { seen.push(job); });
    expect(await runAutomationWork({ select, now: () => 0, dispatchExisting: action, claimExpiredPosting: action, repair }, 1000))
      .toMatchObject({ actions: 20, claim_budget_used: 18, errors: 18, deadline_reached: false });
    expect(maximum).toBe(1); expect(new Set(seen).size).toBe(20); expect(select).toHaveBeenCalledOnce(); expect(repair).toHaveBeenCalledTimes(2);
  });
});

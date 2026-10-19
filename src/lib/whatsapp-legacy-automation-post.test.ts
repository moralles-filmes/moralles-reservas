import { describe, expect, it, vi } from 'vitest';
import { createLegacyAutomationPostGuard, LEGACY_AUTOMATION_REFUSED, LEGACY_AUTOMATION_UNCERTAIN,
  type LegacyAutomationIntent } from '../../supabase/functions/_shared/whatsapp-legacy-automation-post';
import { createWhatsAppChannelService, type ChannelReadQuery, type ChannelServiceDependencies } from '../../supabase/functions/_shared/whatsapp-channel-service';

const ids = { channel: '33333333-0000-4000-8000-000000000001', unit: 'bbbbbbbb-0000-4000-8000-000000000001',
  resource: 'eeeeeeee-0000-4000-8000-000000000001', intent: '11111111-0000-4000-8000-000000000001', fence: '22222222-0000-4000-8000-000000000001' };
const intent: LegacyAutomationIntent = { kind: 'confirmation', resourceId: ids.resource, origin: 'send-confirmation' };
const allowedClaim = { allowed: true, intent_id: ids.intent, fence: ids.fence };
const claimed = { allowed: true as const, intentId: ids.intent, fence: ids.fence };

/** Supplied RPC outcomes only: this proves production JS wiring, never SQL locks. */
function setup() {
  const trace: string[] = [];
  const channel = { id: ids.channel, unit_id: ids.unit, provider: 'zapi', credentials: { token: 'synthetic-old' },
    status: 'connected', is_active: true, instance_token_secret_id: null, template_credential_revision: 4,
    last_health_check_at: '2026-10-05T15:00:00Z' };
  const controls = { duringCredentials: () => {}, beforeRpc: (_name: string) => {} };
  const replies: Record<string, unknown> = {
    claim_whatsapp_legacy_automation_post: allowedClaim,
    confirm_whatsapp_legacy_automation_post: { allowed: true },
    finish_whatsapp_legacy_automation_post: { recorded: true, state: 'accepted' },
    release_whatsapp_legacy_automation_claim: { released: true },
  };
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    controls.beforeRpc(name); trace.push(name);
    if (!(name in replies)) throw new Error('unexpected_rpc');
    if (replies[name] instanceof Error) throw replies[name];
    return { data: replies[name], error: null };
  });
  const columns: string[] = [];
  const db = { rpc, from: (_table: string) => ({ select: (projection: string) => {
    columns.push(projection); trace.push('select');
    const row = Object.fromEntries(projection.split(',').map(key => [key.trim(), structuredClone(channel[key.trim() as keyof typeof channel])]));
    const q: ChannelReadQuery = { eq: () => q, is: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: row, error: null }),
      then: (yes, no) => Promise.resolve({ data: row, error: null }).then(yes, no) };
    return q;
  } }) };
  const outbound = vi.fn<ChannelServiceDependencies['sendOutbound']>(async () => {
    trace.push('provider'); return { ok: true, providerMessageId: 'synthetic-provider-id' };
  });
  const service = createWhatsAppChannelService({ db, resolveCredentials: async (_db, selected) => {
    trace.push('credentials'); controls.duringCredentials(); return { ...selected.credentials };
  }, resolveServiceGate: async () => null, clearServiceGateCache: () => {}, getProvider: () => null,
  sendOutbound: outbound, now: () => Date.parse('2026-10-05T15:00:00Z'), log: () => {} });
  const send = (scope: LegacyAutomationIntent | undefined = intent, beforeOutbound?: () => string | null) =>
    service.sendWhatsApp('11900000000', 'synthetic content', { unit_id: ids.unit, legacyAutomation: scope, beforeOutbound });
  return { channel, controls, replies, rpc, columns, outbound, trace, service, send };
}

describe('legacy automation guard strict RPC contracts', () => {
  it.each([null, {}, { allowed: true }, { allowed: true, intent_id: ids.intent, fence: ids.fence, leaked: 'extra' },
    { allowed: false, reason: 'arbitrary database error' }])('refuses invalid/unknown claim DTO %j', async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    expect(await createLegacyAutomationPostGuard({ rpc }).claim(intent, ids.channel, 4))
      .toMatchObject({ allowed: false, reason: 'dependency_unavailable' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('synthetic transport'), { allowed: true, unexpected: true }, null])('never releases after ambiguous confirm %j', async data => {
    const f = setup(); f.replies.confirm_whatsapp_legacy_automation_post = data;
    expect(await f.send()).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_REFUSED });
    expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('release_whatsapp_legacy_automation_claim');
    expect(f.outbound).not.toHaveBeenCalled();
  });
  it('releases only an explicit closed confirmation refusal, with the original fence', async () => {
    const f = setup(); f.replies.confirm_whatsapp_legacy_automation_post = { allowed: false, reason: 'channel_changed' };
    expect(await f.send()).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_REFUSED });
    expect(f.rpc).toHaveBeenLastCalledWith('release_whatsapp_legacy_automation_claim', {
      p_intent_id: ids.intent, p_fence: ids.fence, p_reason: 'confirmation_refused' });
    expect(f.outbound).not.toHaveBeenCalled();
  });
  it('accepted without an ID is finished as uncertain', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { recorded: true, state: 'uncertain' }, error: null });
    expect(await createLegacyAutomationPostGuard({ rpc }).finish(claimed, 'accepted')).toBe('uncertain');
    expect(rpc).toHaveBeenCalledWith('finish_whatsapp_legacy_automation_post', {
      p_intent_id: ids.intent, p_fence: ids.fence, p_outcome: 'uncertain', p_provider_message_id: null });
  });
  it('retains the original fence for a late finish and does not accept a conflicting ID reply', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { recorded: true, state: 'accepted' }, error: null })
      .mockResolvedValueOnce({ data: { recorded: false, state: 'uncertain', reason: 'fence_changed' }, error: null });
    const guard = createLegacyAutomationPostGuard({ rpc });
    expect(await guard.finish(claimed, 'accepted', 'synthetic-original')).toBe('accepted');
    expect(await guard.finish(claimed, 'accepted', 'synthetic-conflicting')).toBe('uncertain');
    expect(rpc.mock.calls.every(([, args]) => args.p_fence === ids.fence && args.p_intent_id === ids.intent)).toBe(true);
  });
});

describe('real channel factory retains scoped credential/fence authority', () => {
  it.each(['confirmation','reminder_d1','survey_d1','cancellation','waitlist_entered','waitlist_feedback','waitlist_table_ready','voucher_issued'] as const)('guards %s and finishes before returning to projection writers', async kind => {
    const f = setup();
    const origin = kind === 'confirmation' ? 'send-confirmation' : kind === 'cancellation' ? 'send-cancellation' : 'send-whatsapp';
    expect(await f.send({ ...intent, kind, origin })).toMatchObject({ ok: true, providerMessageId: 'synthetic-provider-id' });
    expect(f.columns[0]).toContain('credentials'); expect(f.columns[0]).toContain('template_credential_revision');
    expect(f.rpc).toHaveBeenNthCalledWith(1, 'claim_whatsapp_legacy_automation_post', {
      p_kind: kind, p_resource_id: ids.resource, p_channel_id: ids.channel, p_expected_credential_revision: 4, p_origin: origin });
    expect(f.trace.slice(-3)).toEqual(['confirm_whatsapp_legacy_automation_post','provider','finish_whatsapp_legacy_automation_post']);
    expect(f.outbound).toHaveBeenCalledWith('zapi', { token: 'synthetic-old' },
      { toPhone: '11900000000', text: 'synthetic content' }, { retryPolicy: 'none' });
  });
  it.each(['claim','confirm'])('uses the original revision if credentials rotate before %s', async phase => {
    const f = setup();
    const target = phase === 'claim' ? 'claim_whatsapp_legacy_automation_post' : 'confirm_whatsapp_legacy_automation_post';
    if (phase === 'claim') f.controls.duringCredentials = () => { f.channel.template_credential_revision = 5; f.channel.credentials.token = 'synthetic-new'; };
    else f.controls.beforeRpc = name => { if (name === target) f.channel.template_credential_revision = 5; };
    f.replies[target] = { allowed: false, reason: 'channel_changed' };
    expect(await f.send()).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_REFUSED });
    const args = f.rpc.mock.calls.find(([name]) => name === target)![1];
    expect(args.p_expected_credential_revision).toBe(4);
    expect(f.outbound).not.toHaveBeenCalled();
  });
  it('marks uncertain after a synchronous guard refuses following posting, without release', async () => {
    const f = setup();
    expect(await f.send(intent, () => 'outside_window')).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_UNCERTAIN });
    expect(f.rpc).toHaveBeenLastCalledWith('finish_whatsapp_legacy_automation_post', {
      p_intent_id: ids.intent, p_fence: ids.fence, p_outcome: 'uncertain', p_provider_message_id: null });
    expect(f.outbound).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('release_whatsapp_legacy_automation_claim');
  });
  it.each(['throw','failed','missing_id','finish_error'] as const)('closes ambiguity %s without provider retry', async failure => {
    const f = setup();
    if (failure === 'throw') f.outbound.mockRejectedValue(new Error('synthetic timeout'));
    if (failure === 'failed') f.outbound.mockResolvedValue({ ok: false, status: 503 });
    if (failure === 'missing_id') f.outbound.mockResolvedValue({ ok: true });
    if (failure === 'finish_error') f.replies.finish_whatsapp_legacy_automation_post = new Error('synthetic DB unavailable');
    expect(await f.send()).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_UNCERTAIN });
    expect(f.outbound).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'finish_whatsapp_legacy_automation_post')).toHaveLength(1);
  });
  it('keeps unscoped/manual/chat sends and their synchronous guard unchanged', async () => {
    const f = setup();
    expect(await f.service.sendWhatsApp('11900000000','unscoped',{ unit_id: ids.unit })).toMatchObject({ ok: true });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.columns[0]).not.toContain('template_credential_revision');
    expect(f.outbound.mock.calls[0][3]).toBeUndefined();
    expect(await f.service.sendWhatsApp('11900000000','unscoped',{ unit_id: ids.unit, beforeOutbound: () => 'outside_window' }))
      .toMatchObject({ ok: false, error: 'outside_window' });
    expect(f.outbound).toHaveBeenCalledTimes(1);
  });
  it('a credential dependency before claim is recoverable without POST evidence', async () => {
    const f = setup(); f.controls.duringCredentials = () => { throw new Error('synthetic Vault unavailable'); };
    expect(await f.send()).toMatchObject({ ok: false, error: LEGACY_AUTOMATION_REFUSED });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.outbound).not.toHaveBeenCalled();
    f.controls.duringCredentials = () => {};
    expect(await f.send()).toMatchObject({ ok: true }); expect(f.outbound).toHaveBeenCalledTimes(1);
  });
});

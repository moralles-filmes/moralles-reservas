import { AUTOMATION_POST_TIMEOUT_MS, automationDeadline, classifyAutomationOutcome, parseAutomationLedger,
  recordedDispatchResult, type AutomationLedger, type AutomationOutcome, type AutomationPreflightReason,
  type DispatchResult, type LocalPreflightReason, type ScheduledIntent, type ScheduledKind } from './whatsapp-automation-core.ts';
import { createAutomationResourceService, renderScheduledTemplate, renderScheduledText, type ScheduledResource } from './whatsapp-automation-resources.ts';
import type { ScheduledChannel, ScheduledChannelResult } from './whatsapp-channel-service.ts';
import { createPreferenceToken } from './whatsapp-message-preferences-core.ts';
import { TEMPLATE_CATALOG, catalogHash } from './whatsapp-template-catalog-core.ts';
import { brtFactAt } from './whatsapp-message-ttl-core.ts';

export interface AutomationDispatchIO {
  readOne(table: string, columns: string, predicates: Readonly<Record<string, string>>, latest?: string): Promise<unknown>;
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  capture(jobId: string, fence: string, safeBody: string): Promise<boolean>;
  repairAccepted(jobId: string): Promise<{ state: 'reconciled' | 'not_accepted' | 'deferred' }>;
  prepareScheduledChannel(unitId: string, channelId: string): Promise<ScheduledChannelResult>;
  observeTemplates?(accountId: string): Promise<unknown>;
  defer?(work: Promise<unknown>): void;
  now(): number;
  appBaseUrl: string;
  allowedOrigins: readonly string[];
}
type Row = Record<string, unknown>;
function record(value: unknown): Row | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value); }
function instant(value: unknown): value is string { return typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
const notEnqueued = (reason: Extract<DispatchResult, { state: 'not_enqueued' }>['reason']): DispatchResult => ({ state: 'not_enqueued', jobId: null, reason });
function intentFromRow(row: Row): ScheduledIntent {
  if (!uuid(row.unit_id) || typeof row.source_event_key !== 'string' || !row.source_event_key || !instant(row.fact_at)) throw new Error('invalid_job');
  const origin = { unitId: row.unit_id, sourceEventKey: row.source_event_key, factAt: row.fact_at };
  switch (row.kind) {
    case 'confirmation': case 'reminder_d1': case 'survey_d1': case 'cancellation':
      if (uuid(row.reservation_id) && row.waitlist_id === null && row.voucher_id === null) return { ...origin, kind: row.kind, reservationId: row.reservation_id }; break;
    case 'waitlist_entered': case 'waitlist_feedback': case 'waitlist_table_ready':
      if (uuid(row.waitlist_id) && row.reservation_id === null && row.voucher_id === null) return { ...origin, kind: row.kind, waitlistId: row.waitlist_id }; break;
    case 'voucher_issued':
      if (uuid(row.voucher_id) && row.reservation_id === null && row.waitlist_id === null) return { ...origin, kind: row.kind, voucherId: row.voucher_id }; break;
  }
  throw new Error('invalid_job');
}
function sameChannel(channel: ScheduledChannel, job: Extract<AutomationLedger, { pinPhase: 'bound' }>, unitId: string): boolean {
  const p = job.pins;
  return channel.id === p.channelId && channel.unitId === unitId && channel.provider === p.provider && channel.transport === p.transport
    && channel.bindingId === p.bindingId && channel.generation === p.bindingGeneration && channel.accountId === p.accountId;
}
type Authority = { consentRevision: number | null; syncEpoch: number | null; phoneNumberId: string | null; templateSnapshot: string | null };
type AuthorityResult = { ok: true; authority: Authority } | { ok: false; reason: AutomationPreflightReason };

/** Runtime authentication precedes this internal-only producer entry. No caller fact/pins are accepted. */
export interface ScheduledProducerRequest { kind: ScheduledKind; resourceId: string; unitId?: string; outboxId?: string; targetDate?: string }
export interface OperatorProducerRequest { kind: 'cancellation' | 'waitlist_table_ready'; resourceId: string; unitId: string }

export function createAutomationDispatcher(io: AutomationDispatchIO) {
  const resources = createAutomationResourceService({ readOne: io.readOne, now: io.now });
  const read = async (table: string, columns: string, predicates: Record<string, string>, latest?: string) => record(await io.readOne(table, columns, predicates, latest));
  async function loadJob(jobId: string) {
    const row = await read('whatsapp_automation_jobs', '*', { id: jobId });
    if (!row || row.id !== jobId) throw new Error('job_unavailable');
    return { row, job: parseAutomationLedger(row) };
  }
  async function currentResult(jobId: string, fallback: AutomationLedger): Promise<DispatchResult> {
    try { return recordedDispatchResult((await loadJob(jobId)).job); }
    catch { return recordedDispatchResult(fallback); }
  }
  async function repair(job: AutomationLedger): Promise<DispatchResult> {
    if (job.pinPhase !== 'bound') return recordedDispatchResult(job);
    const result = await io.repairAccepted(job.jobId);
    return result.state === 'reconciled' ? { state: 'reconciled', pinPhase: 'bound', jobId: job.jobId, reason: 'local_acceptance_reconciled' }
      : { state: 'accepted', pinPhase: 'bound', jobId: job.jobId, ...(job.providerMessageId ? { providerMessageId: job.providerMessageId } : {}) };
  }
  async function authority(job: Extract<AutomationLedger, { pinPhase: 'bound' }>, resource: ScheduledResource, refresh: boolean): Promise<AuthorityResult> {
    const flag = await read('platform_flags', 'value', { key: 'whatsapp_automation_dispatch' });
    if (flag && typeof flag.value !== 'boolean') return { ok: false, reason: 'dependency_unavailable' };
    if (flag?.value !== true) return { ok: false, reason: 'dispatch_paused' };
    const promotional = resource.intent.kind === 'waitlist_feedback' || resource.intent.kind === 'voucher_issued';
    const consent = resource.customerId ? await read('whatsapp_message_consent_events', 'decision,revision', {
      unit_id: resource.unitId, customer_id: resource.customerId, purpose: promotional ? 'promotional' : 'operational' }, 'revision') : null;
    if (consent && (!Number.isSafeInteger(consent.revision) || Number(consent.revision) < 1 || !['opt_in','opt_out','unknown'].includes(String(consent.decision)))) return { ok: false, reason: 'dependency_unavailable' };
    if (consent?.decision === 'opt_out' || (promotional && consent?.decision !== 'opt_in')) return { ok: false, reason: 'consent_changed' };
    const consentRevision = consent ? Number(consent.revision) : null;
    if (job.pins.transport === 'text') return { ok: true, authority: { consentRevision, syncEpoch: null, phoneNumberId: null, templateSnapshot: null } };
    const pins = job.pins;
    let template = await read('whatsapp_remote_templates', '*', { id: pins.remoteTemplateId, account_id: pins.accountId });
    if (refresh && template && (template.sync_required === true || !instant(template.last_synced_at) || io.now() - Date.parse(template.last_synced_at) > 60_000)) {
      try { if (!io.observeTemplates) throw new Error('sync_unavailable'); await io.observeTemplates(pins.accountId); }
      catch { return { ok: false, reason: 'template_sync_failed' }; }
      template = await read('whatsapp_remote_templates', '*', { id: pins.remoteTemplateId, account_id: pins.accountId });
    }
    const definition = TEMPLATE_CATALOG[resource.templateId];
    const hash = await catalogHash(definition);
    if (!template || definition.state !== 'active' || template.logical_id !== definition.id || template.name !== definition.name
      || template.version !== 1 || pins.templateVersion !== 1 || template.language !== 'pt_BR'
      || (pins.initialCatalogKey !== null && pins.initialCatalogKey !== definition.id)
      || template.desired_hash !== hash || template.observed_hash !== hash || template.requested_category !== definition.requestedCategory
      || template.effective_category !== definition.requestedCategory || (definition.requestedCategory === 'MARKETING' && template.quality === 'RED')
      || template.local_status !== 'usable' || template.remote_status !== 'APPROVED' || template.sync_required !== false
      || !instant(template.last_synced_at) || io.now() - Date.parse(template.last_synced_at) > 60_000
      || typeof template.remote_id !== 'string' || !template.remote_id || !Number.isSafeInteger(template.sync_epoch)) return { ok: false, reason: 'template_unavailable' };
    const channel = await read('whatsapp_channels', 'id,unit_id,phone_number_id:credentials->>phone_number_id', { id: pins.channelId, unit_id: resource.unitId });
    if (!channel || typeof channel.phone_number_id !== 'string' || !/^\d+$/.test(channel.phone_number_id)) return { ok: false, reason: 'channel_unavailable' };
    // Cost, binding/account GET authority and slot ownership are rechecked in BOTH SQL prepare and final confirm.
    return { ok: true, authority: { consentRevision, syncEpoch: Number(template.sync_epoch), phoneNumberId: channel.phone_number_id,
      templateSnapshot: JSON.stringify(template) } };
  }
  async function dispatchExistingJob(jobId: string): Promise<DispatchResult> {
    if (!uuid(jobId)) return notEnqueued('intent_invalid');
    let initial: Awaited<ReturnType<typeof loadJob>>;
    try { initial = await loadJob(jobId); } catch { return notEnqueued('dependency_unavailable'); }
    let { row, job } = initial;
    // Durable evidence wins over present resource eligibility, consent, erasure and flags.
    if (job.pinPhase === 'preconfiguration') return recordedDispatchResult(job);
    if (job.state === 'accepted' || job.state === 'reconciled') return repair(job);
    if (['uncertain','posting','needs_review','expired','failed','rejected'].includes(job.state)) return recordedDispatchResult(job);
    let intent: ScheduledIntent;
    try {
      intent = intentFromRow(row);
      if (!instant(row.expires_at) || Date.parse(row.expires_at) !== Date.parse(automationDeadline(intent.kind, intent.factAt))) throw new Error('deadline_invalid');
      if (job.state === 'blocked' || job.state === 'paused') {
        const loaded = await resources.loadScheduledResource(intent);
        if (!loaded.ok || !(await authority(job, loaded.resource, true)).ok) return recordedDispatchResult(job);
        if (await io.rpc('requeue_whatsapp_automation', { p_job_id: jobId }) !== true) return currentResult(jobId, job);
      }
      const claimed = record(await io.rpc('claim_whatsapp_automation', { p_job_id: jobId }));
      if (!claimed) return currentResult(jobId, job);
      const parsed = parseAutomationLedger(claimed);
      if (parsed.pinPhase !== 'bound' || parsed.state !== 'claimed' || parsed.jobId !== jobId || !uuid(claimed.claim_token)) return currentResult(jobId, job);
      if (JSON.stringify(parsed.pins) !== JSON.stringify(job.pins) || JSON.stringify(intentFromRow(claimed)) !== JSON.stringify(intent)) return currentResult(jobId, job);
      row = claimed; job = parsed;
    } catch { return currentResult(jobId, job); }
    const fence = row.claim_token as string; // Narrowed UUID from actual claim above, never a body field.
    const claimedJob = job;
    let prepared = false, postAttempted = false;
    async function block(reason: AutomationPreflightReason) {
      await io.rpc('block_whatsapp_automation_preflight', { p_job_id: jobId, p_fence: fence, p_reason: reason });
      return currentResult(jobId, claimedJob);
    }
    async function zero(reason: LocalPreflightReason) {
      if (!postAttempted) await io.rpc('finish_whatsapp_automation', { p_job_id: jobId, p_fence: fence,
        p_result: { outcome: 'local_preflight_refused', reason } });
      return currentResult(jobId, claimedJob);
    }
    async function finish(outcome: AutomationOutcome & { retry_after_seconds?: number }): Promise<DispatchResult> {
      try { await io.rpc('finish_whatsapp_automation', { p_job_id: jobId, p_fence: fence, p_result: outcome }); } catch { /* Read durable evidence below; the adapter reply is not a committed ledger. */ }
      try {
        const persisted = (await loadJob(jobId)).job;
        if (persisted.pinPhase === 'bound' && (persisted.state === 'accepted' || persisted.state === 'reconciled')) return repair(persisted);
        if (persisted.state !== 'posting') return recordedDispatchResult(persisted);
      } catch { /* Cannot infer acceptance from the invocation. */ }
      return { state: 'uncertain', pinPhase: 'bound', jobId, reason: 'acceptance_not_persisted' };
    }
    try {
      const loaded = await resources.loadScheduledResource(intent);
      if (loaded.ok === false) return block(loaded.reason);
      const resource = loaded.resource;
      if (resource.customerId !== row.customer_id || resource.organizationId !== row.organization_id) return block('recipient_changed');
      const initialAuthority = await authority(claimedJob, resource, true);
      if (initialAuthority.ok === false) return block(initialAuthority.reason);
      const first = await io.prepareScheduledChannel(resource.unitId, claimedJob.pins.channelId);
      if (first.ok === false) return block(first.error === 'whatsapp_service_suspended' ? 'service_suspended' : 'channel_unavailable');
      if (!sameChannel(first.channel, claimedJob, resource.unitId)) return block('channel_changed');
      let token: string | undefined;
      if (intent.kind === 'voucher_issued' || intent.kind === 'waitlist_feedback') {
        const generated = await createPreferenceToken();
        if (await io.rpc('issue_whatsapp_preference_token', { p_job_id: jobId, p_token_hash: generated.hash }) !== true) return block('consent_changed');
        token = generated.token;
      }
      let rendered: Awaited<ReturnType<typeof renderScheduledText>>;
      try {
        rendered = claimedJob.pins.transport === 'template'
          ? renderScheduledTemplate(resource, io.appBaseUrl, io.allowedOrigins, token)
          : await renderScheduledText(resource, io, token);
      } catch { return block('render_invalid'); }
      if (!(await io.capture(jobId, fence, rendered.safeLogBody))) return currentResult(jobId, claimedJob);
      const args = { p_job_id: jobId, p_fence: fence, p_generation: claimedJob.pins.bindingGeneration,
        p_consent_revision: initialAuthority.authority.consentRevision, p_sync_epoch: initialAuthority.authority.syncEpoch };
      if (await io.rpc('prepare_whatsapp_automation_post', args) !== true) return currentResult(jobId, claimedJob);
      prepared = true;
      const finalResource = await resources.loadScheduledResource(intent);
      if (!finalResource.ok || finalResource.resource.snapshot !== resource.snapshot) return zero('final_resource_changed');
      const finalAuthority = await authority(claimedJob, finalResource.resource, false);
      if (finalAuthority.ok === false) {
        if (finalAuthority.reason === 'dispatch_paused') return zero('final_gate_paused');
        if (finalAuthority.reason === 'consent_changed') return zero('final_consent_changed');
        // No invented reset reason for template/DB failure.
        return currentResult(jobId, claimedJob);
      }
      if (finalAuthority.authority.consentRevision !== initialAuthority.authority.consentRevision) return zero('final_consent_changed');
      if (JSON.stringify(finalAuthority.authority) !== JSON.stringify(initialAuthority.authority)) return currentResult(jobId, claimedJob);
      // LAST volatile async read: use ONLY this private closure, never first.channel.
      const last = await io.prepareScheduledChannel(resource.unitId, claimedJob.pins.channelId);
      if (last.ok === false) return zero(last.error === 'whatsapp_service_suspended' ? 'final_service_suspended' : 'final_channel_changed');
      if (!sameChannel(last.channel, claimedJob, resource.unitId) || last.channel.credentialRevision !== first.channel.credentialRevision) return zero('final_channel_changed');
      const channel = last.channel;
      const templateInput = { phoneNumberId: initialAuthority.authority.phoneNumberId ?? '', toPhone: resource.phone,
        name: resource.templateId, language: 'pt_BR', parameters: rendered.parameters };
      const textInput = { toPhone: resource.phone, text: rendered.body };
      // SQL ownership is the FINAL await. No logging, read, renewal or timer await in this gap.
      const confirmed = record(await io.rpc('confirm_whatsapp_automation_resource_post', { ...args, p_expected: resource.expected }));
      const keys = confirmed ? Object.keys(confirmed).sort().join(',') : '';
      if (confirmed?.allowed === false && keys === 'allowed,reason' && confirmed.reason === 'resource_changed') return zero('final_resource_changed');
      if (confirmed?.allowed !== true || keys !== 'allowed') return currentResult(jobId, claimedJob);
      postAttempted = true;
      const invocation = channel.transport === 'template' ? channel.sendTemplate(templateInput) : channel.sendText(textInput);
      const settled = Promise.resolve(invocation).then(result => {
        if ('state' in result) {
          if (result.state === 'accepted') return classifyAutomationOutcome({ provider: channel.provider, status: result.status, messageId: result.providerMessageId });
          if (channel.provider === 'datafy' && result.state === 'rejected' && result.retryable && result.status === 429)
            return { outcome: 'rejected' as const, reason: 'documented_preproxy_429' as const, retry_after_seconds: result.retryAfterSeconds };
          return { outcome: 'uncertain' as const, reason: 'post_ambiguous' as const };
        }
        return classifyAutomationOutcome({ provider: channel.provider, status: result.ok ? 200 : undefined, messageId: result.providerMessageId });
      }, () => ({ outcome: 'uncertain' as const, reason: 'post_ambiguous' as const }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), AUTOMATION_POST_TIMEOUT_MS); });
      const outcome = await Promise.race([settled, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === null) {
        // Bounded response, observed late result. Late acceptance retains the ORIGINAL fence.
        const lateRepair = settled.then(late => late.outcome === 'accepted' ? finish(late) : undefined).catch(() => undefined);
        io.defer?.(lateRepair);
        return finish({ outcome: 'uncertain', reason: 'post_ambiguous' });
      }
      return finish(outcome);
    } catch {
      if (postAttempted) return finish({ outcome: 'uncertain', reason: 'post_ambiguous' });
      if (!prepared) { try { return await block('dependency_unavailable'); } catch { /* no authority */ } }
      return currentResult(jobId, claimedJob);
    }
  }

  async function enqueueScheduledIntent(input: ScheduledProducerRequest): Promise<DispatchResult> {
    if (!uuid(input.resourceId) || (input.unitId !== undefined && !uuid(input.unitId))) return notEnqueued('intent_invalid');
    try {
      const table = ['confirmation','reminder_d1','survey_d1','cancellation'].includes(input.kind) ? 'reservations' : input.kind === 'voucher_issued' ? 'vouchers' : 'waitlist';
      const key = table === 'reservations' ? 'reservation_id' : table === 'waitlist' ? 'waitlist_id' : 'voucher_id';
      // Existing ledger first, with no join/current resource filter that could hide erased acceptance.
      const existing = await read('whatsapp_automation_jobs', '*', { kind: input.kind, [key]: input.resourceId, ...(input.unitId ? { unit_id: input.unitId } : {}) });
      if (existing) return recordedDispatchResult(parseAutomationLedger(existing));
      // Operator facts require the dedicated authenticated entry, but prior durable jobs remain visible.
      if (input.kind === 'voucher_issued' || input.kind === 'cancellation' || input.kind === 'waitlist_table_ready') return notEnqueued('provenance_refused');
      const row = await read(table, '*', { id: input.resourceId });
      if (!row || !uuid(row.unit_id) || (input.unitId && input.unitId !== row.unit_id)) return notEnqueued('resource_refused');
      const adoption = await read('whatsapp_automation_adoptions', 'adopted_at', { unit_id: row.unit_id });
      if (!adoption) return notEnqueued('adoption_required');
      if (!instant(adoption.adopted_at)) return notEnqueued('dependency_unavailable');
      let factAt: string | null = null, originAt: string | null = null, sourceEventKey: string;
      if (input.kind === 'confirmation') {
        if (!uuid(input.outboxId)) return notEnqueued('provenance_refused');
        const outbox = await read('notification_outbox', 'id,reservation_id,unit_id,kind,created_at', { id: input.outboxId });
        if (!outbox || outbox.reservation_id !== row.id || outbox.unit_id !== row.unit_id || outbox.kind !== 'confirmation' || !instant(outbox.created_at)) return notEnqueued('provenance_refused');
        originAt = outbox.created_at; sourceEventKey = `outbox:${input.outboxId}`;
        factAt = typeof row.date === 'string' && typeof row.time === 'string' ? brtFactAt(row.date, row.time.slice(0, 5)) : null;
      } else if (input.kind === 'waitlist_entered') {
        originAt = instant(row.created_at) ? row.created_at : null; factAt = originAt; sourceEventKey = `waitlist_entered:${input.resourceId}`;
      } else {
        const today = new Date(io.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const yesterday = new Date(io.now() - 27 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const target = input.kind === 'reminder_d1' ? today : yesterday;
        if (input.targetDate !== target) return notEnqueued('provenance_refused');
        if (input.kind === 'waitlist_feedback') {
          if (row.status !== 'seated' || !instant(row.seated_at) || new Date(Date.parse(row.seated_at) - 3 * 60 * 60 * 1000).toISOString().slice(0, 10) !== target) return notEnqueued('resource_refused');
        } else if (row.date !== target || row.status !== 'confirmed' || (input.kind === 'survey_d1' && row.satisfaction_rating !== null)) return notEnqueued('resource_refused');
        originAt = new Date(io.now()).toISOString(); sourceEventKey = `${input.kind}:${target}:${input.resourceId}`;
        factAt = brtFactAt(target, input.kind === 'reminder_d1' && typeof row.time === 'string' ? row.time.slice(0, 5) : '23:59');
      }
      if (!originAt || !factAt) return notEnqueued('provenance_refused');
      if (Date.parse(originAt) < Date.parse(adoption.adopted_at)) return notEnqueued('producer_before_adoption');
      const jobId = await io.rpc('enqueue_whatsapp_automation', { p_intent: { unit_id: row.unit_id, kind: input.kind,
        [key]: input.resourceId, source_event_key: sourceEventKey, fact_at: factAt, expires_at: automationDeadline(input.kind, factAt) } });
      if (jobId === null) return notEnqueued('legacy_already_accepted');
      return uuid(jobId) ? recordedDispatchResult((await loadJob(jobId)).job) : notEnqueued('dependency_unavailable');
    } catch { return notEnqueued('dependency_unavailable'); }
  }
  async function enqueueOperatorIntent(input: OperatorProducerRequest): Promise<DispatchResult> {
    if (!uuid(input.resourceId) || !uuid(input.unitId)) return notEnqueued('intent_invalid');
    const table = input.kind === 'cancellation' ? 'reservations' : 'waitlist';
    const key = input.kind === 'cancellation' ? 'reservation_id' : 'waitlist_id';
    try {
      // Durable ownership precedes mutable resource status, adoption and dispatch gates.
      const existing = await read('whatsapp_automation_jobs', '*', { unit_id: input.unitId, kind: input.kind, [key]: input.resourceId });
      if (existing) return recordedDispatchResult(parseAutomationLedger(existing));
      const row = await read(table, input.kind === 'cancellation' ? 'id,unit_id,status,cancelled_at' : 'id,unit_id,status,notified_at,notified_server_at', { id: input.resourceId });
      if (!row || row.id !== input.resourceId || row.unit_id !== input.unitId) return notEnqueued('resource_refused');
      let factAt: string;
      if (input.kind === 'cancellation') {
        if (row.status !== 'cancelled' || !instant(row.cancelled_at) || Date.parse(row.cancelled_at) > io.now()) return notEnqueued('resource_refused');
        factAt = row.cancelled_at;
      } else {
        if (row.status !== 'notified' || !instant(row.notified_at) || row.notified_server_at !== row.notified_at
          || Date.parse(row.notified_at) > io.now()) return notEnqueued('resource_refused');
        factAt = row.notified_at;
      }
      const adoption = await read('whatsapp_automation_adoptions', 'adopted_at', { unit_id: input.unitId });
      if (!adoption) return notEnqueued('adoption_required');
      if (!instant(adoption.adopted_at)) return notEnqueued('dependency_unavailable');
      if (Date.parse(factAt) < Date.parse(adoption.adopted_at)) return notEnqueued('producer_before_adoption');
      const jobId = await io.rpc('enqueue_whatsapp_automation', { p_intent: { unit_id: input.unitId, kind: input.kind,
        [key]: input.resourceId, source_event_key: `${input.kind}:${input.resourceId}`, fact_at: factAt,
        expires_at: automationDeadline(input.kind, factAt) } });
      if (jobId === null) return notEnqueued('legacy_already_accepted');
      return uuid(jobId) ? recordedDispatchResult((await loadJob(jobId)).job) : notEnqueued('dependency_unavailable');
    } catch { return notEnqueued('dependency_unavailable'); }
  }
  async function dispatchOperatorIntent(input: OperatorProducerRequest): Promise<DispatchResult> {
    const enqueued = await enqueueOperatorIntent(input);
    return enqueued.jobId === null ? enqueued : dispatchExistingJob(enqueued.jobId);
  }
  async function dispatchScheduledIntent(input: ScheduledProducerRequest): Promise<DispatchResult> {
    const enqueued = await enqueueScheduledIntent(input);
    return enqueued.jobId === null ? enqueued : dispatchExistingJob(enqueued.jobId);
  }
  return { dispatchExistingJob, dispatchScheduledIntent, enqueueScheduledIntent, enqueueOperatorIntent, dispatchOperatorIntent };
}

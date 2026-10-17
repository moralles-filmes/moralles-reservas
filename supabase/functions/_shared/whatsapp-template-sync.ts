import { TEMPLATE_CATALOG, catalogHash, type TemplateDefinition, type TemplateId } from './whatsapp-template-catalog-core.ts';
import { nextTemplateCursor, type RemoteTemplateSnapshot, type TemplateCreateOutcome } from './whatsapp-template-provider-core.ts';
import { submissionPayloadHash } from './whatsapp-template-submission-hash.ts';
import type { ChannelCredentials, WhatsAppProviderAdapter } from './whatsapp-provider-core.ts';
import { deriveTemplateState } from './whatsapp-template-state-core.ts';
import type { TemplateChannel } from './whatsapp-template-account.ts';

export interface TemplateBindingCandidate {
  id: string; unit_id: string; channel_id: string; provider: string; generation: number;
  channel_credential_revision: number; verified_at: string | null; submission_authorized_at: string | null;
  channel: (TemplateChannel & { status: string }) | null;
}

/** GET identity and CREATE authority are independent, even within one account. */
export function selectTemplateBindings(candidates: TemplateBindingCandidate[], bindingId?: string) {
  const current = candidates.filter(b => b.verified_at && b.provider === 'datafy' && b.channel
    && b.channel.id === b.channel_id && b.channel.unit_id === b.unit_id && b.channel.provider === b.provider
    && b.channel.status === 'connected' && b.channel.template_credential_revision === b.channel_credential_revision)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { chosen: current.find(b => !bindingId || b.id === bindingId),
    provisionBindingId: current.find(b => b.submission_authorized_at)?.id ?? null };
}

export interface StoredTemplate {
  id: string; logical_id: string; version: number; name: string; language: string;
  desired_hash: string; requested_category: string; remote_id: string | null;
  remote_status: string; quality: string; submission_attempted_at: string | null;
}
export interface TemplateProvisionJob {
  id: string; target_key: string; state: string; claim_token: string;
  binding_id: string; binding_generation: number; posting_started_at: string | null;
}
export interface TemplateSyncContext {
  accountId: string; wabaId: string; bindingId: string; generation: number;
  unitId: string; channelId: string; credentialRevision: number;
  credentials: ChannelCredentials; catalogEnabled: boolean; submissionAuthorized: boolean;
  provisionBindingId: string | null;
  templates: StoredTemplate[]; jobs: TemplateProvisionJob[];
}
export interface TemplateSyncEpoch {
  account_generation: number; capture_id: string; binding_id: string; binding_generation: number;
  credential_revision: number; templates: { id: string; epoch: number }[];
}
export interface TemplateObservation {
  id: string; remote_id: string | null; name: string; language: string;
  observed_hash: string | null; effective_category: string | null; remote_status: string;
  quality: string | null; rejection_code: string | null;
}
type Transport = Required<Pick<WhatsAppProviderAdapter, 'listTemplates' | 'createTemplate'>>;
export type TemplateOutcome = { outcome: 'accepted' | 'uncertain' | 'rejected' | 'local_preflight_refused'; reason: string; retry_after_seconds?: number };
export interface TemplateSyncDependencies {
  load(accountId: string, bindingId?: string): Promise<TemplateSyncContext>;
  seed(accountId: string, definitions: readonly TemplateDefinition[]): Promise<void>;
  getTransport(context: TemplateSyncContext): Transport;
  begin(accountId: string): Promise<TemplateSyncEpoch>;
  publish(accountId: string, epoch: TemplateSyncEpoch, snapshot: TemplateObservation[]): Promise<boolean>;
  enqueueProvision(bindingId: string, definition: TemplateDefinition): Promise<void>;
  prepare(job: TemplateProvisionJob, payloadHash: string): Promise<boolean>;
  confirm(job: TemplateProvisionJob, payloadHash: string): Promise<boolean>;
  /** Fail-closed SQL fence and allowlist recheck after confirm, just before HTTP. */
  prePostCheck(job: TemplateProvisionJob, payloadHash: string): Promise<boolean>;
  finalCheck(context: TemplateSyncContext): Promise<'final_service_suspended' | 'final_channel_changed' | 'final_gate_paused' | null>;
  finish(jobId: string, fence: string, result: TemplateOutcome): Promise<boolean>;
}
const STATUSES = new Set(['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']);
const RESTRICTED = new Set(['REJECTED', 'DISABLED', 'DELETED', 'PENDING_DELETION', 'PAUSED']);
const activeDefinitions = Object.values(TEMPLATE_CATALOG).filter(d => d.state === 'active' && d.version === 1);

function activeDefinition(t: StoredTemplate): TemplateDefinition | null {
  const definition = TEMPLATE_CATALOG[t.logical_id as TemplateId];
  return definition && definition.state === 'active' && t.version === 1
    && t.name === definition.name && t.language === definition.language ? definition : null;
}

export function templateCreateEvidence(result: TemplateCreateOutcome): TemplateOutcome {
  if (result.state === 'accepted') return { outcome: 'accepted', reason: 'provider_accepted' };
  if (result.state === 'uncertain') return { outcome: 'uncertain', reason: result.error === 'datafy_template_response_invalid' ? 'response_invalid' : 'post_ambiguous' };
  if (result.retryable && result.status === 429) return { outcome: 'rejected', reason: 'documented_preproxy_429',
    ...(result.retryAfterSeconds === undefined ? {} : { retry_after_seconds: result.retryAfterSeconds }) };
  return { outcome: 'rejected', reason: result.errorCode === 'AUTH_ERROR' ? 'auth_rejected' : 'provider_rejected' };
}

export function createTemplateSyncService(deps: TemplateSyncDependencies) {
  async function observe(accountId: string) {
    let context = await deps.load(accountId);
    if (context.catalogEnabled) {
      await deps.seed(accountId, activeDefinitions);
      context = await deps.load(accountId);
    }
    const epoch = await deps.begin(accountId);
    if (epoch.binding_id !== context.bindingId || epoch.binding_generation !== context.generation
      || epoch.credential_revision !== context.credentialRevision) throw new Error('template_binding_changed');
    const transport = deps.getTransport(context);
    const all: RemoteTemplateSnapshot[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    // Bound memory and lease time. Failure leaves the SQL sync_required fence intact.
    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 100) throw new Error('template_page_limit');
      const page = await transport.listTemplates(context.credentials, { wabaId: context.wabaId, ...(after ? { after } : {}) });
      all.push(...page.templates);
      if (all.length > 10_000) throw new Error('template_page_limit');
      if (page.nextCursor === null) break;
      after = nextTemplateCursor(page.nextCursor, seen);
      seen.add(after);
    }
    const snapshot: TemplateObservation[] = [];
    const missing = new Set<string>();
    const compatible = new Set<string>();
    for (const t of context.templates) {
      const matches = all.filter(r => r.name === t.name && r.language === t.language);
      if (matches.length > 1) throw new Error('template_duplicate_identity');
      const remote = matches[0];
      if (!remote) {
        missing.add(t.id);
        snapshot.push({ id: t.id, name: t.name, language: t.language, remote_id: null, observed_hash: null,
          effective_category: null, remote_status: RESTRICTED.has(t.remote_status) ? t.remote_status : 'UNKNOWN', quality: null, rejection_code: null });
        continue;
      }
      const hash = remote.components !== null && remote.parameterFormat !== null
        ? await catalogHash({ name: remote.name, language: remote.language, requestedCategory: remote.category,
          parameterFormat: remote.parameterFormat, components: remote.components }) : null;
      if (hash === t.desired_hash && remote.category === t.requested_category) compatible.add(t.id);
      snapshot.push({ id: t.id, remote_id: remote.remoteId, name: t.name, language: t.language,
        observed_hash: hash, effective_category: ['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(remote.category) ? remote.category : 'UNKNOWN',
        remote_status: STATUSES.has(remote.status) ? remote.status : 'UNKNOWN',
        quality: remote.quality === null ? null : ['GREEN', 'YELLOW', 'RED'].includes(remote.quality) ? remote.quality : 'UNKNOWN',
        rejection_code: remote.rejectionCode });
    }
    const published = await deps.publish(accountId, epoch, snapshot);
    const templateStates = Object.fromEntries(snapshot.map(s => {
      const t = context.templates.find(row => row.id === s.id)!;
      return [s.id, deriveTemplateState({ remoteStatus: s.remote_status,
        hashMatches: s.observed_hash === null ? null : s.observed_hash === t.desired_hash,
        categoryAllowed: s.effective_category === null ? null : s.effective_category === t.requested_category,
        syncRequired: !published, quality: s.quality ?? t.quality, promotional: t.requested_category === 'MARKETING' })];
    }));
    return { context, transport, missing, compatible, published, templateStates };
  }

  async function syncTemplateAccount(accountId: string): Promise<{ state: string; processed: number; reason?: string; templateStates?: Record<string, string> }> {
    let observed: Awaited<ReturnType<typeof observe>>;
    try { observed = await observe(accountId); }
    catch { return { state: 'failed', processed: 0, reason: 'template_get_failed' }; }
    const { context, missing, compatible, published } = observed;
    if (!published) return { state: 'stale', processed: 0, reason: 'template_snapshot_stale' };
    for (const t of context.templates) {
      const jobs = context.jobs.filter(j => j.target_key === t.logical_id);
      if (compatible.has(t.id)) {
        for (const job of jobs.filter(j => j.posting_started_at && ['posting', 'uncertain'].includes(j.state))) {
          await deps.finish(job.id, job.claim_token, { outcome: 'accepted', reason: 'provider_accepted' });
        }
      }
      const definition = activeDefinition(t);
      if (definition && t.desired_hash === await catalogHash(definition)
        && t.requested_category === definition.requestedCategory
        && context.catalogEnabled && context.provisionBindingId && missing.has(t.id)
        && !t.remote_id && !t.submission_attempted_at && !RESTRICTED.has(t.remote_status) && jobs.length === 0) {
        await deps.enqueueProvision(context.provisionBindingId, definition);
      }
    }
    return { state: 'synced', processed: context.templates.length, templateStates: observed.templateStates };
  }

  async function provisionTemplate(accountId: string, job: TemplateProvisionJob): Promise<{ state: string; processed: number }> {
    // A provision job is exactly one unit of bounded worker work. GET always precedes POST.
    if (job.state !== 'claimed' || job.posting_started_at) return { state: 'protected', processed: 0 };
    let postContext: TemplateSyncContext;
    try { postContext = await deps.load(accountId, job.binding_id); }
    catch { return { state: 'stale', processed: 0 }; }
    if (postContext.accountId !== accountId || postContext.bindingId !== job.binding_id || postContext.generation !== job.binding_generation) return { state: 'stale', processed: 0 };
    const postTransport = deps.getTransport(postContext);
    let observed: Awaited<ReturnType<typeof observe>>;
    try { observed = await observe(accountId); } catch { return { state: 'failed', processed: 0 }; }
    const { context, missing, compatible, published } = observed;
    if (!published) return { state: 'stale', processed: 0 };
    const target = context.templates.find(t => t.logical_id === job.target_key && t.version === 1);
    const definition = target && activeDefinition(target);
    if (!target || !definition || target.desired_hash !== await catalogHash(definition)
      || target.requested_category !== definition.requestedCategory
      || !postContext.templates.some(row => row.id === target.id && row.desired_hash === target.desired_hash
        && row.requested_category === target.requested_category)) return { state: 'conflict', processed: 0 };
    const payloadHash = await submissionPayloadHash(definition);
    // SQL handles exact reuse without recording a POST or consuming an attempt.
    // It also persists external mismatch/history as needs_review. A false return
    // alone never proves reuse: a lost fence also returns false.
    if (!await deps.prepare(job, payloadHash)) return { state: !missing.has(target.id) && !compatible.has(target.id) ? 'conflict' : 'paused', processed: 0 };
    let refusal: Awaited<ReturnType<TemplateSyncDependencies['finalCheck']>>;
    try { refusal = await deps.finalCheck(postContext); }
    catch { refusal = 'final_channel_changed'; }
    if (refusal) {
      await deps.finish(job.id, job.claim_token, { outcome: 'local_preflight_refused', reason: refusal });
      return { state: 'paused', processed: 0 };
    }
    let confirmed = false;
    try { confirmed = await deps.confirm(job, payloadHash); } catch { /* Adapter was never invoked. */ }
    if (!confirmed) {
      await deps.finish(job.id, job.claim_token, { outcome: 'local_preflight_refused', reason: 'final_channel_changed' });
      return { state: 'paused', processed: 0 };
    }
    let prePostAllowed = false;
    try { prePostAllowed = await deps.prePostCheck(job, payloadHash); } catch { /* No HTTP if SQL is unavailable. */ }
    if (!prePostAllowed) {
      await deps.finish(job.id, job.claim_token, { outcome: 'local_preflight_refused', reason: 'final_gate_paused' });
      return { state: 'paused', processed: 0 };
    }
    let result: TemplateCreateOutcome;
    // Invoking the adapter is the irreversible boundary, even if it throws synchronously.
    try { result = await postTransport.createTemplate(postContext.credentials, { wabaId: postContext.wabaId, definition }); }
    catch { result = { state: 'uncertain', error: 'template_adapter_failed', errorCode: 'PROVIDER_UNAVAILABLE' }; }
    await deps.finish(job.id, job.claim_token, templateCreateEvidence(result));
    return { state: result.state, processed: 1 };
  }
  return { syncTemplateAccount, provisionTemplate };
}

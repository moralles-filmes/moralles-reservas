import { TEMPLATE_CATALOG, type TemplateId } from './whatsapp-template-catalog-core.ts';
import { PROVIDER_CAPABILITIES, isMetaShapedProvider, type WhatsAppProviderName } from './whatsapp-provider-core.ts';
import { AUTOMATION_PREFLIGHT_REASONS, SCHEDULED_KINDS } from './whatsapp-automation-core.ts';

export type TemplateRole = 'owner' | 'gerente' | 'operador' | null;
export type ConsentPurpose = 'operational' | 'promotional';
type JobAssertion = { job_id: string; expected_channel_id: string; expected_binding_generation: number };
export type TemplateManagementRequest =
  | { action: 'auto_policy_snapshot' }
  | { action: 'set_auto_policy'; enabled: boolean; expected_revision: number }
  | { action: 'onboarding_catalog_snapshot'; unit_id: string }
  | { action: 'snapshot'; unit_id: string }
  | { action: 'sync'; unit_id: string; channel_id: string; expected_binding_generation: number }
  | ({ action: 'initialize_job' } & JobAssertion)
  | ({ action: 'revalidate_job'; target: 'automation' | 'catalog' } & JobAssertion)
  | { action: 'consent_snapshot'; unit_id: string; customer_id: string; purpose: ConsentPurpose }
  | { action: 'record_consent'; unit_id: string; customer_id: string; purpose: ConsentPurpose; decision: 'opt_in' | 'opt_out'; source_code: 'customer_message' | 'signed_form' | 'in_person'; observed_at: string; evidence_reference: string }
  | { action: 'release_channel'; channel_id: string; scope: 'catalog' | 'dispatch'; enabled: boolean; expected_credential_revision: number; expected_binding_generation: number | null }
  | { action: 'authorize_marketing_cost'; channel_id: string; expected_binding_generation: number; category: 'MARKETING'; valid_from: string; valid_until: string }
  | { action: 'configure_promotion_frequency'; window_days: number };
export type TemplateAction = TemplateManagementRequest['action'];
const ADMIN_ACTIONS: readonly TemplateAction[] = ['auto_policy_snapshot', 'set_auto_policy', 'initialize_job', 'release_channel', 'authorize_marketing_cost', 'configure_promotion_frequency'];
export function canManageTemplateAction(role: TemplateRole, action: TemplateAction, admin: boolean): boolean {
  if (!['auto_policy_snapshot', 'set_auto_policy', 'onboarding_catalog_snapshot', 'snapshot', 'sync', 'initialize_job', 'revalidate_job', 'record_consent', 'consent_snapshot', 'release_channel', 'authorize_marketing_cost', 'configure_promotion_frequency'].includes(action)) return false;
  if (admin) return true;
  if (ADMIN_ACTIONS.includes(action)) return false;
  return role === 'owner' || role === 'gerente' || (role === 'operador' && action === 'snapshot');
}
export function canManageTemplateRequest(role: TemplateRole, request: TemplateManagementRequest, admin: boolean): boolean {
  return canManageTemplateAction(role, request.action, admin) && (request.action !== 'revalidate_job' || request.target !== 'catalog' || admin);
}
export const isManagementUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10);
};
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const purpose = (value: unknown): value is ConsentPurpose => value === 'operational' || value === 'promotional';

/** Exact keys make actor/pins/provider and bulk requests impossible to smuggle through. */
export function parseTemplateManagementRequest(input: unknown): TemplateManagementRequest | null {
  if (!record(input)) return null;
  let keys: string[] = []; let valid = false;
  switch (input.action) {
    case 'auto_policy_snapshot': keys = ['action']; valid = true; break;
    case 'set_auto_policy': keys = ['action', 'enabled', 'expected_revision']; valid = typeof input.enabled === 'boolean' && integer(input.expected_revision, 0); break;
    case 'onboarding_catalog_snapshot': keys = ['action', 'unit_id']; valid = isManagementUuid(input.unit_id); break;
    case 'snapshot': keys = ['action', 'unit_id']; valid = isManagementUuid(input.unit_id); break;
    case 'sync': keys = ['action', 'unit_id', 'channel_id', 'expected_binding_generation']; valid = isManagementUuid(input.unit_id) && isManagementUuid(input.channel_id) && integer(input.expected_binding_generation); break;
    case 'initialize_job': case 'revalidate_job':
      keys = ['action', 'job_id', 'expected_channel_id', 'expected_binding_generation'];
      valid = isManagementUuid(input.job_id) && isManagementUuid(input.expected_channel_id) && integer(input.expected_binding_generation);
      if (input.action === 'revalidate_job') { keys.push('target'); valid &&= input.target === 'automation' || input.target === 'catalog'; } break;
    case 'consent_snapshot': case 'record_consent':
      keys = ['action', 'unit_id', 'customer_id', 'purpose']; valid = isManagementUuid(input.unit_id) && isManagementUuid(input.customer_id) && purpose(input.purpose);
      if (input.action === 'record_consent') {
        keys.push('decision', 'source_code', 'observed_at', 'evidence_reference');
        valid &&= (input.decision === 'opt_in' || input.decision === 'opt_out') && typeof input.source_code === 'string' && ['customer_message', 'signed_form', 'in_person'].includes(input.source_code) && date(input.observed_at)
          && typeof input.evidence_reference === 'string' && input.evidence_reference.trim().length > 0 && input.evidence_reference.length <= 512
          && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(input.evidence_reference) && !input.evidence_reference.includes('/preferencias/mensagens/');
      } break;
    case 'release_channel':
      keys = ['action', 'channel_id', 'scope', 'enabled', 'expected_credential_revision', 'expected_binding_generation'];
      valid = isManagementUuid(input.channel_id) && typeof input.scope === 'string' && ['catalog', 'dispatch'].includes(input.scope) && typeof input.enabled === 'boolean' && integer(input.expected_credential_revision, 0)
        && (input.expected_binding_generation === null || integer(input.expected_binding_generation)); break;
    case 'authorize_marketing_cost':
      keys = ['action', 'channel_id', 'expected_binding_generation', 'category', 'valid_from', 'valid_until'];
      valid = isManagementUuid(input.channel_id) && integer(input.expected_binding_generation) && input.category === 'MARKETING' && date(input.valid_from) && date(input.valid_until) && Date.parse(input.valid_until) > Date.parse(input.valid_from); break;
    case 'configure_promotion_frequency': keys = ['action', 'window_days']; valid = integer(input.window_days) && input.window_days <= 30; break;
  }
  return valid && exact(input, keys) ? input as TemplateManagementRequest : null;
}

const unavailable = (): never => { throw new Error('dependency_unavailable'); };
export type IndividualConsentState = { purpose: ConsentPurpose; status: 'unknown'; revision: null } | { purpose: ConsentPurpose; status: 'opt_in' | 'opt_out'; revision: number };
export function decodeConsentState(value: unknown, expectedPurpose: ConsentPurpose): IndividualConsentState {
  if (!record(value) || !exact(value, ['purpose', 'status', 'revision']) || value.purpose !== expectedPurpose) return unavailable();
  if (value.status === 'unknown' && value.revision === null) return { purpose: expectedPurpose, status: 'unknown', revision: null };
  if ((value.status === 'opt_in' || value.status === 'opt_out') && integer(value.revision)) return { purpose: expectedPurpose, status: value.status, revision: value.revision };
  return unavailable();
}
export function decodeSyncResult(value: unknown): { status: 'requested'; requestId: string } | { status: 'unavailable' } {
  if (value === null) return { status: 'unavailable' };
  return isManagementUuid(value) ? { status: 'requested', requestId: value } : unavailable();
}
export function managementPositiveInteger(value: unknown): number { return integer(value) ? value : unavailable(); }

export interface TemplateAutoPolicySnapshot { enabled: boolean; revision: number; catalogDigest: string; updatedAt: string | null }
export function decodeTemplateAutoPolicy(value: unknown): TemplateAutoPolicySnapshot {
  const updatedAt = record(value) ? value.updated_at : undefined;
  if (!record(value) || typeof value.enabled !== 'boolean' || !integer(value.revision, 0)
    || typeof value.catalog_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalog_digest)
    || (updatedAt !== null && !date(updatedAt))) return unavailable();
  return { enabled: value.enabled, revision: value.revision, catalogDigest: value.catalog_digest,
    updatedAt: updatedAt === null ? null : date(updatedAt) ? updatedAt : unavailable() };
}

const SAFE_REASONS: readonly string[] = [...AUTOMATION_PREFLIGHT_REASONS, 'channel_unconfigured', 'binding_unconfigured', 'template_unconfigured', 'render_missing', 'promotion_frequency', 'final_service_suspended', 'final_channel_changed', 'final_consent_changed', 'final_resource_changed', 'final_gate_paused', 'submission_history_protected', 'submission_paused', 'existing_template', 'post_lease_expired', 'post_ambiguous', 'response_invalid', 'documented_preproxy_429', 'provider_rejected', 'auth_rejected', 'template_rejected'];
const safeReason = (value: unknown) => value === null ? null : typeof value === 'string' && SAFE_REASONS.includes(value) ? value : 'unknown_reason';
const logical = (value: unknown): TemplateId | null => typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATE_CATALOG, value) ? value as TemplateId : null;
const checkedDate = (value: unknown): string => date(value) ? value : unavailable();
const checkedUuid = (value: unknown): string => isManagementUuid(value) ? value : unavailable();
const pick = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value) ? value : unavailable();
const PREPARATION_REASONS = ['connection_pending', 'health_stale', 'binding_pending', 'provider_unavailable', 'policy_changed', 'manual_review'] as const;
/** SQL may add internal fields; only a closed, privacy-safe projection reaches browsers. */
export function projectTemplatePreparation(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!record(value)) return unavailable();
  const enrollment = pick(value.enrollment, ['eligible', 'disabled', 'legacy', 'excluded']) as 'eligible' | 'disabled' | 'legacy' | 'excluded';
  const state = value.state === null ? null : pick(value.state, ['pending', 'discovering', 'ready', 'needs_review']) as 'pending' | 'discovering' | 'ready' | 'needs_review';
  const reason = value.reason_code === null ? null : pick(value.reason_code, PREPARATION_REASONS) as typeof PREPARATION_REASONS[number];
  const updatedAt = value.updated_at === null ? null : checkedDate(value.updated_at);
  return { enrollment, state, reason, updatedAt };
}
export interface TemplateSnapshotInput {
  channel: Record<string, unknown> | null;
  binding: Record<string, unknown> | null;
  preparation?: unknown;
  unitAdopted: boolean;
  templates: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  generatedAt: string;
}
export function projectOnboardingCatalogSnapshot(input: TemplateSnapshotInput) {
  const generatedAt = checkedDate(input.generatedAt);
  const templatePreparation = projectTemplatePreparation(input.preparation);
  if (!input.channel) return { channelId: null, templatePreparation, templates: [], generatedAt };
  const snapshot = projectTemplateSnapshot(input);
  if (snapshot.providerLabel !== 'Datafy') return unavailable();
  return { channelId: snapshot.channelId, templatePreparation, templates: snapshot.templates, generatedAt };
}
/** Build DTOs field by field. Raw rows/remote text never cross this boundary. */
export function projectTemplateSnapshot(input: TemplateSnapshotInput) {
  const provider = input.channel ? pick(input.channel.provider, Object.keys(PROVIDER_CAPABILITIES)) as WhatsAppProviderName : null;
  const capabilities = provider ? PROVIDER_CAPABILITIES[provider] : null;
  const labels: Record<WhatsAppProviderName, string> = { datafy: 'Datafy', official: 'Meta', zapi: 'Z-API', waha: 'WAHA', uazapi: 'UazAPI' };
  if (typeof input.unitAdopted !== 'boolean' || (input.binding && !input.channel)) return unavailable();
  const bindingGeneration = input.binding ? managementPositiveInteger(input.binding.generation) : null;
  const credentialRevision = input.channel ? integer(input.channel.template_credential_revision, 0) ? input.channel.template_credential_revision : unavailable() : null;
  if (input.binding && ((input.binding.submission_authorized_at === null) !== (input.binding.submission_authorized_by === null)
    || typeof input.binding.dispatch_enabled !== 'boolean')) return unavailable();
  const catalogAuthorized = input.binding ? input.binding.submission_authorized_at !== null : false;
  if (catalogAuthorized && (!date(input.binding!.submission_authorized_at) || !isManagementUuid(input.binding!.submission_authorized_by))) return unavailable();
  return {
    mode: provider === null ? 'unavailable' as const : isMetaShapedProvider(provider) ? 'official' as const : 'unofficial' as const,
    channelId: input.channel ? checkedUuid(input.channel.id) : null,
    providerLabel: provider ? labels[provider] : null,
    capabilities: { templateMessages: capabilities?.templateMessages === true, templateManagement: capabilities?.templateManagement === true },
    configuration: { bindingGeneration, credentialRevision, catalogAuthorized, dispatchEnabled: input.binding?.dispatch_enabled === true, adopted: input.unitAdopted },
    templatePreparation: projectTemplatePreparation(input.preparation),
    templates: Object.values(TEMPLATE_CATALOG).map(definition => {
      const row = input.templates.find(t => t.logical_id === definition.id && t.version === 1);
      return { logicalId: definition.id, version: 1, name: definition.name, body: definition.body, footer: definition.footer,
        requestedCategory: definition.requestedCategory,
        effectiveCategory: row?.effective_category == null ? null : pick(row.effective_category, ['UTILITY', 'MARKETING', 'AUTHENTICATION', 'UNKNOWN']),
        remoteStatus: row ? pick(row.remote_status, ['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']) : 'UNKNOWN',
        localStatus: row ? pick(row.local_status, ['awaiting_connection', 'queued', 'submitting', 'pending', 'usable', 'rejected', 'paused', 'disabled', 'conflict', 'sync_error', 'unsupported']) : 'awaiting_connection',
        quality: row ? pick(row.quality, ['UNKNOWN', 'GREEN', 'YELLOW', 'RED']) : 'UNKNOWN',
        hashMatches: !!row && typeof row.desired_hash === 'string' && row.observed_hash === row.desired_hash,
        syncRequired: !row || row.sync_required !== false,
        lastSyncedAt: row?.last_synced_at == null ? null : checkedDate(row.last_synced_at) };
    }),
    blockedJobs: input.jobs.map(row => {
      const target = pick(row.target, ['automation', 'catalog']);
      const common = { jobId: checkedUuid(row.id), target,
        logicalId: logical(target === 'catalog' ? row.target_key : row.initial_catalog_key),
        state: pick(row.state, target === 'automation' ? ['queued', 'claimed', 'posting', 'accepted', 'blocked', 'expired', 'uncertain', 'retry_wait', 'needs_review', 'failed', 'reconciled', 'paused', 'rejected'] : ['queued', 'claimed', 'posting', 'accepted', 'rejected', 'uncertain', 'failed', 'done', 'paused', 'needs_review']),
        reason: safeReason(row.error_code), attempts: integer(row.attempts, 0) && row.attempts <= 5 ? row.attempts : unavailable() };
      if (target === 'catalog') return { ...common, pinPhase: null, channelId: row.channel_id === null ? null : checkedUuid(row.channel_id), createdAt: checkedDate(row.created_at), dueAt: checkedDate(row.due_at) };
      return { ...common, kind: pick(row.kind, SCHEDULED_KINDS), pinPhase: pick(row.pin_phase, ['bound', 'preconfiguration']), channelId: row.channel_id === null ? null : checkedUuid(row.channel_id), factAt: checkedDate(row.fact_at), deadline: checkedDate(row.expires_at) };
    }), generatedAt: checkedDate(input.generatedAt),
  };
}

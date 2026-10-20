import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { canonicalBrPhone, isValidBrPhone } from '@/lib/phone';
import { templateCatalogSelectionSchema, templatePreparationSchema } from '@/features/whatsapp/template-preparation';
import { TEMPLATE_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-core';
import { TEMPLATE_V2_CATALOG } from '../../supabase/functions/_shared/whatsapp-template-catalog-v2';
import { AUTOMATION_PREFLIGHT_REASONS, SCHEDULED_KINDS } from '../../supabase/functions/_shared/whatsapp-automation-core';
import {
  canManageTemplateAction, canManageTemplateRequest, decodeConsentState, parseTemplateManagementRequest,
  type ConsentPurpose, type TemplateManagementRequest, type TemplateRole
} from '../../supabase/functions/_shared/whatsapp-template-access-core';

const uuid = z.uuid();
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const date = z.iso.datetime({ offset: true });
const knownCatalog = { ...TEMPLATE_CATALOG, ...TEMPLATE_V2_CATALOG };
type KnownTemplateId = keyof typeof knownCatalog;
const logicalId = z.enum(Object.keys(knownCatalog) as [KnownTemplateId, ...KnownTemplateId[]]);
export const templateSchema = z.object({
  logicalId, version: z.union([z.literal(1), z.literal(2)]), name: z.string(), body: z.string(), footer: z.string().nullable(),
  requestedCategory: z.enum(['UTILITY', 'MARKETING']),
  effectiveCategory: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'UNKNOWN']).nullable(),
  remoteStatus: z.enum(['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']),
  localStatus: z.enum(['awaiting_connection', 'queued', 'submitting', 'pending', 'usable', 'rejected', 'paused', 'disabled', 'conflict', 'sync_error', 'unsupported']),
  quality: z.enum(['UNKNOWN', 'GREEN', 'YELLOW', 'RED']), hashMatches: z.boolean(), syncRequired: z.boolean(), lastSyncedAt: date.nullable(),
}).strict().refine(t => {
  const original = knownCatalog[t.logicalId];
  return t.version === original.version && t.name === original.name && t.body === original.body
    && t.footer === original.footer && t.requestedCategory === original.requestedCategory;
});
// Older bundles may return any known subset. Each historical version has its own remote status.
export const templateCatalogSchema = z.array(templateSchema).max(18)
  .refine(templates => new Set(templates.map(template => `${template.logicalId}:${template.version}`)).size === templates.length);
const safeReasons = new Set<string>([...AUTOMATION_PREFLIGHT_REASONS, 'channel_unconfigured', 'binding_unconfigured', 'template_unconfigured', 'render_missing', 'promotion_frequency', 'final_service_suspended', 'final_channel_changed', 'final_consent_changed', 'final_resource_changed', 'final_gate_paused', 'submission_history_protected', 'submission_paused', 'existing_template', 'post_lease_expired', 'post_ambiguous', 'response_invalid', 'documented_preproxy_429', 'provider_rejected', 'auth_rejected', 'template_rejected', 'unknown_reason']);
const commonJob = { jobId: uuid, logicalId: logicalId.nullable(), reason: z.string().refine(s => safeReasons.has(s)).nullable(), attempts: z.number().int().min(0).max(5), channelId: uuid.nullable() };
const jobSchema = z.discriminatedUnion('target', [
  z.object({ ...commonJob, target: z.literal('automation'), state: z.enum(['queued', 'claimed', 'posting', 'accepted', 'blocked', 'expired', 'uncertain', 'retry_wait', 'needs_review', 'failed', 'reconciled', 'paused', 'rejected']), pinPhase: z.enum(['bound', 'preconfiguration']), kind: z.enum(SCHEDULED_KINDS), factAt: date, deadline: date }).strict(),
  z.object({ ...commonJob, target: z.literal('catalog'), state: z.enum(['queued', 'claimed', 'posting', 'accepted', 'rejected', 'uncertain', 'failed', 'done', 'paused', 'needs_review']), pinPhase: z.null(), createdAt: date, dueAt: date }).strict(),
]);
const snapshotSchema = z.object({
  mode: z.enum(['official', 'unofficial', 'unavailable']), channelId: uuid.nullable(), providerLabel: z.enum(['Datafy', 'Meta', 'Z-API', 'WAHA', 'UazAPI']).nullable(),
  capabilities: z.object({ templateMessages: z.boolean(), templateManagement: z.boolean() }).strict(),
  configuration: z.object({ bindingGeneration: positive.nullable(), credentialRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), catalogAuthorized: z.boolean(), dispatchEnabled: z.boolean(), adopted: z.boolean() }).strict(),
  templatePreparation: templatePreparationSchema.nullable().optional(),
  catalogSelection: templateCatalogSelectionSchema.nullable().optional(),
  templates: templateCatalogSchema, blockedJobs: z.array(jobSchema), generatedAt: date,
}).strict().refine(s => {
  const absent = s.mode === 'unavailable';
  if (absent !== (s.channelId === null) || absent !== (s.providerLabel === null) || absent !== (s.configuration.credentialRevision === null)) return false;
  if (s.configuration.bindingGeneration === null && (s.configuration.catalogAuthorized || s.configuration.dispatchEnabled)) return false;
  if (absent && s.configuration.bindingGeneration !== null) return false;
  if (absent && s.catalogSelection != null) return false;
  if (s.mode === 'official' && !['Datafy', 'Meta'].includes(s.providerLabel)) return false;
  if (s.mode === 'unofficial' && !['Z-API', 'WAHA', 'UazAPI'].includes(s.providerLabel)) return false;
  return true;
});
export type TemplateSnapshot = z.infer<typeof snapshotSchema>;
export type OfficialTemplateView = z.infer<typeof templateSchema>;
export type BlockedTemplateJob = TemplateSnapshot['blockedJobs'][number];
export type { ConsentPurpose };

const errors = {
  unauthorized: 'Sua sessão expirou. Entre novamente.', forbidden: 'Você não tem acesso a esta ação.',
  configuration_changed: 'A configuração mudou. Atualize os dados e tente novamente.',
  not_eligible: 'Esta ação não está disponível para a configuração atual. Atualize os dados.',
  invalid_request: 'Confira os dados informados e tente novamente.',
  dependency_unavailable: 'Não foi possível consultar o serviço. Tente novamente.',
} as const;
export function templateErrorMessage(error: unknown): string {
  return error instanceof Error && Object.prototype.hasOwnProperty.call(errors, error.message) ? errors[error.message as keyof typeof errors] : errors.dependency_unavailable;
}
function closedError(code: unknown = 'dependency_unavailable') {
  return new Error(typeof code === 'string' && Object.prototype.hasOwnProperty.call(errors, code) ? code : 'dependency_unavailable');
}
export async function requestManagement(request: TemplateManagementRequest): Promise<unknown> {
  if (!parseTemplateManagementRequest(request)) throw closedError('invalid_request');
  try {
    const { data, error } = await supabase.functions.invoke('manage-whatsapp-templates', { body: request });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        let body: unknown;
        try { body = await error.context.json(); } catch { throw closedError(); }
        throw closedError(body && typeof body === 'object' && 'error' in body ? body.error : undefined);
      }
      throw closedError();
    }
    return data;
  } catch (error) { throw closedError(error instanceof Error ? error.message : undefined); }
}
export async function fetchAuthorizedTemplateSnapshot(unitId: string): Promise<TemplateSnapshot> {
  const parsed = snapshotSchema.safeParse(await requestManagement({ action: 'snapshot_v2', unit_id: unitId }));
  if (!parsed.success) throw closedError();
  return parsed.data;
}

// Presentation filter only: SQL proves the resource, identity, TTL and zero-POST history.
const correctionReasons = new Set(['reservation_pending', 'payment_incompatible', 'reservation_not_confirmed', 'reservation_changed', 'reservation_past', 'reservation_wrong_day', 'survey_already_answered', 'waitlist_not_waiting', 'waitlist_not_seated', 'waitlist_wrong_day', 'waitlist_changed', 'voucher_not_active', 'voucher_expired', 'voucher_changed', 'recipient_changed', 'do_not_contact', 'invalid_timezone', 'service_suspended', 'channel_unavailable', 'channel_changed', 'binding_changed', 'consent_changed', 'cost_not_authorized', 'template_unavailable', 'template_sync_failed', 'render_invalid', 'render_missing', 'promotion_frequency', 'dependency_unavailable', 'final_service_suspended', 'final_channel_changed', 'final_consent_changed', 'final_resource_changed', 'final_gate_paused']);
export function canRequestJobCorrection(job: BlockedTemplateJob, snapshot: TemplateSnapshot) {
  return job.target === 'automation' && job.pinPhase === 'bound' && ['blocked', 'needs_review'].includes(job.state)
    && correctionReasons.has(job.reason) && !!snapshot.channelId && !!snapshot.configuration.bindingGeneration
    && Date.parse(job.deadline) > Date.now();
}
export type CatalogReleasePin = {
  channelId: string; bindingGeneration: number; credentialRevision: number;
  catalogAuthorized: boolean; enabled: boolean;
};
export function catalogReleaseMatches(snapshot: TemplateSnapshot | undefined, pin: CatalogReleasePin): boolean {
  return snapshot?.providerLabel === 'Datafy' && snapshot.channelId === pin.channelId
    && snapshot.configuration.bindingGeneration === pin.bindingGeneration
    && snapshot.configuration.credentialRevision === pin.credentialRevision
    && snapshot.configuration.catalogAuthorized === pin.catalogAuthorized
    && (!pin.enabled || !snapshot.catalogSelection || snapshot.catalogSelection.state === 'v1')
    && pin.enabled !== pin.catalogAuthorized;
}
export type DispatchReleasePin = {
  channelId: string; bindingGeneration: number; credentialRevision: number;
  dispatchEnabled: boolean; adopted: boolean; enabled: boolean;
};
export function dispatchReleaseMatches(snapshot: TemplateSnapshot | undefined, pin: DispatchReleasePin): boolean {
  return !!snapshot && snapshot.channelId === pin.channelId
    && snapshot.configuration.bindingGeneration === pin.bindingGeneration
    && snapshot.configuration.credentialRevision === pin.credentialRevision
    && snapshot.configuration.dispatchEnabled === pin.dispatchEnabled
    && snapshot.configuration.adopted === pin.adopted && pin.enabled !== pin.dispatchEnabled
    // Pausing an existing grant must remain available if provider capabilities change.
    && (!pin.enabled || (snapshot.mode === 'official' && snapshot.providerLabel === 'Datafy'
      && snapshot.capabilities.templateMessages));
}
type DispatchAttempt = { pin: DispatchReleasePin; readCount: number; readQuery: object; settled: boolean };
// An unknown mutation result stays fenced across card remounts in this query-client session.
const dispatchAttemptsByClient = new WeakMap<object, Map<string, DispatchAttempt>>();
function dispatchAttempts(client: object) {
  let attempts = dispatchAttemptsByClient.get(client);
  if (!attempts) { attempts = new Map(); dispatchAttemptsByClient.set(client, attempts); }
  return attempts;
}
const dispatchIdentity = (unitId: string, pin: Pick<DispatchReleasePin, 'channelId' | 'bindingGeneration' | 'credentialRevision'>) => `${unitId}:${pin.channelId}:${pin.bindingGeneration}:${pin.credentialRevision}`;
export function useWhatsappTemplates(unitId: string, role: TemplateRole = null, isPlatformAdmin = false) {
  const client = useQueryClient();
  const key = ['whatsapp-templates', unitId] as const;
  const query = useQuery({
    queryKey: key, queryFn: () => fetchAuthorizedTemplateSnapshot(unitId), enabled: !!unitId,
    retry: false, refetchOnWindowFocus: false,
    refetchInterval: () => document.hidden ? false : 30_000,
  });
  const permitted = canManageTemplateRequest(role, { action: 'snapshot_v2', unit_id: unitId }, isPlatformAdmin) && (isPlatformAdmin || role === 'owner' || role === 'gerente');
  const canAdministerCatalog = isPlatformAdmin && canManageTemplateAction(role, 'release_channel', isPlatformAdmin);
  const canAdministerDispatch = isPlatformAdmin && canManageTemplateAction(role, 'release_channel', isPlatformAdmin);
  const [dispatchAttemptMap] = useState(() => dispatchAttempts(client));
  const [, setDispatchAttemptRevision] = useState(0);
  const currentDispatchAttemptKey = query.data?.channelId && query.data.configuration.bindingGeneration !== null
    && query.data.configuration.credentialRevision !== null
    ? dispatchIdentity(unitId, { channelId: query.data.channelId, bindingGeneration: query.data.configuration.bindingGeneration,
      credentialRevision: query.data.configuration.credentialRevision }) : null;
  useEffect(() => {
    const attempt = currentDispatchAttemptKey && dispatchAttemptMap.get(currentDispatchAttemptKey);
    const state = client.getQueryState<TemplateSnapshot>(['whatsapp-templates', unitId]);
    const sameReadQuery = client.getQueryCache().find({ queryKey: ['whatsapp-templates', unitId], exact: true }) === attempt?.readQuery;
    if (!attempt || !attempt.settled || query.isError || query.isFetching || !state
      || (sameReadQuery ? state.dataUpdateCount <= attempt.readCount : state.dataUpdateCount < 1) || !query.data) return;
    if (query.data.configuration.dispatchEnabled === attempt.pin.enabled
      && query.data.configuration.adopted === (attempt.pin.adopted || attempt.pin.enabled)) {
      dispatchAttemptMap.delete(currentDispatchAttemptKey);
      setDispatchAttemptRevision(revision => revision + 1);
    }
  }, [client, currentDispatchAttemptKey, dispatchAttemptMap, query.data, query.dataUpdatedAt, query.isError, query.isFetching, unitId]);
  const releaseDispatch = useMutation({
    retry: false,
    mutationFn: async (pin: DispatchReleasePin) => {
      const identity = dispatchIdentity(unitId, pin);
      if (!canAdministerDispatch || query.isError || query.isFetching || !dispatchReleaseMatches(query.data, pin)
        || !uuid.safeParse(pin.channelId).success || !positive.safeParse(pin.bindingGeneration).success
        || !z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).safeParse(pin.credentialRevision).success
        || dispatchAttemptMap.has(identity)) throw closedError('configuration_changed');
      dispatchAttemptMap.set(identity, { pin: { ...pin }, readCount: client.getQueryState(key)?.dataUpdateCount ?? 0,
        readQuery: client.getQueryCache().find({ queryKey: key, exact: true }), settled: false });
      setDispatchAttemptRevision(revision => revision + 1);
      const data = await requestManagement({
        action: 'release_channel', channel_id: pin.channelId, scope: 'dispatch', enabled: pin.enabled,
        expected_credential_revision: pin.credentialRevision,
        expected_binding_generation: pin.bindingGeneration,
      });
      if (!z.object({ status: z.literal('updated') }).strict().safeParse(data).success) throw closedError();
    },
    onSettled: (_data, _error, pin) => {
      const attempt = dispatchAttemptMap.get(dispatchIdentity(unitId, pin));
      if (attempt) attempt.settled = true;
      return client.invalidateQueries({ queryKey: key, exact: true });
    },
  });
  const releaseCatalog = useMutation({
    mutationFn: async (pin: CatalogReleasePin) => {
      const snapshot = query.data;
      if (!canAdministerCatalog || query.isError || query.isFetching || snapshot?.providerLabel !== 'Datafy'
        || !catalogReleaseMatches(snapshot, pin)) throw closedError('configuration_changed');
      const data = await requestManagement({
        action: 'release_channel', channel_id: pin.channelId, scope: 'catalog', enabled: pin.enabled,
        expected_credential_revision: pin.credentialRevision,
        expected_binding_generation: pin.bindingGeneration,
      });
      if (!z.object({ status: z.literal('updated') }).strict().safeParse(data).success) throw closedError();
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
  const sync = useMutation({
    mutationFn: async () => {
      const snapshot = query.data;
      if (!permitted || query.isError || query.isFetching || !snapshot?.channelId || !snapshot.configuration.bindingGeneration) throw closedError('not_eligible');
      const data = await requestManagement({ action: 'sync', unit_id: unitId, channel_id: snapshot.channelId, expected_binding_generation: snapshot.configuration.bindingGeneration });
      const parsed = z.union([z.object({ status: z.literal('requested'), requestId: uuid }).strict(), z.object({ status: z.literal('unavailable') }).strict()]).safeParse(data);
      if (!parsed.success) throw closedError();
      return parsed.data;
    }, onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
  const correction = useMutation({
    mutationFn: async (jobId: string) => {
      const snapshot = query.data; const job = snapshot?.blockedJobs.find(j => j.jobId === jobId);
      if (!permitted || query.isError || query.isFetching || !job || !canRequestJobCorrection(job, snapshot)) throw closedError('not_eligible');
      const data = await requestManagement({ action: 'revalidate_job', target: 'automation', job_id: job.jobId, expected_channel_id: snapshot.channelId, expected_binding_generation: snapshot.configuration.bindingGeneration });
      if (!z.object({ status: z.literal('updated') }).strict().safeParse(data).success) throw closedError();
    }, onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
  return { unitId, query, sync, correction, releaseCatalog, releaseDispatch, canManage: permitted, canAdministerCatalog,
    canAdministerDispatch, wasDispatchAttempted: (pin: DispatchReleasePin) => dispatchAttemptMap.has(dispatchIdentity(unitId, pin)) };
}
export type TemplateControls = ReturnType<typeof useWhatsappTemplates>;

export type ExistingConsentContact = { id: string; name: string; phone: string };
export function useConsentContactLookup(unitId: string, organizationId: string, lookup: { nonce: string; phone: string } | null, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp-contact-lookup', unitId, organizationId, lookup?.nonce], enabled: enabled && !!unitId && !!organizationId && !!lookup, retry: false, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<ExistingConsentContact | null> => {
      const phone = canonicalBrPhone(lookup.phone);
      if (!isValidBrPhone(phone)) throw closedError('invalid_request');
      try {
        const { data, error } = await supabase.from('customers').select('id,name,phone').eq('organization_id', organizationId).eq('phone', phone).is('deleted_at', null).limit(2).abortSignal(signal);
        if (error || !Array.isArray(data) || data.length > 1) throw closedError();
        if (!data.length) return null;
        const parsed = z.object({ id: uuid, name: z.string(), phone: z.literal(phone) }).strict().safeParse(data[0]);
        if (!parsed.success) throw closedError();
        return parsed.data;
      } catch { throw closedError(); }
    },
  });
}
export function useIndividualConsent(unitId: string, customerId: string, purpose: ConsentPurpose, enabled: boolean) {
  const client = useQueryClient(); const key = ['whatsapp-consent', unitId, customerId, purpose] as const;
  const query = useQuery({
    queryKey: key, enabled: enabled && !!unitId && !!customerId, retry: false, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async () => decodeConsentState(await requestManagement({ action: 'consent_snapshot', unit_id: unitId, customer_id: customerId, purpose }), purpose),
  });
  type Evidence = Pick<Extract<TemplateManagementRequest, { action: 'record_consent' }>, 'decision' | 'source_code' | 'observed_at' | 'evidence_reference'>;
  const record = useMutation({
    gcTime: 0, mutationFn: async (evidence: Evidence) => {
      if (!enabled || !customerId) throw closedError('forbidden');
      const data = await requestManagement({ action: 'record_consent', unit_id: unitId, customer_id: customerId, purpose, ...evidence });
      if (!z.object({ revision: positive, purpose: z.literal(purpose), decision: z.literal(evidence.decision) }).strict().safeParse(data).success) throw closedError();
    }, onSuccess: async () => { await client.invalidateQueries({ queryKey: key, exact: true }); },
  });
  return { query, record };
}

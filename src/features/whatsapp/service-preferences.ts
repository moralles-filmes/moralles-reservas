import { z } from 'zod';
import { dispatchKindLabels, dispatchV2Variants, dispatchVersionReasons } from './template-dispatch-versions';
import type { ScheduledKind } from '../../../supabase/functions/_shared/whatsapp-automation-core';

export const SERVICE_KINDS = [
  'confirmation', 'reminder_d1', 'survey_d1', 'waitlist_entered', 'cancellation', 'waitlist_table_ready',
] as const satisfies readonly ScheduledKind[];
export type ServiceKind = typeof SERVICE_KINDS[number];

const uuid = z.uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const variant = z.object({
  logical_id: z.string(),
  status: z.enum(['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']),
  ready: z.boolean(),
}).strict();

const entry = z.object({
  kind: z.enum(SERVICE_KINDS), enabled: z.boolean(), revision,
  enabled_at: z.iso.datetime({ offset: true }).nullable(), ready: z.boolean(),
  reason_code: z.enum(dispatchVersionReasons), variants: z.array(variant).max(2),
}).strict().refine(value => {
  const expected = dispatchV2Variants[value.kind];
  return (value.variants.length === 0 || value.variants.length === expected.length)
    && value.variants.every(item => expected.includes(item.logical_id))
    && new Set(value.variants.map(item => item.logical_id)).size === value.variants.length
    && (value.enabled === (value.enabled_at !== null))
    && (value.ready === (value.reason_code === 'ready'))
    && (!value.ready || value.variants.every(item => item.ready && item.status === 'APPROVED'));
});

export const servicePreferencesSchema = z.object({
  auto_cohort: z.boolean(), eligible: z.boolean(), rollout_ready: z.boolean(),
  global_dispatch_enabled: z.boolean(), admin_paused: z.boolean(),
  can_manage: z.boolean(), unit_id: uuid,
  channel_id: uuid.nullable(), binding_id: uuid.nullable(),
  binding_generation: revision.nullable(), credential_revision: revision.nullable(),
  provider_subscription_confirmed: z.boolean(),
  kinds: z.array(entry).length(SERVICE_KINDS.length),
}).strict().refine(value => {
  const present = value.channel_id !== null && value.binding_id !== null
    && value.binding_generation !== null && value.credential_revision !== null;
  return new Set(value.kinds.map(item => item.kind)).size === SERVICE_KINDS.length
    && ((value.binding_id === null && value.binding_generation === null
      && (value.channel_id === null) === (value.credential_revision === null)) || present)
    && (!value.eligible || value.auto_cohort && present && value.binding_generation! >= 1)
    && value.kinds.every(item => present
      ? item.variants.length === dispatchV2Variants[item.kind].length
      : item.variants.length === 0 && item.reason_code === 'binding_changed' && !item.ready);
});

export const servicePreferenceResultSchema = z.object({
  kind: z.enum(SERVICE_KINDS), enabled: z.boolean(), revision: revision.min(1),
  enabled_at: z.iso.datetime({ offset: true }).nullable(),
}).strict().refine(value => value.enabled === (value.enabled_at !== null));

export type ServicePreferencesSnapshot = z.infer<typeof servicePreferencesSchema>;
export type ServicePreferenceEntry = ServicePreferencesSnapshot['kinds'][number];
export type ServicePreferencePin = {
  unitId: string; channelId: string; bindingId: string; generation: number; credentialRevision: number;
  kind: ServiceKind; enabled: boolean; revision: number; nextEnabled: boolean;
};

export function servicePreferenceMatches(snapshot: ServicePreferencesSnapshot | undefined, pin: ServicePreferencePin): boolean {
  const current = snapshot?.kinds.find(item => item.kind === pin.kind);
  return !!snapshot && !!current
    && snapshot.unit_id === pin.unitId && snapshot.channel_id === pin.channelId
    && snapshot.binding_id === pin.bindingId && snapshot.binding_generation === pin.generation
    && snapshot.credential_revision === pin.credentialRevision
    && current.revision === pin.revision && current.enabled === pin.enabled
    && current.enabled !== pin.nextEnabled
    && (pin.nextEnabled
      ? snapshot.eligible && snapshot.rollout_ready && snapshot.global_dispatch_enabled && !snapshot.admin_paused
        && snapshot.provider_subscription_confirmed && current.ready
      : current.enabled);
}

export const serviceKindLabels: Record<ServiceKind, string> = Object.fromEntries(
  SERVICE_KINDS.map(kind => [kind, dispatchKindLabels[kind]]),
) as Record<ServiceKind, string>;

export function serviceStatus(entry: ServicePreferenceEntry, state: {
  rolloutReady: boolean; eligible: boolean; providerSubscriptionConfirmed: boolean;
  globalDispatchEnabled: boolean; adminPaused: boolean;
}): string {
  const { rolloutReady, eligible, providerSubscriptionConfirmed, globalDispatchEnabled, adminPaused } = state;
  if (!globalDispatchEnabled) return entry.enabled ? 'Envio pausado pela plataforma' : 'Desligado; envio pausado pela plataforma';
  if (adminPaused) return entry.enabled ? 'Pausado pela plataforma' : 'Desligado; canal pausado pela plataforma';
  if (!rolloutReady) return entry.enabled ? 'Envio pausado; você pode desligar' : 'Configuração temporariamente indisponível';
  if (!eligible) return entry.enabled ? 'Ativo, envio pausado para revisão' : 'Aguardando preparação dos modelos';
  if (entry.enabled && !providerSubscriptionConfirmed) return 'Ativo, envio pausado: assinatura Datafy indisponível';
  if (entry.enabled) return entry.ready ? 'Ativo para novos avisos' : 'Ativo, envio pausado para revisão';
  if (entry.reason_code === 'meta_pending') return 'Aguardando aprovação da Meta';
  if (entry.reason_code === 'meta_rejected') return 'Recusado pela Meta';
  if (entry.reason_code === 'sync_stale') return 'Aprovação ainda precisa de atualização';
  if (entry.ready) return 'Pronto para ativar';
  return 'Revisão necessária';
}

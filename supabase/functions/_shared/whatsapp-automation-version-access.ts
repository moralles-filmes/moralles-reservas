import { SCHEDULED_KINDS, type ScheduledKind } from './whatsapp-automation-core.ts';
import { isManagementUuid } from './whatsapp-template-access-core.ts';

export const VERSION_READY_REASONS = ['ready', 'meta_pending', 'meta_rejected', 'catalog_drift', 'channel_unavailable',
  'grant_unavailable', 'policy_paused', 'binding_changed', 'sync_stale', 'quality_blocked', 'cost_not_authorized', 'dependency_unavailable'] as const;
export const DISPATCH_STATUS_REASONS = [...VERSION_READY_REASONS, 'dispatch_paused'] as const;
export const DISPATCH_READINESS = ['awaiting_channel', 'pending_meta', 'rejected', 'awaiting_dispatch', 'ready', 'review'] as const;
export const VERSION_REMOTE_STATES = ['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED'] as const;
const variants: Record<ScheduledKind, readonly string[]> = {
  confirmation: ['res_confirmacao_v2', 'res_confirmacao_desconto_v2'], reminder_d1: ['res_lembrete_dia_v2'],
  survey_d1: ['res_pesquisa_reserva_v2'], cancellation: ['res_cancelada_v2'], waitlist_entered: ['fila_entrada_v2'],
  waitlist_feedback: ['fila_feedback_v2'], waitlist_table_ready: ['fila_mesa_pronta_v2'], voucher_issued: ['mkt_voucher_programado_v2'],
};
type VersionSource = 'legacy' | 'admin' | 'auto';
export type AutomationVersionEntry = {
  kind: ScheduledKind; selected_version: 1 | 2 | null; selection_source: VersionSource | null; revision: number;
  v2_ready: boolean; v2_reason_code: typeof VERSION_READY_REASONS[number];
  variants: { logical_id: string; status: typeof VERSION_REMOTE_STATES[number]; ready: boolean }[];
};
export type AutomationVersionSnapshot = {
  binding_id: string; channel_id: string; generation: number; credential_revision: number; entries: AutomationVersionEntry[];
};
export type AutomationDispatchStatus = { channel_id: string | null; generation: number | null; credential_revision: number | null;
  entries: { kind: ScheduledKind; template_version: 1 | 2 | null; logical_id: string | null;
  readiness: typeof DISPATCH_READINESS[number]; reason_code: typeof DISPATCH_STATUS_REASONS[number] }[] };
const row = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k));
const integer = (value: unknown, minimum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const unavailable = (): never => { throw new Error('dependency_unavailable'); };
export function decodeAutomationVersionSnapshot(value: unknown, bindingId: string, channelId: string): AutomationVersionSnapshot {
  if (!row(value) || !exact(value, ['binding_id', 'channel_id', 'generation', 'credential_revision', 'entries'])
    || value.binding_id !== bindingId || value.channel_id !== channelId || !isManagementUuid(value.binding_id)
    || !isManagementUuid(value.channel_id) || !integer(value.generation, 1) || !integer(value.credential_revision, 0)
    || !Array.isArray(value.entries) || value.entries.length !== SCHEDULED_KINDS.length) return unavailable();
  const kinds = new Set<string>();
  for (const entry of value.entries) {
    if (!row(entry) || !exact(entry, ['kind', 'selected_version', 'selection_source', 'revision', 'v2_ready', 'v2_reason_code', 'variants'])
      || typeof entry.kind !== 'string' || !SCHEDULED_KINDS.includes(entry.kind as ScheduledKind) || kinds.has(entry.kind)
      || !integer(entry.revision, 0) || typeof entry.v2_ready !== 'boolean'
      || !VERSION_READY_REASONS.includes(entry.v2_reason_code as typeof VERSION_READY_REASONS[number])) return unavailable();
    kinds.add(entry.kind);
    if (!(entry.selected_version === null && entry.selection_source === null)
      && !(entry.selected_version === 1 && entry.selection_source === 'legacy')
      && !([1, 2].includes(entry.selected_version as number) && entry.selection_source === 'admin')
      && !(entry.selected_version === 2 && entry.selection_source === 'auto')) return unavailable();
    const expected = variants[entry.kind as ScheduledKind];
    if (!Array.isArray(entry.variants) || entry.variants.length !== expected.length) return unavailable();
    const seen = new Set<string>();
    for (const variant of entry.variants) {
      if (!row(variant) || !exact(variant, ['logical_id', 'status', 'ready']) || typeof variant.logical_id !== 'string'
        || !expected.includes(variant.logical_id) || seen.has(variant.logical_id)
        || !VERSION_REMOTE_STATES.includes(variant.status as typeof VERSION_REMOTE_STATES[number]) || typeof variant.ready !== 'boolean'
        || (variant.ready && variant.status !== 'APPROVED')) return unavailable();
      seen.add(variant.logical_id);
    }
    if (entry.v2_ready !== (entry.v2_reason_code === 'ready')
      || (entry.v2_ready && !entry.variants.every(variant => variant.ready === true))) return unavailable();
  }
  return value as unknown as AutomationVersionSnapshot;
}
export function decodeAutomationVersionSelection(value: unknown, requestedVersion: 1 | 2, expectedRevision: number) {
  if (!row(value) || !exact(value, ['state', 'version', 'revision']) || !integer(value.revision, 0)
    || typeof value.state !== 'string' || !['selected', 'stale', 'not_ready', 'refused'].includes(value.state)) return unavailable();
  if (value.state === 'selected') {
    if (value.version !== requestedVersion || value.revision <= expectedRevision) return unavailable();
  } else if (!((value.version === null && value.revision === 0) || ([1, 2].includes(value.version as number) && value.revision >= 1))) return unavailable();
  return value as unknown as { state: 'selected' | 'stale' | 'not_ready' | 'refused'; version: 1 | 2 | null; revision: number };
}
export function awaitingDispatchChannel(): AutomationDispatchStatus {
  return { channel_id: null, generation: null, credential_revision: null,
    entries: SCHEDULED_KINDS.map(kind => ({ kind, template_version: null, logical_id: null,
    readiness: 'awaiting_channel', reason_code: 'channel_unavailable' })) };
}
export function decodeAutomationDispatchStatus(value: unknown): AutomationDispatchStatus {
  if (!row(value) || !exact(value, ['channel_id', 'generation', 'credential_revision', 'entries'])
    || !Array.isArray(value.entries) || value.entries.length !== SCHEDULED_KINDS.length) return unavailable();
  const noChannel = value.channel_id === null && value.generation === null && value.credential_revision === null;
  if (!noChannel && !(isManagementUuid(value.channel_id) && integer(value.generation, 1) && integer(value.credential_revision, 0))) return unavailable();
  const kinds = new Set<string>();
  for (const entry of value.entries) {
    if (!row(entry) || !exact(entry, ['kind', 'template_version', 'logical_id', 'readiness', 'reason_code'])
      || !SCHEDULED_KINDS.includes(entry.kind as ScheduledKind) || kinds.has(entry.kind as string)
      || !DISPATCH_READINESS.includes(entry.readiness as typeof DISPATCH_READINESS[number])
      || !DISPATCH_STATUS_REASONS.includes(entry.reason_code as typeof DISPATCH_STATUS_REASONS[number])) return unavailable();
    kinds.add(entry.kind as string);
    if (noChannel && (entry.template_version !== null || entry.logical_id !== null
      || entry.readiness !== 'awaiting_channel' || entry.reason_code !== 'channel_unavailable')) return unavailable();
    if (entry.template_version === null) {
      if (entry.logical_id !== null || entry.readiness === 'ready') return unavailable();
    } else if (![1, 2].includes(entry.template_version as number)
      || entry.logical_id !== variants[entry.kind as ScheduledKind][0].replace(/_v2$/, `_v${entry.template_version}`)) return unavailable();
    if ((entry.readiness === 'ready') !== (entry.reason_code === 'ready')) return unavailable();
  }
  return value as unknown as AutomationDispatchStatus;
}

/** Discovery follows authorized unit access; no request binding or version participates. */
export async function resolveActiveDispatchBinding(unitId: string, io: {
  channels(unitId: string): Promise<Record<string, unknown>[]>;
  binding(channelId: string): Promise<Record<string, unknown> | null>;
}): Promise<string | null> {
  if (!isManagementUuid(unitId)) return unavailable();
  const channels = await io.channels(unitId);
  if (!Array.isArray(channels) || channels.some(channel => !isManagementUuid(channel.id) || channel.unit_id !== unitId
    || ![true, false, null].includes(channel.is_active as boolean | null) || typeof channel.status !== 'string'
    || typeof channel.created_at !== 'string' || !Number.isFinite(Date.parse(channel.created_at)))) return unavailable();
  const active = channels.filter(channel => channel.is_active === true);
  if (active.length > 1) return unavailable();
  const legacy = channels.filter(channel => channel.is_active === null && channel.status === 'connected')
    .sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const channel = active[0] ?? legacy[0];
  if (!channel) return null;
  const binding = await io.binding(String(channel.id));
  if (!binding) return null;
  if (binding.unit_id !== unitId || binding.channel_id !== channel.id || !isManagementUuid(binding.id)) return unavailable();
  return binding.id;
}

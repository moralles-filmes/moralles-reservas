import { z } from 'zod';
import { SCHEDULED_KINDS, type ScheduledKind } from '../../../supabase/functions/_shared/whatsapp-automation-core';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const dispatchVersionSchema = z.union([z.literal(1), z.literal(2)]);
export const dispatchVersionReasons = ['ready', 'meta_pending', 'meta_rejected', 'catalog_drift', 'channel_unavailable',
  'grant_unavailable', 'policy_paused', 'binding_changed', 'sync_stale', 'quality_blocked', 'cost_not_authorized', 'dependency_unavailable'] as const;
const remoteStatus = z.enum(['UNKNOWN', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED']);
export const dispatchKindLabels: Record<ScheduledKind, string> = {
  confirmation: 'Confirmação de reserva', reminder_d1: 'Lembrete de reserva', survey_d1: 'Pesquisa da reserva',
  cancellation: 'Cancelamento da reserva', waitlist_entered: 'Entrada na fila', waitlist_feedback: 'Pesquisa da fila',
  waitlist_table_ready: 'Mesa pronta', voucher_issued: 'Voucher programado',
};
export const dispatchV2Variants: Record<ScheduledKind, readonly string[]> = {
  confirmation: ['res_confirmacao_v2', 'res_confirmacao_desconto_v2'], reminder_d1: ['res_lembrete_dia_v2'],
  survey_d1: ['res_pesquisa_reserva_v2'], cancellation: ['res_cancelada_v2'], waitlist_entered: ['fila_entrada_v2'],
  waitlist_feedback: ['fila_feedback_v2'], waitlist_table_ready: ['fila_mesa_pronta_v2'], voucher_issued: ['mkt_voucher_programado_v2'],
};
export const dispatchVersionReasonLabels: Record<typeof dispatchVersionReasons[number], string> = {
  ready: 'Modelos e gates de seleção conferidos. O envio ainda depende das condições de cada mensagem.',
  meta_pending: 'Aguardando aprovação dos modelos pela Meta.', meta_rejected: 'Um modelo foi recusado pela Meta.',
  catalog_drift: 'Conteúdo ou categoria precisa de revisão.', channel_unavailable: 'O canal precisa de revisão.',
  grant_unavailable: 'A liberação dos modelos precisa de revisão.', policy_paused: 'A política está pausada.',
  binding_changed: 'O vínculo do canal mudou. Atualize os dados.', sync_stale: 'A sincronização dos modelos precisa ser atualizada.',
  quality_blocked: 'A qualidade do modelo impede esta seleção.', cost_not_authorized: 'Falta autorização de custo para esta versão.',
  dependency_unavailable: 'Não foi possível conferir os gates. Atualize os dados.',
};
export function dispatchCategory(kind: ScheduledKind): 'UTILITY' | 'MARKETING' {
  return kind === 'waitlist_feedback' || kind === 'voucher_issued' ? 'MARKETING' : 'UTILITY';
}
const variant = z.object({ logical_id: z.string(), status: remoteStatus, ready: z.boolean() }).strict()
  .refine(value => !value.ready || value.status === 'APPROVED');
const entry = z.object({
  kind: z.enum(SCHEDULED_KINDS), selected_version: dispatchVersionSchema.nullable(),
  selection_source: z.enum(['legacy', 'admin', 'auto']).nullable(), revision: integer,
  v2_ready: z.boolean(), v2_reason_code: z.enum(dispatchVersionReasons), variants: z.array(variant).min(1).max(2),
}).strict().refine(value => {
  if ((value.selected_version === null) !== (value.selection_source === null)) return false;
  if (value.selection_source === 'legacy' && value.selected_version !== 1) return false;
  if (value.selection_source === 'auto' && value.selected_version !== 2) return false;
  const expected = dispatchV2Variants[value.kind];
  return value.variants.length === expected.length && new Set(value.variants.map(item => item.logical_id)).size === expected.length
    && value.variants.every(item => expected.includes(item.logical_id))
    && value.v2_ready === (value.v2_reason_code === 'ready')
    && (!value.v2_ready || value.variants.every(item => item.ready));
});
export const dispatchVersionSnapshotSchema = z.object({
  binding_id: z.uuid(), channel_id: z.uuid(), generation: integer.min(1), credential_revision: integer,
  entries: z.array(entry).length(SCHEDULED_KINDS.length),
}).strict().refine(value => new Set(value.entries.map(item => item.kind)).size === SCHEDULED_KINDS.length);
export const dispatchVersionResultSchema = z.object({
  state: z.enum(['selected', 'stale', 'not_ready', 'refused']), version: dispatchVersionSchema.nullable(), revision: integer,
}).strict().refine(value => value.state === 'selected' ? value.version !== null && value.revision >= 1
  : value.version === null ? value.revision === 0 : value.revision >= 1);
export type DispatchVersionSnapshot = z.infer<typeof dispatchVersionSnapshotSchema>;
export type DispatchVersionEntry = DispatchVersionSnapshot['entries'][number];
export type DispatchVersionPin = {
  bindingId: string; channelId: string; generation: number; credentialRevision: number;
  kind: ScheduledKind; version: 1 | 2; revision: number; selectedVersion: 1 | 2 | null;
  selectionSource: DispatchVersionEntry['selection_source'];
};
export function dispatchVersionMatches(snapshot: DispatchVersionSnapshot | undefined, pin: DispatchVersionPin): boolean {
  const current = snapshot?.entries.find(item => item.kind === pin.kind);
  return !!snapshot && !!current && snapshot.binding_id === pin.bindingId && snapshot.channel_id === pin.channelId
    && snapshot.generation === pin.generation && snapshot.credential_revision === pin.credentialRevision
    && current.revision === pin.revision && current.selected_version === pin.selectedVersion
    && current.selection_source === pin.selectionSource && (pin.version === 1 || current.v2_ready);
}

export const storeDispatchStatusSchema = z.object({
  channel_id: z.uuid().nullable(), generation: integer.min(1).nullable(), credential_revision: integer.nullable(),
  entries: z.array(z.object({
  kind: z.enum(SCHEDULED_KINDS), template_version: dispatchVersionSchema.nullable(), logical_id: z.string().nullable(),
  readiness: z.enum(['awaiting_channel', 'pending_meta', 'rejected', 'awaiting_dispatch', 'ready', 'review']),
  reason_code: z.enum([...dispatchVersionReasons, 'dispatch_paused']),
}).strict().refine(value => {
  if (value.template_version === null) return value.logical_id === null && ['awaiting_channel', 'review'].includes(value.readiness);
  if (value.logical_id !== dispatchV2Variants[value.kind][0].replace(/_v2$/, `_v${value.template_version}`)) return false;
  return value.readiness !== 'ready' || value.reason_code === 'ready';
})).length(SCHEDULED_KINDS.length) }).strict().refine(value => {
  const absent = value.channel_id === null;
  return (value.generation === null) === absent && (value.credential_revision === null) === absent
    && new Set(value.entries.map(item => item.kind)).size === SCHEDULED_KINDS.length
    && (!absent || value.entries.every(item => item.template_version === null && item.logical_id === null
      && item.readiness === 'awaiting_channel' && item.reason_code === 'channel_unavailable'));
});
export type StoreDispatchStatus = z.infer<typeof storeDispatchStatusSchema>;
export type StoreDispatchEntry = z.infer<typeof storeDispatchStatusSchema>['entries'][number];
export function storeDispatchMatches(snapshot: { channelId?: string | null; configuration?: { bindingGeneration?: number | null; credentialRevision?: number | null } }, status: StoreDispatchStatus): boolean {
  // Explicitly absent authority can only produce awaiting-channel rows, never a text fallback.
  return status.channel_id === null || (snapshot.channelId === status.channel_id
    && snapshot.configuration?.bindingGeneration === status.generation
    && snapshot.configuration?.credentialRevision === status.credential_revision);
}
export const storeDispatchStatusLabels: Record<StoreDispatchEntry['readiness'], string> = {
  awaiting_channel: 'Aguardando configuração do canal', pending_meta: 'Aguardando análise da Meta', rejected: 'Recusado pela Meta',
  awaiting_dispatch: 'Aprovado, aguardando liberação de envio', ready: 'Configuração pronta para envio', review: 'Revisão necessária',
};
export function storeTemplateTitle(logicalId: string): string {
  if (logicalId.startsWith('res_confirmacao_desconto_')) return 'Confirmação de reserva com desconto';
  for (const [kind, ids] of Object.entries(dispatchV2Variants)) {
    if (ids.some(id => id.replace(/_v2$/, '') === logicalId.replace(/_v[12]$/, ''))) return dispatchKindLabels[kind as ScheduledKind];
  }
  return 'Aviso oficial';
}
export function storeSelectedTemplates<T extends { logicalId?: string; version?: number }>(templates: readonly T[], entries: readonly StoreDispatchEntry[]): T[] {
  return entries.flatMap(status => status.template_version === null ? [] : templates.filter(template =>
    template.version === status.template_version && dispatchV2Variants[status.kind].some(id =>
      id.replace(/_v2$/, `_v${status.template_version}`) === template.logicalId)));
}

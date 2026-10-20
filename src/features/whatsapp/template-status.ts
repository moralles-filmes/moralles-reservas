import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';

const labels: Record<OfficialTemplateView['localStatus'], string> = {
  awaiting_connection: 'Aguardando preparação', queued: 'Na fila de submissão', submitting: 'Submissão em andamento',
  pending: 'Estado remoto ainda não confirmado', usable: 'Aprovação ou integridade pendente', rejected: 'Recusado pela Meta',
  paused: 'Pausado para revisão', disabled: 'Desativado', conflict: 'Conteúdo ou categoria divergente',
  sync_error: 'Sincronização pendente', unsupported: 'Indisponível neste canal',
};
const remoteLabels: Record<Exclude<OfficialTemplateView['remoteStatus'], 'APPROVED'>, string> = {
  UNKNOWN: 'Estado remoto ainda não confirmado', PENDING: 'Em análise na Meta',
  REJECTED: 'Recusado pela Meta', IN_APPEAL: 'Recurso em análise na Meta',
  PAUSED: 'Pausado pela Meta', DISABLED: 'Desativado pela Meta',
  PENDING_DELETION: 'Remoção pendente na Meta', DELETED: 'Removido da Meta',
  LIMIT_EXCEEDED: 'Limite de modelos atingido na Meta',
};

export function qualityBlocksTemplate(template: OfficialTemplateView): boolean {
  return template.quality === 'RED' && (template.version === 2 || template.requestedCategory === 'MARKETING');
}

export function storeTemplateStatus(template: OfficialTemplateView): string {
  // Remote observation wins over lagging local classification, without granting send authority.
  if (template.remoteStatus !== 'APPROVED') return remoteLabels[template.remoteStatus];
  if (template.localStatus !== 'usable') return labels[template.localStatus];
  if (qualityBlocksTemplate(template)) return 'Qualidade do modelo impede o envio';
  return template.remoteStatus === 'APPROVED' && template.hashMatches && !template.syncRequired
    && template.effectiveCategory === template.requestedCategory
    ? 'Aprovado pela Meta' : labels.usable;
}

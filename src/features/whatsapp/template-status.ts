import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';

const labels: Record<OfficialTemplateView['localStatus'], string> = {
  awaiting_connection: 'Aguardando preparação', queued: 'Na fila de submissão', submitting: 'Submissão em andamento',
  pending: 'Estado remoto ainda não confirmado', usable: 'Aprovação ou integridade pendente', rejected: 'Recusado pela Meta',
  paused: 'Pausado para revisão', disabled: 'Desativado', conflict: 'Conteúdo ou categoria divergente',
  sync_error: 'Sincronização pendente', unsupported: 'Indisponível neste canal',
};

export function storeTemplateStatus(template: OfficialTemplateView): string {
  if (template.remoteStatus === 'IN_APPEAL') return 'Recurso em análise na Meta';
  if (template.localStatus === 'pending' && template.remoteStatus === 'PENDING') return 'Em análise na Meta';
  if (template.localStatus !== 'usable') return labels[template.localStatus];
  return template.remoteStatus === 'APPROVED' && template.hashMatches && !template.syncRequired
    && template.effectiveCategory === template.requestedCategory
    && !(template.requestedCategory === 'MARKETING' && template.quality === 'RED')
    ? 'Aprovado e disponível' : labels.usable;
}

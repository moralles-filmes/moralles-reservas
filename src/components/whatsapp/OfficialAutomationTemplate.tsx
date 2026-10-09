import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { canRequestJobCorrection, templateErrorMessage, type OfficialTemplateView, type TemplateControls } from '@/hooks/useWhatsappTemplates';

const statusLabels: Record<OfficialTemplateView['localStatus'], string> = {
  awaiting_connection: 'Aguardando configuração', queued: 'Aguardando processamento', submitting: 'Em processamento', pending: 'Pendente de análise', usable: 'Modelo disponível', rejected: 'Modelo recusado', paused: 'Modelo pausado', disabled: 'Modelo desativado', conflict: 'Conteúdo divergente', sync_error: 'Falha na sincronização', unsupported: 'Modelo indisponível',
};
const remoteLabels: Record<OfficialTemplateView['remoteStatus'], string> = { UNKNOWN: 'Desconhecido', PENDING: 'Pendente', APPROVED: 'Aprovado', REJECTED: 'Recusado', PAUSED: 'Pausado', DISABLED: 'Desativado', IN_APPEAL: 'Em recurso', PENDING_DELETION: 'Remoção pendente', DELETED: 'Removido', LIMIT_EXCEEDED: 'Limite atingido' };
const categories = { UTILITY: 'Utilidade', MARKETING: 'Marketing', AUTHENTICATION: 'Autenticação', UNKNOWN: 'Desconhecida' };
const quality = { UNKNOWN: 'Qualidade desconhecida', GREEN: 'Qualidade alta', YELLOW: 'Qualidade média', RED: 'Qualidade baixa' };
export function OfficialAutomationTemplate({ template, onSync, canSync = true, syncing = false }: { template: OfficialTemplateView; onSync: () => void; canSync?: boolean; syncing?: boolean }) {
  return <Card className="p-4 space-y-4">
    <div><h3 className="font-semibold">{statusLabels[template.localStatus]}</h3><p className="text-sm text-muted-foreground">Conteúdo oficial somente para leitura.</p></div>
    <div className="whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-sm">{template.body}</div>
    <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{template.footer}</p>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div><dt className="text-muted-foreground">Categoria solicitada</dt><dd>{categories[template.requestedCategory]}</dd></div>
      <div><dt className="text-muted-foreground">Categoria efetiva</dt><dd>{template.effectiveCategory ? categories[template.effectiveCategory] : 'Ainda não informada'}</dd></div>
      <div><dt className="text-muted-foreground">Análise do provedor</dt><dd>{remoteLabels[template.remoteStatus]}</dd></div>
      <div><dt className="text-muted-foreground">Qualidade</dt><dd>{quality[template.quality]}</dd></div>
      <div><dt className="text-muted-foreground">Idioma</dt><dd>Português (Brasil)</dd></div>
      <div><dt className="text-muted-foreground">Última sincronização</dt><dd>{template.lastSyncedAt ? new Date(template.lastSyncedAt).toLocaleString('pt-BR') : 'Ainda não realizada'}</dd></div>
    </dl>
    {!template.hashMatches && <p className="text-sm">Conteúdo ainda não conferido com o modelo aprovado.</p>}
    {template.syncRequired && <p className="text-sm">Sincronização necessária antes de usar este modelo.</p>}
    {canSync && <Button className="min-h-11" variant="outline" disabled={syncing} onClick={onSync}>{syncing ? 'Solicitando…' : 'Solicitar sincronização'}</Button>}
  </Card>;
}
export function TemplateStatus({ controls, logicalIds }: { controls: TemplateControls; logicalIds: OfficialTemplateView['logicalId'][] }) {
  const { query, sync, correction, canManage } = controls;
  if (query.isPending) return <p role="status">Consultando o canal de WhatsApp…</p>;
  if (query.isError) return <div role="alert" className="space-y-2"><p>{templateErrorMessage(query.error)}</p><Button className="min-h-11" onClick={() => void query.refetch()}>Tentar novamente</Button></div>;
  const snapshot = query.data;
  if (!snapshot || snapshot.mode === 'unavailable') return <div className="space-y-2"><p role="status">Nenhum canal disponível. Confira a configuração do WhatsApp da unidade.</p><Button className="min-h-11" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Atualizar dados</Button></div>;
  const jobs = snapshot.blockedJobs.filter(j => j.logicalId && logicalIds.includes(j.logicalId));
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Canal: {snapshot.providerLabel}. {snapshot.mode === 'unofficial' ? 'Conexão não oficial: pode apresentar instabilidade ou restrições.' : 'Mensagens automáticas usam modelos oficiais.'}</p>
    {snapshot.mode === 'official' && snapshot.templates.filter(t => logicalIds.includes(t.logicalId)).map(template => <OfficialAutomationTemplate key={template.logicalId} template={template} onSync={() => sync.mutate()} canSync={canManage && !!snapshot.configuration.bindingGeneration && snapshot.capabilities.templateManagement} syncing={sync.isPending || query.isFetching} />)}
    {sync.isSuccess && <p role="status">{sync.data.status === 'requested' ? 'Sincronização solicitada. Atualize os dados para acompanhar a análise.' : 'Sincronização indisponível para este canal.'}</p>}
    {sync.isError && <p role="alert">{templateErrorMessage(sync.error)}</p>}
    <Button className="min-h-11" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Atualizar dados</Button>
    {jobs.map(job => <Card key={job.jobId} className="p-4 space-y-2"><p className="text-sm">{job.state === 'uncertain' ? 'O resultado desta mensagem precisa de conferência.' : 'Uma mensagem está impedida de continuar.'}</p><p className="text-sm text-muted-foreground">{job.reason === 'consent_changed' || job.reason === 'do_not_contact' ? 'Confira a permissão do contato para esta finalidade.' : job.reason === 'template_unavailable' || job.reason === 'template_sync_failed' ? 'Confira a análise e a sincronização do modelo.' : 'Confira o canal, a configuração e as condições da mensagem.'}</p>
      {canManage && canRequestJobCorrection(job, snapshot) && <><p className="text-sm">A verificação mantém a mensagem original e pode ser recusada se as condições mudaram.</p><Button className="min-h-11" variant="outline" disabled={correction.isPending || query.isFetching} onClick={() => correction.mutate(job.jobId)}>Verificar correção</Button></>}
    </Card>)}
    {correction.isError && <p role="alert">{templateErrorMessage(correction.error)}</p>}
    {correction.isSuccess && <p role="status">Correção registrada. O envio ainda depende das condições da mensagem.</p>}
  </div>;
}

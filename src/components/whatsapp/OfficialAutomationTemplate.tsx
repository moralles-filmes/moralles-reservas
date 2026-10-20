import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { canRequestJobCorrection, templateErrorMessage, type OfficialTemplateView, type TemplateControls } from '@/hooks/useWhatsappTemplates';
import { AUTOMATIC_SUBMISSION_COPY, templatePreparationMessage, templatePreparationReasonMessage } from '@/features/whatsapp/template-preparation';
import { useWhatsappDispatchStatus } from '@/hooks/useWhatsappDispatchStatus';
import { dispatchKindLabels, dispatchV2Variants, storeDispatchMatches, storeDispatchStatusLabels, storeSelectedTemplates } from '@/features/whatsapp/template-dispatch-versions';
import { qualityBlocksTemplate } from '@/features/whatsapp/template-status';

const statusLabels: Record<OfficialTemplateView['localStatus'], string> = {
  awaiting_connection: 'Aguardando configuração', queued: 'Aguardando processamento', submitting: 'Em processamento', pending: 'Estado remoto ainda não confirmado', usable: 'Modelo disponível', rejected: 'Modelo recusado', paused: 'Modelo pausado', disabled: 'Modelo desativado', conflict: 'Conteúdo divergente', sync_error: 'Falha na sincronização', unsupported: 'Modelo indisponível',
};
const remoteLabels: Record<OfficialTemplateView['remoteStatus'], string> = { UNKNOWN: 'Desconhecido', PENDING: 'Pendente', APPROVED: 'Aprovado', REJECTED: 'Recusado', PAUSED: 'Pausado', DISABLED: 'Desativado', IN_APPEAL: 'Em recurso', PENDING_DELETION: 'Remoção pendente', DELETED: 'Removido', LIMIT_EXCEEDED: 'Limite atingido' };
const categories = { UTILITY: 'Utilidade', MARKETING: 'Marketing', AUTHENTICATION: 'Autenticação', UNKNOWN: 'Desconhecida' };
const quality = { UNKNOWN: 'Qualidade desconhecida', GREEN: 'Qualidade alta', YELLOW: 'Qualidade média', RED: 'Qualidade baixa' };
const diagnosticJobStates = new Set(['blocked', 'needs_review', 'uncertain', 'paused', 'rejected', 'failed']);
export function OfficialAutomationTemplate({ template, onSync, canSync = true, syncing = false }: { template: OfficialTemplateView; onSync: () => void; canSync?: boolean; syncing?: boolean }) {
  const verifiedUsable = template.localStatus === 'usable' && template.remoteStatus === 'APPROVED'
    && template.hashMatches && !template.syncRequired && template.effectiveCategory === template.requestedCategory
    && !qualityBlocksTemplate(template);
  return <Card className="p-4 space-y-4">
    <div><h3 className="font-semibold">{template.remoteStatus === 'IN_APPEAL' ? 'Recurso em análise na Meta' : template.localStatus === 'usable' && !verifiedUsable ? 'Aprovação ou integridade pendente' : template.localStatus === 'pending' && template.remoteStatus === 'PENDING' ? 'Em análise na Meta' : statusLabels[template.localStatus]}</h3><p className="text-sm text-muted-foreground">Conteúdo oficial somente para leitura.</p></div>
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
  const { query, sync, correction, canManage, canAdministerCatalog } = controls;
  const dispatch = useWhatsappDispatchStatus(controls.unitId, !query.isError && query.data?.mode === 'official');
  if (query.isPending) return <p role="status">Consultando o canal de WhatsApp…</p>;
  if (query.isError) return <div role="alert" className="space-y-2"><p>{templateErrorMessage(query.error)}</p><Button className="min-h-11" onClick={() => void query.refetch()}>Tentar novamente</Button></div>;
  const snapshot = query.data;
  if (!snapshot || snapshot.mode === 'unavailable') return <div className="space-y-2"><p role="status">Nenhum canal disponível. Confira a configuração do WhatsApp da unidade.</p><Button className="min-h-11" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Atualizar dados</Button></div>;
  const samePurpose = (id: string) => logicalIds.some(logicalId => logicalId.replace(/_v[12]$/, '') === id.replace(/_v[12]$/, ''));
  const relevantKinds = Object.entries(dispatchV2Variants).filter(([, ids]) => ids.some(samePurpose)).map(([kind]) => kind);
  const jobs = snapshot.blockedJobs.filter(j => j.logicalId && samePurpose(j.logicalId) && diagnosticJobStates.has(j.state));
  const preparation = snapshot.providerLabel === 'Datafy' ? snapshot.templatePreparation ?? null : null;
  const autoEligible = preparation?.enrollment === 'eligible';
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Canal: {snapshot.providerLabel}. {snapshot.mode === 'unofficial' ? 'Conexão não oficial: pode apresentar instabilidade ou restrições.' : 'Mensagens automáticas usam modelos oficiais.'}</p>
    {snapshot.mode === 'official' && snapshot.configuration.bindingGeneration === null && <p role="status">O vínculo da conta de modelos deste canal ainda não foi informado. Acompanhe a preparação ou fale com o suporte se continuar pendente.</p>}
    {snapshot.providerLabel === 'Datafy' && <div className="space-y-2 rounded-lg border p-4 text-sm" aria-label="Preparação automática dos modelos">
      {autoEligible && <p>{AUTOMATIC_SUBMISSION_COPY}</p>}
      <p role="status">{templatePreparationMessage(preparation)}</p>
      {templatePreparationReasonMessage(preparation) && <p role="alert">{templatePreparationReasonMessage(preparation)}</p>}
    </div>}
    {snapshot.mode === 'official' && snapshot.configuration.bindingGeneration !== null && !snapshot.configuration.catalogAuthorized && !autoEligible && <p role="status">O catálogo deste canal ainda não foi liberado para novas submissões à Meta. A conexão do WhatsApp não ativa esse envio por si só.</p>}
    {snapshot.mode === 'official' && snapshot.configuration.catalogAuthorized && <p role="status">Os modelos são preparados para análise da Meta. A submissão não significa aprovação e não ativa o envio de mensagens a clientes.</p>}
    {snapshot.mode === 'official' && (dispatch.isPending ? <p role="status">Consultando o estado de envio deste aviso…</p>
      : dispatch.isError || !dispatch.data || !storeDispatchMatches(snapshot, dispatch.data) ? <p role="alert">Não foi possível conferir o estado de envio deste aviso. Atualize os dados.</p>
        : <>
          {dispatch.data.entries.filter(entry => relevantKinds.includes(entry.kind)).map(entry => <p key={entry.kind} role="status">{dispatchKindLabels[entry.kind]}: {storeDispatchStatusLabels[entry.readiness]}. As condições de cada mensagem, inclusive consentimento, ainda são verificadas no envio.</p>)}
          {storeSelectedTemplates(snapshot.templates, dispatch.data.entries.filter(entry => relevantKinds.includes(entry.kind))).map(template => <OfficialAutomationTemplate key={template.logicalId} template={template} onSync={() => sync.mutate()} canSync={canAdministerCatalog && !!snapshot.configuration.bindingGeneration && snapshot.capabilities.templateManagement} syncing={sync.isPending || query.isFetching} />)}
        </>)}
    {sync.isSuccess && <p role="status">{sync.data.status === 'requested' ? 'Sincronização solicitada. Atualize os dados para acompanhar a análise.' : 'Sincronização indisponível para este canal.'}</p>}
    {sync.isError && <p role="alert">{templateErrorMessage(sync.error)}</p>}
    <Button className="min-h-11" variant="outline" disabled={query.isFetching || dispatch.isFetching} onClick={() => { void query.refetch(); if (snapshot.mode === 'official') void dispatch.refetch(); }}>Atualizar dados</Button>
    {jobs.map(job => <Card key={job.jobId} className="p-4 space-y-2"><p className="text-sm">{job.target === 'catalog' ? job.state === 'uncertain' ? 'O resultado da submissão deste modelo precisa de conferência.' : 'A preparação deste modelo precisa de revisão.' : job.state === 'uncertain' ? 'O resultado desta mensagem precisa de conferência.' : 'Uma mensagem está impedida de continuar.'}</p><p className="text-sm text-muted-foreground">{job.reason === 'consent_changed' || job.reason === 'do_not_contact' ? 'Confira a permissão do contato para esta finalidade.' : job.reason === 'template_unavailable' || job.reason === 'template_sync_failed' ? 'Confira a análise e a sincronização do modelo.' : job.target === 'catalog' ? 'Confira o estado do modelo na Meta antes de tentar nova submissão.' : 'Confira o canal, a configuração e as condições da mensagem.'}</p>
      {canManage && canRequestJobCorrection(job, snapshot) && <><p className="text-sm">A verificação mantém a mensagem original e pode ser recusada se as condições mudaram.</p><Button className="min-h-11" variant="outline" disabled={correction.isPending || query.isFetching} onClick={() => correction.mutate(job.jobId)}>Verificar correção</Button></>}
    </Card>)}
    {correction.isError && <p role="alert">{templateErrorMessage(correction.error)}</p>}
    {correction.isSuccess && <p role="status">Correção registrada. O envio ainda depende das condições da mensagem.</p>}
  </div>;
}

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { templateErrorMessage } from '@/hooks/useWhatsappTemplates';
import { useWhatsappOnboardingCatalog } from '@/hooks/useWhatsappOnboardingCatalog';
import { templatePreparationMessage, templatePreparationReasonMessage } from '@/features/whatsapp/template-preparation';
import { TemplateCatalogEntry } from './TemplateCatalogEntry';
import { useWhatsappDispatchStatus } from '@/hooks/useWhatsappDispatchStatus';
import { dispatchKindLabels, dispatchV2Variants, storeDispatchStatusLabels, storeSelectedTemplates } from '@/features/whatsapp/template-dispatch-versions';

export function TemplateCatalogStoreCard({ unitId }: { unitId: string }) {
  const query = useWhatsappOnboardingCatalog(unitId);
  const catalog = query.data;
  const dispatch = useWhatsappDispatchStatus(unitId, !!catalog?.channelId);
  const preparation = catalog?.templatePreparation ?? null;
  const sameChannel = !!catalog && !!dispatch.data && catalog.channelId !== null && dispatch.data.channel_id === catalog.channelId
    && catalog.bindingGeneration !== null && dispatch.data.generation === catalog.bindingGeneration
    && catalog.credentialRevision !== null && dispatch.data.credential_revision === catalog.credentialRevision;
  const preparedVersion = catalog?.catalogSelection?.state === 'v1' ? 1
    : catalog?.catalogSelection?.state === 'pending' || catalog?.catalogSelection?.state === 'ready'
      || catalog?.catalogSelection?.state === 'paused' || preparation?.version === 2 ? 2 : 1;
  const preparedTemplates = catalog?.templates.filter(template => template.version === preparedVersion) ?? [];
  const selectedTemplates = sameChannel ? storeSelectedTemplates(catalog.templates, dispatch.data.entries) : [];
  const expectedSelectedCount = sameChannel ? dispatch.data.entries.reduce((total, entry) =>
    total + (entry.template_version === null ? 0 : dispatchV2Variants[entry.kind].length), 0) : 0;
  return <Card>
    <CardHeader><CardTitle className="text-base">Análise dos modelos oficiais</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">Os estados são atualizados automaticamente enquanto esta página está aberta. Aprovação da Meta e ativação de cada automação são etapas separadas.</p>
      {query.isPending ? <p role="status">Consultando os modelos oficiais…</p>
        : query.isError || !catalog ? <div role="alert" className="space-y-2"><p>{templateErrorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>
        : <>
          <p role="status">{templatePreparationMessage(preparation)}</p>
          {templatePreparationReasonMessage(preparation) && <p role="alert">{templatePreparationReasonMessage(preparation)}</p>}
          {catalog.channelId === null && <p role="status">O canal Datafy ainda não está disponível para consultar os modelos.</p>}
          {catalog.channelId !== null && (dispatch.isPending ? <p role="status">Consultando o estado dos avisos deste canal…</p>
            : dispatch.isError || !dispatch.data ? <p role="alert">Não foi possível conferir o estado dos avisos. Atualize os dados.</p>
              : sameChannel ? <>
                <ul className="space-y-2" aria-label="Estado de envio por finalidade">{dispatch.data.entries.map(entry => <li key={entry.kind}>
                  {dispatchKindLabels[entry.kind]}: {storeDispatchStatusLabels[entry.readiness]}
                </li>)}</ul>
                <p>Os textos abaixo correspondem à preferência registrada. Aprovação não comprova liberação, consentimento ou entrega de uma mensagem.</p>
                {selectedTemplates.length < expectedSelectedCount && <p role="alert">Nem todos os textos da preferência estão disponíveis nesta leitura. Atualize os dados antes de usar estes avisos.</p>}
                <ul className="space-y-2" aria-label="Textos oficiais dos avisos">{selectedTemplates.map(template =>
                  <TemplateCatalogEntry key={`${template.logicalId}:${template.version}`} template={template} audience="store" />)}</ul>
              </> : <p role="status">Os modelos deste canal estão em preparação. O estado de envio aparecerá após a ativação e conferência do vínculo.</p>)}
          {catalog.channelId !== null && !dispatch.isPending && !sameChannel && <>
            <p>Textos em preparação para este canal. A análise da Meta não libera o envio aos clientes.</p>
            {preparedTemplates.length === 0 && <p role="status">Os textos desta preparação ainda não estão disponíveis. Aguarde a atualização do catálogo.</p>}
            <ul className="space-y-2" aria-label="Textos em preparação">{preparedTemplates.map(template =>
              <TemplateCatalogEntry key={`${template.logicalId}:${template.version}`} template={template} audience="store" />)}</ul>
          </>}
          <Button className="min-h-11" variant="outline" disabled={query.isFetching || dispatch.isFetching} onClick={() => { void query.refetch(); if (catalog.channelId !== null) void dispatch.refetch(); }}>Atualizar dados</Button>
        </>}
    </CardContent>
  </Card>;
}

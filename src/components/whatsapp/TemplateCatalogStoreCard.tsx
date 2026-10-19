import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { templateErrorMessage } from '@/hooks/useWhatsappTemplates';
import { useWhatsappOnboardingCatalog } from '@/hooks/useWhatsappOnboardingCatalog';
import { templatePreparationMessage, templatePreparationReasonMessage } from '@/features/whatsapp/template-preparation';
import { TemplateCatalogEntry } from './TemplateCatalogEntry';

export function TemplateCatalogStoreCard({ unitId }: { unitId: string }) {
  const query = useWhatsappOnboardingCatalog(unitId);
  const catalog = query.data;
  const preparation = catalog?.templatePreparation ?? null;
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
          <p>{catalog.templates.length} estado{catalog.templates.length === 1 ? '' : 's'} de modelos disponíveis, com a versão de cada texto. A lista local não comprova submissão ou aprovação pela Meta.</p>
          <ul className="space-y-2" aria-label="Estado dos modelos oficiais por versão">{catalog.templates.map(template =>
            <TemplateCatalogEntry key={`${template.logicalId}:${template.version}`} template={template} />)}</ul>
          <Button className="min-h-11" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Atualizar dados</Button>
        </>}
    </CardContent>
  </Card>;
}

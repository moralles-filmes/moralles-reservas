import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';
import { catalogReleaseMatches, templateErrorMessage, useWhatsappTemplates, type CatalogReleasePin } from '@/hooks/useWhatsappTemplates';
import { TemplateCatalogEntry } from './TemplateCatalogEntry';
import { TemplateV2ChannelControls } from './TemplateV2ChannelControls';

/** Administration only. The server still authenticates the platform admin and pins the binding. */
export function TemplateCatalogAdminCard({ unitId }: { unitId: string }) {
  return <TemplateCatalogAdminSession key={unitId} unitId={unitId} />;
}

function TemplateCatalogAdminSession({ unitId }: { unitId: string }) {
  const controls = useWhatsappTemplates(unitId, null, true);
  const { query, releaseCatalog, sync, canAdministerCatalog } = controls;
  const [confirmation, setConfirmation] = useState<CatalogReleasePin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const snapshot = query.data;
  const bindingPresent = snapshot?.providerLabel === 'Datafy' && snapshot.channelId !== null
    && snapshot.configuration.bindingGeneration !== null && snapshot.configuration.credentialRevision !== null;
  const authorized = snapshot?.configuration.catalogAuthorized === true;
  const v1Selected = !snapshot?.catalogSelection || snapshot.catalogSelection.state === 'v1';
  const busy = query.isFetching || releaseCatalog.isPending || sync.isPending;

  useEffect(() => {
    if (confirmation && !locked.current && !releaseCatalog.isPending && (query.isError || !catalogReleaseMatches(snapshot, confirmation))) {
      setConfirmation(null);
      setNotice('A configuração do canal mudou. Atualize os dados antes de confirmar.');
    }
  }, [confirmation, query.isError, releaseCatalog.isPending, snapshot]);

  function openConfirmation() {
    if (!canAdministerCatalog || busy || (!authorized && !v1Selected) || snapshot?.providerLabel !== 'Datafy' || !snapshot.channelId
      || snapshot.configuration.bindingGeneration === null || snapshot.configuration.credentialRevision === null) return;
    releaseCatalog.reset();
    setNotice(null);
    setConfirmation({
      channelId: snapshot.channelId,
      bindingGeneration: snapshot.configuration.bindingGeneration,
      credentialRevision: snapshot.configuration.credentialRevision,
      catalogAuthorized: snapshot.configuration.catalogAuthorized,
      enabled: !snapshot.configuration.catalogAuthorized,
    });
  }

  async function confirmChange() {
    if (!confirmation || busy || locked.current) return;
    if (query.isError || !catalogReleaseMatches(snapshot, confirmation)) {
      setConfirmation(null);
      setNotice('A configuração do canal mudou. Atualize os dados antes de confirmar.');
      return;
    }
    locked.current = true;
    try {
      await releaseCatalog.mutateAsync(confirmation);
      setConfirmation(null);
    } catch { /* The typed error is shown in the dialog. */ }
    finally { locked.current = false; }
  }

  return <Card>
    <CardHeader><CardTitle>Modelos oficiais da Meta</CardTitle></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p className="text-muted-foreground">A liberação do catálogo v1 prepara os nove modelos da versão 1 para análise. Ela não ativa automações nem envia mensagens a clientes.</p>
      {query.isPending ? <p role="status">Consultando modelos da unidade…</p>
        : query.isError ? <div role="alert" className="space-y-2"><p>{templateErrorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>
        : !snapshot || snapshot.mode === 'unavailable' ? <p role="status">Nenhum canal ativo disponível para modelos oficiais.</p>
        : snapshot.providerLabel !== 'Datafy' ? <p role="status">O canal ativo não é Datafy; a liberação do catálogo v1 não está disponível.</p>
        : <>
          {!bindingPresent ? <p role="status">Canal Datafy conectado, mas o vínculo da conta de modelos ainda não foi informado. Atualize o diagnóstico do canal antes de liberar o catálogo v1.</p>
            : <>
              <p>Canal {snapshot.channelId?.slice(0, 8)} · geração {snapshot.configuration.bindingGeneration} · revisão da credencial {snapshot.configuration.credentialRevision}</p>
              <p className="text-muted-foreground">Vínculo registrado. O servidor confere identidade, verificação e saúde do canal ao liberar o catálogo v1.</p>
              <p role="status" className={authorized && v1Selected ? 'text-success' : 'text-muted-foreground'}>{!v1Selected ? 'A conta seleciona outro catálogo; novas submissões v1 não estão disponíveis.' : authorized ? 'Catálogo v1 liberado para este canal.' : 'Catálogo v1 ainda não liberado para este canal.'}</p>
              {canAdministerCatalog && <div className="flex flex-wrap gap-2">
                {(authorized || v1Selected) && <Button variant={authorized ? 'outline' : 'default'} disabled={busy} onClick={openConfirmation}>{authorized ? 'Revogar novas submissões v1' : 'Liberar os nove modelos v1'}</Button>}
                {authorized && <Button variant="outline" disabled={busy} onClick={() => sync.mutate()}>Solicitar atualização dos modelos</Button>}
              </div>}
              {canAdministerCatalog && <TemplateV2ChannelControls unitId={unitId} controls={controls} />}
            </>}
          <p className="text-muted-foreground">{snapshot.configuration.dispatchEnabled ? 'Despacho do canal habilitado.' : 'Despacho de mensagens deste canal desligado.'} {snapshot.configuration.adopted ? 'Unidade adotou o fluxo oficial.' : 'Unidade ainda não adotou o envio automático oficial.'}</p>
          {snapshot.templates.length > 0 && <div className="space-y-2" aria-label="Estado dos modelos oficiais">
            <p className="font-medium">Catálogo previsto: {snapshot.templates.length} modelo{snapshot.templates.length === 1 ? '' : 's'} exibido{snapshot.templates.length === 1 ? '' : 's'}. A lista não comprova submissão à Meta.</p>
            <ul className="space-y-2">{snapshot.templates.map(template => <TemplateCatalogEntry key={`${template.logicalId}:${template.version}`} template={template} />)}</ul>
          </div>}
          {sync.isSuccess && <p role="status">{sync.data.status === 'requested' ? 'Atualização solicitada; acompanhe os estados da Meta.' : 'Atualização indisponível neste canal.'}</p>}
          {sync.isError && <p role="alert">{templateErrorMessage(sync.error)}</p>}
        </>}
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Atualizar dados</Button>
      {notice && <p role="alert">{notice}</p>}
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !releaseCatalog.isPending) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.enabled ? 'Liberar catálogo v1 deste canal?' : 'Revogar novas submissões v1?'}</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2">
            {confirmation?.enabled ? <>
              <ResponsiveDialogDescription>Esta liberação pode iniciar a submissão dos nove modelos fixos v1 à análise da Meta via Datafy. Ela não libera os modelos v2 exibidos na lista. A aprovação pode demorar ou ser recusada.</ResponsiveDialogDescription>
              <p>Nenhuma mensagem será enviada a clientes por esta ação. Tarifas de mensagens enviadas pela Meta são separadas da assinatura Datafy; o preço de submissão dos modelos não está confirmado.</p>
            </> : <ResponsiveDialogDescription>Novas submissões v1 deste canal serão interrompidas. Uma submissão já confirmada e em andamento pode chegar à Meta. Esta ação não altera a liberação v2 nem cancela a assinatura Datafy.</ResponsiveDialogDescription>}
            {releaseCatalog.isError && <p role="alert">{templateErrorMessage(releaseCatalog.error)}</p>}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button variant="outline" disabled={releaseCatalog.isPending} onClick={() => setConfirmation(null)}>Voltar</Button>
            <Button disabled={busy || !bindingPresent || !canAdministerCatalog} onClick={() => void confirmChange()}>Confirmar</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

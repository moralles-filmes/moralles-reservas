import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';
import { dispatchReleaseMatches, templateErrorMessage, useWhatsappTemplates, type DispatchReleasePin } from '@/hooks/useWhatsappTemplates';

export function TemplateDispatchAdminCard({ unitId }: { unitId: string }) {
  const { user, loading, isPlatformAdmin } = useAuth();
  if (loading || !user || !isPlatformAdmin) return null;
  return <TemplateDispatchAdminSession key={`${user.id}:${unitId}`} unitId={unitId} />;
}

function TemplateDispatchAdminSession({ unitId }: { unitId: string }) {
  const { query, releaseDispatch, canAdministerDispatch, wasDispatchAttempted } = useWhatsappTemplates(unitId, null, true);
  const [confirmation, setConfirmation] = useState<DispatchReleasePin | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const locked = useRef(false);
  const snapshot = query.data;
  const configuration = snapshot?.configuration;
  const pin: DispatchReleasePin | null = snapshot?.channelId && configuration.bindingGeneration !== null && configuration.credentialRevision !== null ? {
    channelId: snapshot.channelId, bindingGeneration: configuration.bindingGeneration,
    credentialRevision: configuration.credentialRevision, dispatchEnabled: configuration.dispatchEnabled,
    adopted: configuration.adopted, enabled: !configuration.dispatchEnabled,
  } : null;
  const eligible = pin && dispatchReleaseMatches(snapshot, pin);
  const busy = query.isFetching || releaseDispatch.isPending;
  const fenced = pin && wasDispatchAttempted(pin);

  useEffect(() => {
    if (confirmation && !locked.current && !releaseDispatch.isPending
      && (query.isError || !dispatchReleaseMatches(snapshot, confirmation))) {
      setConfirmation(null);
      setNotice({ text: 'A configuração do despacho mudou. Atualize os dados antes de confirmar.', error: true });
    }
  }, [confirmation, query.isError, releaseDispatch.isPending, snapshot]);

  function openConfirmation() {
    if (!canAdministerDispatch || busy || query.isError || !eligible || fenced || locked.current) return;
    releaseDispatch.reset(); setNotice(null); setConfirmation(pin);
  }
  async function confirmChange() {
    if (!confirmation || busy || locked.current) return;
    if (query.isError || !dispatchReleaseMatches(snapshot, confirmation) || wasDispatchAttempted(confirmation)) {
      setConfirmation(null);
      setNotice({ text: 'A configuração do despacho mudou. Atualize os dados antes de confirmar.', error: true });
      return;
    }
    const confirmedPin = confirmation;
    locked.current = true;
    // Consume the captured confirmation before the mutation's own refetch changes the snapshot.
    setConfirmation(null);
    try {
      await releaseDispatch.mutateAsync(confirmedPin);
      setNotice({ text: confirmedPin.enabled
        ? 'Liberação v1 registrada. Confira o estado atualizado do canal.'
        : 'Pausa v1 registrada. A adoção e o histórico da unidade foram preservados.', error: false });
    } catch (error) {
      setNotice({ text: `${templateErrorMessage(error)} O resultado precisa de conferência. Atualize os dados; não repita a operação sem reconciliar o estado.`, error: true });
    } finally { locked.current = false; }
  }

  return <Card>
    <CardHeader><CardTitle>Envio automático com modelos v1</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>Controle administrativo do despacho v1 desta unidade. A preparação e a aprovação dos modelos v2 são independentes desta liberação.</p>
      {query.isPending ? <p role="status">Consultando despacho da unidade…</p>
        : query.isError ? <p role="alert">{templateErrorMessage(query.error)}</p>
          : !snapshot ? <p role="status">Não foi possível confirmar o despacho desta unidade.</p>
            : <>
              <p role="status">{configuration.dispatchEnabled ? 'Despacho v1 liberado neste canal.' : configuration.adopted
                ? 'Despacho v1 pausado neste canal.' : 'Despacho v1 ainda não liberado neste canal.'}</p>
              <p>{configuration.adopted ? 'Adoção durável registrada: pausar não devolve as automações ao fluxo legado.' : 'A primeira liberação registra a adoção durável da unidade.'}</p>
              {pin && <p>Canal {pin.channelId.slice(0, 8)} · geração {pin.bindingGeneration} · revisão da credencial {pin.credentialRevision}</p>}
              {eligible && canAdministerDispatch ? <Button variant={pin.enabled ? 'default' : 'outline'} disabled={busy || fenced} onClick={openConfirmation}>
                {pin.enabled ? 'Liberar despacho v1' : 'Pausar despacho v1'}
              </Button> : <p role="status">A liberação exige um canal Datafy atual com vínculo identificado. A pausa de uma liberação existente permanece disponível com os dados atuais do vínculo.</p>}
              {fenced && <p role="status">Esta solicitação já foi tentada. O controle permanece bloqueado até uma leitura atualizada comprovar o resultado solicitado.</p>}
            </>}
      <p className="text-muted-foreground">A flag global de despacho e as automações escolhidas pela loja continuam separadas. Modelos aprovados, consentimentos e autorizações de custo são conferidos no envio. Este controle não libera MARKETING.</p>
      <Button variant="outline" disabled={busy} onClick={() => void query.refetch()}>Atualizar despacho</Button>
      {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !releaseDispatch.isPending) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.enabled ? 'Liberar despacho v1 desta unidade?' : 'Pausar despacho v1 deste canal?'}</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-3 text-sm">
            <ResponsiveDialogDescription>{confirmation?.enabled
              ? 'A liberação alcança os fatos elegíveis de toda a unidade, inclusive lembretes e pesquisas de recursos existentes; não fica restrita a um contato de teste. Mensagens podem gerar cobrança de Meta/Datafy conforme a conta.'
              : 'Novos envios automáticos deste canal serão pausados. Um envio já confirmado pode concluir e exige acompanhamento; não repita mensagens de resultado incerto.'}</ResponsiveDialogDescription>
            <p>Canal {confirmation?.channelId.slice(0, 8)} · geração {confirmation?.bindingGeneration} · revisão da credencial {confirmation?.credentialRevision}</p>
            <p>A adoção é durável. Pausar preserva adoção, histórico e tentativas em andamento; não retorna ao fluxo legado.</p>
            <p>Esta ação não altera a flag global, os ajustes da loja, o catálogo v1/v2, os consentimentos ou a autorização de custo MARKETING. Esses gates continuam separados.</p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Voltar</Button>
            <Button disabled={busy || query.isError} onClick={() => void confirmChange()}>{confirmation?.enabled ? 'Confirmar liberação v1' : 'Confirmar pausa v1'}</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

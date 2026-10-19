import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';
import { templateErrorMessage, type TemplateControls } from '@/hooks/useWhatsappTemplates';
import { useWhatsappTemplateV2Channel, useWhatsappTemplateV2Policy, v2ChannelMatches, type TemplateV2ChannelPin } from '@/hooks/useWhatsappTemplateV2';

export function TemplateV2ChannelControls({ unitId, controls }: { unitId: string; controls: TemplateControls }) {
  const { query: policy } = useWhatsappTemplateV2Policy();
  const { change, wasAttempted } = useWhatsappTemplateV2Channel(unitId, controls, policy);
  const [confirmation, setConfirmation] = useState<TemplateV2ChannelPin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const snapshot = controls.query.data;
  const selection = snapshot?.catalogSelection;
  const busy = controls.query.isFetching || change.isPending;
  const canSelect = selection?.state === 'v1' && selection.version === 1 && !!selection.digest && !!policy.data;
  const canStop = selection?.state === 'ready' && selection.version === 2 && !!selection.digest;
  let pin: TemplateV2ChannelPin | null = null;
  if (snapshot?.providerLabel === 'Datafy' && snapshot.channelId && snapshot.configuration.bindingGeneration !== null
    && snapshot.configuration.credentialRevision !== null && (canSelect || canStop)) {
    pin = {
      kind: canStop ? 'stop' : 'select', channelId: snapshot.channelId,
      bindingGeneration: snapshot.configuration.bindingGeneration, credentialRevision: snapshot.configuration.credentialRevision,
      digest: canStop ? selection.digest : policy.data.catalogDigest, selectionDigest: selection.digest,
    };
  }
  const unavailable = !controls.canAdministerCatalog || controls.query.isError || busy
    || !pin || (pin.kind === 'select' && (policy.isError || policy.isFetching)) || (pin && wasAttempted(pin));
  useEffect(() => {
    if (confirmation && !locked.current && !change.isPending && (controls.query.isError
      || (confirmation.kind === 'select' && policy.isError) || !v2ChannelMatches(snapshot, confirmation, policy.data))) {
      setConfirmation(null);
      setNotice('A configuração v2 mudou. Atualize os dados antes de confirmar.');
    }
  }, [confirmation, snapshot, controls.query.isError, policy.isError, policy.data, change.isPending]);

  async function confirm() {
    if (!confirmation || busy || locked.current) return;
    if (controls.query.isError || (confirmation.kind === 'select' && policy.isError)
      || !v2ChannelMatches(snapshot, confirmation, policy.data) || wasAttempted(confirmation)) {
      setConfirmation(null); setNotice('A configuração v2 mudou. Atualize os dados antes de confirmar.'); return;
    }
    const confirmedPin = confirmation;
    locked.current = true;
    // The expected refetch changes selection; it must not invalidate a consumed confirmation.
    setConfirmation(null);
    try { await change.mutateAsync(confirmedPin); setNotice('Solicitação v2 registrada. Confira os estados atualizados de cada modelo.'); }
    catch { setNotice('O resultado da solicitação v2 precisa de conferência. Atualize os dados e não repita esta liberação.'); }
    finally { locked.current = false; }
  }

  return <section className="space-y-3 rounded border p-3" aria-label="Liberação dos modelos v2 desta conta">
    <h3 className="font-medium">Modelos v2 desta conta WhatsApp</h3>
    <p>Liberação manual para uma conta existente, independente da política de futuras conexões. Os modelos v1 e o envio automático são preservados.</p>
    {policy.isPending ? <p role="status">Consultando o catálogo v2 aprovado…</p>
      : policy.isError ? <p role="alert">{templateErrorMessage(policy.error)}</p>
        : policy.data && <p>Catálogo v2 · revisão da política {policy.data.revision} · digest <code className="break-all text-xs">{policy.data.catalogDigest}</code></p>}
    <p role="status">{selection?.state === 'ready' ? 'Catálogo v2 liberado para esta conta.'
      : selection?.state === 'v1' ? 'Esta conta mantém o catálogo v1 para novas submissões.'
        : selection?.state === 'pending' ? 'A seleção do catálogo v2 está pendente.'
          : selection?.state === 'paused' ? 'Novas submissões v2 estão pausadas; a equipe deve conferir a liberação.'
            : 'Não foi possível confirmar a seleção de catálogo desta conta.'}</p>
    {pin && <Button variant={pin.kind === 'stop' ? 'outline' : 'default'} disabled={unavailable} onClick={() => {
      if (unavailable) return;
      change.reset(); setNotice(null); setConfirmation(pin);
    }}>{pin.kind === 'stop' ? 'Revogar novas submissões v2' : 'Liberar os nove modelos v2 nesta conta'}</Button>}
    {pin && wasAttempted(pin) && <p role="status">Esta solicitação já foi tentada. Confira o estado atual antes de qualquer outra operação.</p>}
    {notice && <p role={change.isSuccess ? 'status' : 'alert'}>{notice}</p>}
    <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !change.isPending) setConfirmation(null); }}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.kind === 'stop' ? 'Revogar novas submissões v2?' : 'Liberar nove modelos v2 nesta conta?'}</ResponsiveDialogTitle></ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-2 text-sm">
          <ResponsiveDialogDescription>{confirmation?.kind === 'stop'
            ? 'Novas submissões v2 deste canal serão bloqueadas. Uma submissão já confirmada pode chegar à Meta. Os registros v1 e v2 já existentes serão preservados.'
            : 'Esta conta WhatsApp passará a preparar os nove textos v2 para análise pela Meta. A escolha alcança a conta compartilhada pelos canais vinculados; os modelos v1 já existentes serão preservados. A Meta pode aprovar ou recusar cada modelo.'}</ResponsiveDialogDescription>
          <p>Canal {confirmation?.channelId.slice(0, 8)} · geração {confirmation?.bindingGeneration} · revisão da credencial {confirmation?.credentialRevision}</p>
          <p>Digest v2 <code className="break-all text-xs">{confirmation?.digest}</code></p>
          <p>Nenhuma mensagem será enviada a clientes por esta ação; o despacho não é habilitado. Assinatura Datafy e tarifas de mensagens Meta são separadas; o preço da submissão de modelos não está confirmado.</p>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter><Button variant="outline" disabled={change.isPending} onClick={() => setConfirmation(null)}>Voltar</Button><Button disabled={busy || (confirmation?.kind === 'select' && policy.isFetching)} onClick={() => void confirm()}>{confirmation?.kind === 'stop' ? 'Confirmar revogação v2' : 'Confirmar liberação v2'}</Button></ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';
import { autoPolicyErrorMessage, autoPolicyMatches, useWhatsappTemplateAutoPolicy, type TemplateAutoPolicyPin } from '@/hooks/useWhatsappTemplateAutoPolicy';

/** Platform administration only; the EF and authenticated SQL RPC enforce that role. */
export function TemplateAutoPolicyCard() {
  const { query, change } = useWhatsappTemplateAutoPolicy();
  const [confirmation, setConfirmation] = useState<TemplateAutoPolicyPin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const policy = query.data;
  const busy = query.isFetching || change.isPending;

  useEffect(() => {
    if (confirmation && !locked.current && !change.isPending && (query.isError || !autoPolicyMatches(policy, confirmation))) {
      setConfirmation(null);
      setNotice('A política mudou. Atualize os dados antes de confirmar.');
    }
  }, [confirmation, query.isError, change.isPending, policy]);

  function openConfirmation() {
    if (busy || !policy || query.isError) return;
    change.reset();
    setNotice(null);
    setConfirmation({ enabled: policy.enabled, revision: policy.revision, catalogDigest: policy.catalogDigest });
  }

  async function confirmChange() {
    if (!confirmation || busy || locked.current) return;
    if (query.isError || !autoPolicyMatches(policy, confirmation)) {
      setConfirmation(null);
      setNotice('A política mudou. Atualize os dados antes de confirmar.');
      return;
    }
    locked.current = true;
    try { await change.mutateAsync(confirmation); setConfirmation(null); }
    catch { /* The typed error remains visible in the dialog. */ }
    finally { locked.current = false; }
  }

  return <Card>
    <CardHeader><CardTitle className="text-base">Preparação automática dos modelos Datafy</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">Esta política vale para novas conexões Datafy de todas as organizações. Conexões e onboardings já existentes não são inscritos retroativamente.</p>
      {query.isPending ? <p role="status">Consultando política dos modelos…</p>
        : query.isError || !policy ? <div role="alert" className="space-y-2"><p>{autoPolicyErrorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>
        : <>
          <p role="status" className={policy.enabled ? 'text-success' : 'text-muted-foreground'}>Política {policy.enabled ? 'ativada' : 'desativada'} · revisão {policy.revision}</p>
          <p>Catálogo versão 1 · digest dos nove modelos aprovados: <code className="break-all text-xs">{policy.catalogDigest}</code></p>
          <p className="text-muted-foreground">{policy.enabled ? 'Novos onboardings elegíveis podem preparar nove modelos para análise da Meta.' : 'Novos onboardings não recebem liberação automática do catálogo.'} Isso não ativa automações nem envia mensagens a clientes.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} variant={policy.enabled ? 'outline' : 'default'} onClick={openConfirmation}>{policy.enabled ? 'Revogar política global' : 'Ativar para futuras conexões'}</Button>
            <Button disabled={query.isFetching} variant="outline" onClick={() => void query.refetch()}>Atualizar dados</Button>
          </div>
        </>}
      {notice && <p role="alert">{notice}</p>}
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !change.isPending) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.enabled ? 'Revogar preparação automática global?' : 'Ativar preparação automática global?'}</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2 text-sm">
            {confirmation?.enabled ? <ResponsiveDialogDescription>Novas inscrições e confirmações de submissão automática serão bloqueadas. Uma submissão já confirmada pode chegar à Meta.</ResponsiveDialogDescription>
              : <ResponsiveDialogDescription>Novos onboardings Datafy criados depois desta ativação, em todas as organizações, poderão submeter os nove modelos aprovados à análise da Meta. Canais e onboardings antigos não serão inscritos.</ResponsiveDialogDescription>}
            <p>Revisão atual: {confirmation?.revision}. A submissão dos modelos não tem tarifa confirmada; mensagens de template enviadas pela Meta têm cobrança separada. Esta ação não ativa o envio a clientes.</p>
            {change.isError && <p role="alert">{autoPolicyErrorMessage(change.error)}</p>}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button variant="outline" disabled={change.isPending} onClick={() => setConfirmation(null)}>Voltar</Button>
            <Button disabled={busy || !policy} onClick={() => void confirmChange()}>Confirmar</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

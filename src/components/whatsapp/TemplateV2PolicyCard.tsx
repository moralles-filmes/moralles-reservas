import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';
import { templateErrorMessage } from '@/hooks/useWhatsappTemplates';
import { useWhatsappTemplateV2Policy, v2PolicyMatches, type TemplateV2PolicyPin } from '@/hooks/useWhatsappTemplateV2';

export function TemplateV2PolicyCard() {
  const { query, change } = useWhatsappTemplateV2Policy();
  const [confirmation, setConfirmation] = useState<TemplateV2PolicyPin | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const policy = query.data;
  const busy = query.isFetching || change.isPending;
  useEffect(() => {
    if (confirmation && !locked.current && !change.isPending && (query.isError || !v2PolicyMatches(policy, confirmation))) {
      setConfirmation(null);
      setNotice('A política v2 mudou. Atualize os dados antes de confirmar.');
    }
  }, [confirmation, policy, query.isError, change.isPending]);

  async function confirm() {
    if (!confirmation || busy || locked.current) return;
    if (query.isError || !v2PolicyMatches(policy, confirmation)) {
      setConfirmation(null);
      setNotice('A política v2 mudou. Atualize os dados antes de confirmar.');
      return;
    }
    locked.current = true;
    try { await change.mutateAsync(confirmation); setConfirmation(null); }
    catch { /* Typed failure remains visible for review. */ }
    finally { locked.current = false; }
  }

  return <Card>
    <CardHeader><CardTitle className="text-base">Modelos v2 para futuras conexões Datafy</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">Política separada da versão 1. Vale para novas conexões Datafy de todas as organizações; contas e canais existentes precisam de liberação própria.</p>
      {query.isPending ? <p role="status">Consultando política v2…</p>
        : query.isError || !policy ? <div role="alert" className="space-y-2"><p>{templateErrorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>
        : <>
          <p role="status">Política v2 {policy.enabled ? 'ativada' : 'desativada'} · revisão {policy.revision}</p>
          <p>Digest dos nove modelos v2: <code className="break-all text-xs">{policy.catalogDigest}</code></p>
          <p>A preparação e a análise pela Meta não ativam automações nem enviam mensagens a clientes.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} variant={policy.enabled ? 'outline' : 'default'} onClick={() => {
              if (query.isError || busy) return;
              change.reset(); setNotice(null);
              setConfirmation({ enabled: policy.enabled, revision: policy.revision, catalogDigest: policy.catalogDigest });
            }}>{policy.enabled ? 'Revogar política futura v2' : 'Ativar v2 para futuras conexões'}</Button>
            <Button disabled={query.isFetching} variant="outline" onClick={() => void query.refetch()}>Atualizar política v2</Button>
          </div>
        </>}
      {notice && <p role="alert">{notice}</p>}
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !change.isPending) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.enabled ? 'Revogar política futura v2?' : 'Ativar v2 em futuras conexões?'}</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2 text-sm">
            <ResponsiveDialogDescription>{confirmation?.enabled
              ? 'Novas inscrições e confirmações automáticas v2 serão bloqueadas. Uma submissão já confirmada pode chegar à Meta. Liberações manuais por conta são independentes.'
              : 'Novos onboardings Datafy criados após esta ativação, em todas as organizações, poderão submeter os nove modelos v2 à Meta. Canais e contas existentes não serão promovidos automaticamente.'}</ResponsiveDialogDescription>
            <p>Revisão {confirmation?.revision} · digest <code className="break-all text-xs">{confirmation?.catalogDigest}</code></p>
            <p>Esta ação não habilita envio a clientes. Assinatura Datafy e tarifas de mensagens Meta são separadas; o preço da submissão de modelos não está confirmado.</p>
            {change.isError && <p role="alert">{templateErrorMessage(change.error)}</p>}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter><Button variant="outline" disabled={change.isPending} onClick={() => setConfirmation(null)}>Voltar</Button><Button disabled={busy || !policy} onClick={() => void confirm()}>Confirmar política v2</Button></ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWhatsappTemplates, templateErrorMessage } from '@/hooks/useWhatsappTemplates';
import { useWhatsappTemplateDispatchVersions } from '@/hooks/useWhatsappTemplateDispatchVersions';
import { dispatchCategory, dispatchKindLabels, dispatchVersionMatches, dispatchVersionReasonLabels,
  type DispatchVersionEntry, type DispatchVersionPin } from '@/features/whatsapp/template-dispatch-versions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription,
  ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';

export function TemplateDispatchVersionAdminCard({ unitId }: { unitId: string }) {
  const { user, loading, isPlatformAdmin } = useAuth();
  if (loading || !user || !isPlatformAdmin) return null;
  return <DispatchVersionSession key={`${user.id}:${unitId}`} unitId={unitId} actorId={user.id} />;
}

function DispatchVersionSession({ unitId, actorId }: { unitId: string; actorId: string }) {
  const templates = useWhatsappTemplates(unitId, null, true);
  const base = templates.query.data;
  const configuration = base?.configuration;
  const channel = useMemo(() => !templates.query.isError && base?.mode === 'official' && base.providerLabel === 'Datafy'
    && base.channelId && configuration.bindingGeneration !== null && configuration.credentialRevision !== null
    ? { channelId: base.channelId, generation: configuration.bindingGeneration, credentialRevision: configuration.credentialRevision } : null,
  [base?.mode, base?.providerLabel, base?.channelId, configuration?.bindingGeneration, configuration?.credentialRevision, templates.query.isError]);
  const { query, select, wasAttempted } = useWhatsappTemplateDispatchVersions(unitId, actorId, channel, templates.canAdministerDispatch);
  const [confirmation, setConfirmation] = useState<DispatchVersionPin | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const locked = useRef(false);
  const busy = templates.query.isFetching || query.isFetching || select.isPending;

  useEffect(() => {
    if (confirmation && !locked.current && !select.isPending
      && (templates.query.isError || query.isError || !channel || !dispatchVersionMatches(query.data, confirmation))) {
      setConfirmation(null);
      setNotice({ text: 'A preferência ou o canal mudou. Atualize os dados antes de confirmar.', error: true });
    }
  }, [channel, confirmation, query.data, query.isError, select.isPending, templates.query.isError]);

  function makePin(entry: DispatchVersionEntry, version: 1 | 2): DispatchVersionPin {
    return { bindingId: query.data.binding_id, channelId: query.data.channel_id,
      generation: query.data.generation, credentialRevision: query.data.credential_revision,
      kind: entry.kind, version, revision: entry.revision, selectedVersion: entry.selected_version, selectionSource: entry.selection_source };
  }
  function choose(entry: DispatchVersionEntry, version: 1 | 2) {
    if (busy || !channel || locked.current || query.isError || !templates.canAdministerDispatch) return;
    const pin = makePin(entry, version);
    if (!dispatchVersionMatches(query.data, pin) || wasAttempted(pin)) return;
    select.reset(); setNotice(null); setConfirmation(pin);
  }
  async function confirmSelection() {
    if (!confirmation || busy || locked.current) return;
    if (!channel || query.isError || templates.query.isError || !dispatchVersionMatches(query.data, confirmation) || wasAttempted(confirmation)) {
      setConfirmation(null); setNotice({ text: 'A preferência ou o canal mudou. Atualize os dados antes de confirmar.', error: true }); return;
    }
    const pin = confirmation;
    locked.current = true;
    setConfirmation(null);
    try {
      const result = await select.mutateAsync(pin);
      setNotice(result.state === 'selected'
        ? { text: `Preferência v${pin.version} registrada para ${dispatchKindLabels[pin.kind].toLocaleLowerCase('pt-BR')}. Novas intenções seguem os gates de envio.`, error: false }
        : { text: result.state === 'stale' ? 'A preferência mudou. Confira os dados atualizados antes de escolher novamente.'
          : 'A seleção não foi registrada. Confira os modelos e os gates atuais antes de escolher novamente.', error: true });
    } catch (error) {
      setNotice({ text: `${templateErrorMessage(error)} O resultado precisa de conferência. Atualize os dados; não repita sem reconciliar a preferência.`, error: true });
    } finally { locked.current = false; }
  }
  async function refresh() {
    const result = await templates.query.refetch();
    if (result.isSuccess) await query.refetch();
  }

  return <Card>
    <CardHeader><CardTitle>Versão dos avisos automáticos</CardTitle></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p>A preferência vale por finalidade e somente para novas intenções. Mensagens já criadas preservam sua versão; voltar a v1 bloqueia novos POSTs v2 pendentes, sem converter ou reenviar o histórico.</p>
      <p className="text-muted-foreground">Selecionar uma versão não libera despacho, não liga a flag global nem os ajustes da loja e não concede consentimento ou autorização de custo. A liberação e a pausa do despacho permanecem no controle separado.</p>
      <p className="text-muted-foreground">A conta de modelos é resolvida pelo vínculo do canal. Outras unidades que compartilham a conta não herdam esta preferência.</p>
      {templates.query.isPending ? <p role="status">Consultando o canal…</p>
        : templates.query.isError ? <p role="alert">{templateErrorMessage(templates.query.error)}</p>
          : !channel ? <p role="status">A seleção exige um canal Datafy com vínculo e revisões atuais. Atualize os dados do canal.</p>
            : query.isPending ? <p role="status">Consultando as preferências de envio…</p>
              : query.isError || !query.data ? <p role="alert">{templateErrorMessage(query.error)}</p>
                : <>
                  <p>Canal {query.data.channel_id.slice(0, 8)} · vínculo {query.data.binding_id.slice(0, 8)} · geração {query.data.generation} · revisão da credencial {query.data.credential_revision}</p>
                  <ul className="space-y-4" aria-label="Preferências por finalidade">{query.data.entries.map(entry => {
                    const pin = makePin(entry, 1);
                    const fenced = wasAttempted(pin);
                    return <li key={entry.kind} className="space-y-2 rounded border p-3" aria-label={dispatchKindLabels[entry.kind]}>
                      <h3 className="font-medium">{dispatchKindLabels[entry.kind]}</h3>
                      <p>{entry.selected_version === null ? 'Preferência não resolvida: revisão necessária.'
                        : `Preferência atual: v${entry.selected_version}.`} Revisão {entry.revision}.</p>
                      {entry.selection_source === 'auto' && <p>Preferência automática comprovada para novas intenções. Ela pode aguardar aprovação e liberação antes de enviar.</p>}
                      <p>Categoria: {dispatchCategory(entry.kind)}. {dispatchCategory(entry.kind) === 'MARKETING'
                        ? 'A versão 2 exige autorização de custo própria e consentimento promocional individual. Esta seleção não os concede.'
                        : 'Mensagens podem gerar tarifas Meta/Datafy conforme a conta.'}</p>
                      <p>{dispatchVersionReasonLabels[entry.v2_reason_code]}</p>
                      <ul aria-label={`Modelos v2 de ${dispatchKindLabels[entry.kind]}`}>
                        {entry.variants.map(variant => <li key={variant.logical_id}>{variant.logical_id}: {variant.status} · {variant.ready ? 'Conferido' : 'Ainda não disponível'}</li>)}
                      </ul>
                      {entry.kind === 'confirmation' && <p>As duas variantes da confirmação precisam estar conferidas para selecionar v2.</p>}
                      {fenced && <p role="status">Solicitação já tentada. Aguarde uma leitura atualizada que comprove o resultado antes de escolher novamente.</p>}
                      <div className="flex flex-wrap gap-2">{([1, 2] as const).map(version => <Button key={version} variant="outline"
                        disabled={busy || fenced || (version === 2 && !entry.v2_ready) || (entry.selection_source === 'admin' && entry.selected_version === version)}
                        onClick={() => choose(entry, version)}>Selecionar v{version} para {dispatchKindLabels[entry.kind]}</Button>)}</div>
                    </li>;
                  })}</ul>
                </>}
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>Atualizar preferências</Button>
      {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !locked.current) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>Confirmar preferência v{confirmation?.version}?</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-3 text-sm">
            <ResponsiveDialogDescription>Esta ação escolhe o texto para novas intenções da finalidade {confirmation ? dispatchKindLabels[confirmation.kind].toLocaleLowerCase('pt-BR') : ''}. Ela não envia mensagens nem altera jobs existentes.</ResponsiveDialogDescription>
            <p>Canal {confirmation?.channelId.slice(0, 8)} · vínculo {confirmation?.bindingId.slice(0, 8)} · geração {confirmation?.generation} · revisão da credencial {confirmation?.credentialRevision} · revisão da preferência {confirmation?.revision}</p>
            <p>Categoria: {confirmation ? dispatchCategory(confirmation.kind) : ''}. Tarifas dependem da conta. MARKETING v2 requer autorização de custo específica e consentimento individual.</p>
            <p>Despacho do canal, flag global, finalidades da loja e custo continuam separados. Não há fallback automático para outra versão; resultados incertos exigem conferência.</p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Voltar</Button>
            <Button disabled={busy || query.isError || templates.query.isError} onClick={() => void confirmSelection()}>Confirmar preferência</Button></ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

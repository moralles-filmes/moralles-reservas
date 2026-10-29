import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWhatsappOnboardingCatalog } from '@/hooks/useWhatsappOnboardingCatalog';
import { useWhatsappServicePreferences, servicePreferenceErrorMessage } from '@/hooks/useWhatsappServicePreferences';
import {
  SERVICE_KINDS, serviceKindLabels, servicePreferenceMatches, serviceStatus,
  type ServiceKind, type ServicePreferenceEntry, type ServicePreferencePin,
} from '@/features/whatsapp/service-preferences';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogContent, ResponsiveDialogDescription,
  ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle } from '@/components/ui/responsive-dialog';

export function ServiceNoticePreferencesCard({ unitId, unitName, canManage }: {
  unitId: string; unitName: string; canManage: boolean;
}) {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <ServiceNoticeSession key={`${user.id}:${unitId}`} unitId={unitId} unitName={unitName}
    actorId={user.id} canManage={canManage} />;
}

function ServiceNoticeSession({ unitId, unitName, actorId, canManage }: {
  unitId: string; unitName: string; actorId: string; canManage: boolean;
}) {
  const { query, setPreference, syncModels, wasAttempted } = useWhatsappServicePreferences(unitId, actorId);
  const catalog = useWhatsappOnboardingCatalog(canManage ? unitId : '');
  const [confirmation, setConfirmation] = useState<ServicePreferencePin | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const actionBusy = query.isFetching || setPreference.isPending || syncModels.isPending;
  const enableBusy = actionBusy || catalog.isFetching;
  const snapshot = query.data;
  const catalogMatches = !!snapshot?.eligible && !!catalog.data && !catalog.isError
    && catalog.data.channelId === snapshot.channel_id
    && catalog.data.bindingGeneration === snapshot.binding_generation
    && catalog.data.credentialRevision === snapshot.credential_revision;

  function hasExactTexts(kind: ServiceKind): boolean {
    if (!catalogMatches) return false;
    const entry = snapshot?.kinds.find(item => item.kind === kind);
    return !!entry && entry.variants.every(variant => catalog.data!.templates.some(template =>
      template.logicalId === variant.logical_id && template.version === 2));
  }
  function makePin(entry: ServicePreferenceEntry, nextEnabled: boolean): ServicePreferencePin | null {
    if (!snapshot?.channel_id || !snapshot.binding_id || !snapshot.binding_generation
      || snapshot.credential_revision === null) return null;
    return { unitId, channelId: snapshot.channel_id, bindingId: snapshot.binding_id,
      generation: snapshot.binding_generation, credentialRevision: snapshot.credential_revision,
      kind: entry.kind, enabled: entry.enabled, revision: entry.revision, nextEnabled };
  }
  function currentConfirmation(): boolean {
    return canManage && !!snapshot?.can_manage && !!confirmation && servicePreferenceMatches(snapshot, confirmation)
      && (!confirmation.nextEnabled || hasExactTexts(confirmation.kind))
      && !wasAttempted(confirmation);
  }

  useEffect(() => {
    if (confirmation && !locked.current && !setPreference.isPending && !currentConfirmation()) {
      setConfirmation(null);
      setNotice({ text: 'O canal, os modelos ou a preferência mudaram. Atualize os dados antes de confirmar.', error: true });
    }
  // All relevant pins are checked against the latest two authoritative snapshots.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmation, snapshot, catalog.data, query.isError, catalog.isError, setPreference.isPending]);

  function choose(entry: ServicePreferenceEntry, nextEnabled: boolean) {
    if ((nextEnabled ? enableBusy : actionBusy) || !canManage || !snapshot?.can_manage
      || locked.current || query.isError || (nextEnabled && catalog.isError)) return;
    const pin = makePin(entry, nextEnabled);
    if (!pin || !servicePreferenceMatches(snapshot, pin) || wasAttempted(pin)
      || (nextEnabled && !hasExactTexts(entry.kind))) return;
    setPreference.reset(); setNotice(null); setConfirmation(pin);
  }
  async function confirmSelection() {
    if (!confirmation || (confirmation.nextEnabled ? enableBusy : actionBusy) || locked.current) return;
    if (!canManage || !snapshot?.can_manage || query.isError
      || (confirmation.nextEnabled && catalog.isError) || !currentConfirmation()) {
      setConfirmation(null);
      setNotice({ text: 'O canal, os modelos ou a preferência mudaram. Atualize os dados antes de confirmar.', error: true });
      return;
    }
    const pin = confirmation;
    locked.current = true;
    setConfirmation(null);
    try {
      await setPreference.mutateAsync(pin);
      if (alive.current) setNotice({ text: `${serviceKindLabels[pin.kind]} ${pin.nextEnabled ? 'habilitado para novos fatos elegíveis' : 'desligado para novos envios'}. Confira o estado atualizado.`, error: false });
    } catch (error) {
      if (alive.current) setNotice({ text: `${servicePreferenceErrorMessage(error)} O resultado precisa ser conferido antes de repetir a ação.`, error: true });
    } finally { locked.current = false; }
  }
  async function requestModelSync() {
    if (enableBusy || !canManage || !snapshot?.can_manage || !snapshot.rollout_ready) return;
    setNotice(null);
    try {
      const result = await syncModels.mutateAsync();
      if (alive.current) setNotice({ text: result.status === 'requested'
        ? 'Atualização solicitada. A conferência dos modelos pode levar alguns minutos; acompanhe os estados nesta página.'
        : 'A atualização não está disponível agora. Confira os estados novamente mais tarde.', error: result.status !== 'requested' });
    } catch (error) {
      if (alive.current) setNotice({ text: servicePreferenceErrorMessage(error), error: true });
    }
  }

  if (query.isPending) return <Card><CardContent className="py-6"><p role="status">Consultando os avisos de serviço…</p></CardContent></Card>;
  if (query.isError || !snapshot) return <Card><CardHeader><CardTitle>Modelos e avisos</CardTitle></CardHeader><CardContent className="space-y-3">
    <p role="alert">{servicePreferenceErrorMessage(query.error)}</p>
    <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>Tentar novamente</Button>
  </CardContent></Card>;
  // Existing manual cohorts, including Ren Sushi, retain their current controls.
  if (!snapshot.auto_cohort) return null;

  return <Card>
    <CardHeader><CardTitle>Modelos e avisos</CardTitle></CardHeader>
    <CardContent className="space-y-5 text-sm">
      <p>Os modelos oficiais são enviados para análise da Meta após a conexão. Escolha quais avisos de serviço esta unidade enviará. Todos começam desligados; a aprovação dos modelos não liga o envio.</p>
      {!snapshot.rollout_ready && <p role="alert">A configuração dos avisos está temporariamente indisponível. Aguarde a publicação completa e confira novamente.</p>}
      {!snapshot.global_dispatch_enabled && <p role="alert">O envio automático de avisos foi pausado pela plataforma. Você pode desligar avisos já habilitados; novas habilitações aguardam a liberação da plataforma.</p>}
      {snapshot.admin_paused && <p role="alert">O envio deste canal foi pausado pela plataforma. Você pode desligar avisos já habilitados; a habilitação depende da liberação pela plataforma.</p>}
      {!snapshot.eligible && <p role="status">Esta conexão oficial ainda está preparando os modelos v2. Os avisos permanecem desligados até a preparação terminar.</p>}
      {canManage && !catalogMatches && <p role="alert">Não foi possível conferir os textos do canal atual. Atualize os dados antes de habilitar avisos.</p>}
      <ul aria-label="Avisos de serviço" className="space-y-3">{SERVICE_KINDS.map(kind => {
        const entry = snapshot.kinds.find(item => item.kind === kind)!;
        const pin = makePin(entry, !entry.enabled);
        const fenced = !!pin && wasAttempted(pin);
        const exactTexts = hasExactTexts(kind);
        const actionAvailable = canManage && snapshot.can_manage && snapshot.auto_cohort
          && !(pin?.nextEnabled ? enableBusy : actionBusy) && !!pin && !fenced && !query.isError
          && (!pin.nextEnabled || snapshot.eligible && snapshot.rollout_ready && snapshot.global_dispatch_enabled && !snapshot.admin_paused && entry.ready
            && snapshot.provider_subscription_confirmed && exactTexts && !catalog.isError);
        const texts = entry.variants.flatMap(variant => catalogMatches ? catalog.data!.templates.filter(template =>
          template.logicalId === variant.logical_id && template.version === 2) : []);
        return <li key={kind} className="rounded-lg border p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1"><h3 className="font-medium">{serviceKindLabels[kind]}</h3>
              <p role="status" className="text-muted-foreground">{serviceStatus(entry, {
                rolloutReady: snapshot.rollout_ready,
                eligible: snapshot.eligible,
                providerSubscriptionConfirmed: snapshot.provider_subscription_confirmed,
                globalDispatchEnabled: snapshot.global_dispatch_enabled,
                adminPaused: snapshot.admin_paused,
              })}</p></div>
            <Switch aria-label={`${entry.enabled ? 'Desligar' : 'Habilitar'} ${serviceKindLabels[kind]}`}
              checked={entry.enabled} disabled={!actionAvailable}
              onCheckedChange={checked => choose(entry, checked)} />
          </div>
          {kind === 'confirmation' && <p>As duas versões de confirmação precisam estar aprovadas para habilitar este aviso.</p>}
          {!entry.ready && <p className="text-muted-foreground">{entry.variants.map(variant => `${variant.logical_id}: ${variant.status}`).join(' · ')}</p>}
          {fenced && <p role="status">A escolha anterior precisa ser conferida. Atualize os dados; não repita sem reconciliação.</p>}
          {canManage && <details><summary className="cursor-pointer font-medium">Ver {texts.length > 1 ? 'textos oficiais' : 'texto oficial'}</summary>
            {texts.length > 0 ? <ul className="mt-3 space-y-3">{texts.map(template => <li key={template.logicalId} className="rounded border p-3">
              {texts.length > 1 && <p className="mb-2 font-medium">{template.logicalId.includes('desconto') ? 'Com desconto' : 'Padrão'}</p>}
              <p className="whitespace-pre-wrap break-words">{template.body}</p>
              {template.footer && <p className="mt-2 text-muted-foreground whitespace-pre-wrap">{template.footer}</p>}
            </li>)}</ul> : <p role="alert" className="mt-2">Texto oficial indisponível nesta leitura.</p>}
          </details>}
        </li>;
      })}</ul>
      <section className="rounded-lg border p-4 space-y-2" aria-label="Marketing">
        <h3 className="font-medium">Marketing</h3>
        <p>Pesquisa da fila e voucher programado são gerenciados separadamente. Exigem consentimento dos clientes e autorização de custo própria; estes controles de serviço não os habilitam.</p>
      </section>
      {(!canManage || !snapshot.can_manage) && <p>Você pode consultar os avisos, mas apenas proprietário ou gerente pode alterá-los.</p>}
      {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" disabled={actionBusy} onClick={() => {
          void query.refetch();
          if (canManage) void catalog.refetch();
        }}>Atualizar avisos</Button>
        {canManage && snapshot.can_manage && <Button variant="outline" className="min-h-11" disabled={enableBusy || !snapshot.rollout_ready || !snapshot.eligible}
          onClick={() => void requestModelSync()}>Atualizar modelos na Meta</Button>}
      </div>
      <ResponsiveDialog open={confirmation !== null} onOpenChange={open => { if (!open && !locked.current) setConfirmation(null); }}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation?.nextEnabled ? 'Habilitar' : 'Desligar'} {confirmation ? serviceKindLabels[confirmation.kind] : 'aviso'}?</ResponsiveDialogTitle></ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-3 text-sm">
            <ResponsiveDialogDescription>{confirmation?.nextEnabled
              ? 'Os próximos fatos elegíveis desta finalidade poderão gerar mensagens para todos os clientes envolvidos, sem limite de um contato. Fatos anteriores não são reenviados.'
              : 'Novos envios desta finalidade serão interrompidos. Mensagens já aceitas ou com resultado incerto permanecem para reconciliação.'}</ResponsiveDialogDescription>
            <p>Unidade: <strong>{unitName}</strong>. Canal Datafy {confirmation?.channelId.slice(0, 8)} · vínculo {confirmation?.bindingId.slice(0, 8)} · geração {confirmation?.generation} · revisão {confirmation?.revision}.</p>
            <p>Assinatura Datafy: {snapshot.provider_subscription_confirmed ? 'já contratada' : 'não confirmada'}. Valor da assinatura não disponível nesta tela; esta ação não contrata uma nova assinatura.</p>
            <p>A Meta pode cobrar por mensagem de serviço entregue. A tarifa varia por destino e condições da conta, e não há limite de um contato nesta escolha.</p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter><Button variant="outline" disabled={confirmation?.nextEnabled ? enableBusy : actionBusy} onClick={() => setConfirmation(null)}>Voltar</Button>
            <Button disabled={(confirmation?.nextEnabled ? enableBusy : actionBusy) || !currentConfirmation()} onClick={() => void confirmSelection()}>Confirmar {confirmation?.nextEnabled ? 'habilitação' : 'desativação'}</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}

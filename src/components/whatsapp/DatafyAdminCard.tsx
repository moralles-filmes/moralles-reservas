import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogBody, ResponsiveDialogFooter } from "@/components/ui/responsive-dialog";
import { useOfficialConnection } from "@/hooks/useOfficialConnection";
import { invokeManageChannels } from "@/hooks/useWhatsAppChannels";
import { OFFICIAL_ITEM_COPY } from "@/features/whatsapp/official-checklist-copy";
import { deriveOfficialChecklist } from "../../../supabase/functions/_shared/datafy-onboarding-core";
import type { WhatsAppChannel } from "@/types/reserva";
import { toast } from "sonner";

type Action = "grant_official_connection" | "revoke_official_connection" | "datafy_subscribe" | "datafy_cancel" | "datafy_pause" | "datafy_resume";
interface Candidate { name: string; expectedDatafyChannelId: string; idPrefix: string; subscribed: boolean; paused: boolean; webhookHosts: string[] }
const LABELS: Record<Action, string> = { grant_official_connection: "Liberar conexão oficial", revoke_official_connection: "Revogar liberação", datafy_subscribe: "Assinar canal", datafy_cancel: "Cancelar assinatura", datafy_pause: "Pausar canal", datafy_resume: "Retomar canal" };
function displayTimestamp(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pt-BR") : "Não disponível";
}

export function DatafyAdminCard({ unitId, channels }: { unitId: string; channels: WhatsAppChannel[] }) {
  return <DatafyAdminSession key={unitId} unitId={unitId} channels={channels} />;
}

function DatafyAdminSession({ unitId, channels }: { unitId: string; channels: WhatsAppChannel[] }) {
  const connection = useOfficialConnection(unitId);
  const client = useQueryClient();
  const alive = useRef(false);
  const locked = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [confirmation, setConfirmation] = useState<{ action: Action; channelId?: string } | null>(null);
  const [preview, setPreview] = useState<{ channelId: string; candidates: Candidate[] } | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      // Normalize errors: provider replies never enter the mutation error cache.
      try {
        const response = await invokeManageChannels({ ...body, unit_id: unitId });
        if (response?.code) throw new Error("DATAFY_ACTION_INCOMPLETE");
        if (body.phase === "preview") return { candidates: (response?.candidates ?? []).map((item: Candidate) => ({
          name: item.name, expectedDatafyChannelId: item.expectedDatafyChannelId, idPrefix: item.idPrefix,
          subscribed: item.subscribed === true, paused: item.paused === true, webhookHosts: item.webhookHosts,
        })) as Candidate[] };
        return null;
      } catch { throw new Error("Não foi possível atualizar a conexão oficial. Atualize o estado antes de tentar novamente."); }
    },
    onSettled: () => Promise.all(["official-connection", "whatsapp-channels", "whatsapp-health", "whatsapp-connection"].map((key) => client.invalidateQueries({ queryKey: [key, unitId] }))),
  });
  async function run(body: Record<string, unknown>) {
    if (locked.current || !alive.current) return;
    locked.current = true;
    try {
      const result = await mutation.mutateAsync(body);
      if (!alive.current) return;
      setConfirmation(null);
      if (body.phase === "preview") { setPreview({ channelId: body.channel_id as string, candidates: result?.candidates ?? [] }); setCandidate(null); setName(""); }
      else { setPreview(null); toast.success("Conexão oficial atualizada."); }
    } catch (error) { if (alive.current) toast.error((error as Error).message); }
    finally { locked.current = false; }
  }
  const disabled = mutation.isPending || connection.isLoading || connection.isError;
  return <Card><CardHeader><CardTitle>WhatsApp oficial (Datafy)</CardTitle></CardHeader><CardContent className="space-y-4">
    {connection.isError ? <Button variant="outline" onClick={() => connection.refetch()}>Tentar carregar liberação novamente</Button> : <Button disabled={disabled || !connection.data} onClick={() => setConfirmation({ action: connection.data?.granted ? "revoke_official_connection" : "grant_official_connection" })}>{connection.data?.granted ? LABELS.revoke_official_connection : LABELS.grant_official_connection}</Button>}
    {channels.filter((channel) => channel.provider === "datafy").map((channel) => {
      const checklist = deriveOfficialChecklist({ grantActive: connection.data?.granted === true, onboardingState: connection.data?.onboardingState ?? null,
        channel: { status: channel.status, isActive: channel.is_active, subscribedAt: channel.provider_subscribed_at ?? null,
          echoVerifiedAt: channel.manual_echo_verified_at, activationRequestedAt: channel.activation_requested_at }, automationDispatchAdopted: connection.data?.templatesPending === false });
      const subscribedEpoch = Date.parse(channel.provider_subscribed_at ?? "");
      const hours = Number.isFinite(subscribedEpoch) ? Math.max(0, Math.floor((Date.now() - subscribedEpoch) / 3_600_000)) : null;
      const mode = channel.ingestion_mode_effective;
      return <section key={channel.id} className="space-y-3 rounded-lg border p-4" aria-label={`Canal Datafy ${channel.id.slice(0, 8)}`}>
        <p className="font-medium">Canal {channel.id.slice(0, 8)} · {channel.display_phone ?? "Sem telefone"}</p>
        <ul className="text-sm space-y-1">{checklist.items.map((item) => <li key={item.id}>{item.done ? "Concluído" : "Pendente"}: {OFFICIAL_ITEM_COPY[item.id]}</li>)}</ul>
        {checklist.templatesPending && <p className="text-sm text-muted-foreground">Templates de automação pendentes.</p>}
        <p className="text-sm">Ingestão efetiva: {mode === "async" ? "Assíncrona" : mode === "sync" ? "Síncrona" : mode === "unknown" ? "Desconhecida (processamento bloqueado)" : "Não disponível"}</p>
        <p className="text-sm">Intenção de ativação: {channel.activation_requested_at ? displayTimestamp(channel.activation_requested_at) : "Não solicitada"}</p>
        {channel.provider_paused_at && <p className="text-sm">Pausado em {displayTimestamp(channel.provider_paused_at)}</p>}
        {channel.provider_subscription_canceled_at && <p className="text-sm">Assinatura cancelada em {displayTimestamp(channel.provider_subscription_canceled_at)}</p>}
        {checklist.step === "awaiting_echo" && !channel.manual_echo_verified_at && hours !== null && <p className="text-sm">{hours >= 24 ? `Assinado há ${hours} h sem mensagem do app. Confirme com o lojista se o número está no app WhatsApp Business; se for um número só de API, ele nunca vai ativar: cancele a assinatura.` : `Assinado há ${hours} h. Aguardando mensagem do app WhatsApp Business.`}</p>}
        <div className="flex flex-wrap gap-2">{(["datafy_subscribe", "datafy_cancel", "datafy_pause", "datafy_resume"] as Action[]).map((action) => <Button key={action} variant="outline" disabled={disabled} onClick={() => setConfirmation({ action, channelId: channel.id })}>{LABELS[action]}</Button>)}
          <Button variant="outline" disabled={disabled} onClick={() => run({ action: "datafy_link_existing", channel_id: channel.id, phase: "preview" })}>Buscar canal existente</Button>
        </div>
      </section>;
    })}
    <ResponsiveDialog open={!!confirmation} onOpenChange={(open) => { if (!open && !mutation.isPending) setConfirmation(null); }}><ResponsiveDialogContent aria-describedby={undefined}><ResponsiveDialogHeader><ResponsiveDialogTitle>{confirmation && LABELS[confirmation.action]}?</ResponsiveDialogTitle></ResponsiveDialogHeader><ResponsiveDialogBody>
      {confirmation?.action === "datafy_cancel" || confirmation?.action === "datafy_pause" ? "Ao confirmar, o número para de enviar e receber." : confirmation?.action === "revoke_official_connection" ? "A loja perde a liberação para concluir uma nova conexão. Esta ação não cancela uma assinatura remota existente." : confirmation?.action === "datafy_subscribe" ? "A assinatura gera custo no provedor. Confirme a contratação para este canal." : "Confirme a alteração para esta unidade."}
    </ResponsiveDialogBody><ResponsiveDialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => setConfirmation(null)}>Voltar</Button><Button disabled={mutation.isPending} onClick={() => confirmation && run({ action: confirmation.action, ...(confirmation.channelId ? { channel_id: confirmation.channelId } : {}) })}>Confirmar</Button></ResponsiveDialogFooter></ResponsiveDialogContent></ResponsiveDialog>
    <ResponsiveDialog open={!!preview} onOpenChange={(open) => { if (!open && !mutation.isPending) setPreview(null); }}><ResponsiveDialogContent aria-describedby={undefined}><ResponsiveDialogHeader><ResponsiveDialogTitle>Vincular canal existente</ResponsiveDialogTitle></ResponsiveDialogHeader><ResponsiveDialogBody className="space-y-4">
      {preview?.candidates.length === 0 && <p>Nenhum canal compatível encontrado.</p>}
      {preview?.candidates.map((item) => <div key={item.expectedDatafyChannelId} className="border rounded p-3 space-y-2"><p>{item.name} · {item.idPrefix}</p><p>Assinatura: {item.subscribed ? "Confirmada" : "Ausente"} · {item.paused ? "Pausado" : "Não pausado"}</p><p>Hosts dos webhooks: {item.webhookHosts.join(", ") || "Nenhum"}</p><Button variant="outline" disabled={mutation.isPending} onClick={() => { setCandidate(item); setName(""); }}>Selecionar {item.name}</Button></div>)}
      {candidate && <div className="space-y-2"><Label htmlFor="datafy-confirm-name">Digite o nome do canal: {candidate.name}</Label><Input id="datafy-confirm-name" value={name} onChange={(event) => setName(event.target.value)} /></div>}
    </ResponsiveDialogBody><ResponsiveDialogFooter><Button disabled={mutation.isPending || !candidate || name !== candidate.name} onClick={() => preview && candidate && run({ action: "datafy_link_existing", phase: "link", channel_id: preview.channelId, expected_datafy_channel_id: candidate.expectedDatafyChannelId })}>Confirmar vínculo</Button></ResponsiveDialogFooter></ResponsiveDialogContent></ResponsiveDialog>
  </CardContent></Card>;
}

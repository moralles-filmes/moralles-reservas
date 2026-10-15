import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useUnitBySlug } from "@/hooks/useAllUnits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CreditCard,
  Copy,
  ExternalLink,
  Inbox,
  Info,
  KeyRound,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import {
  useWhatsAppChannels,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
  useTestChannel,
  useRotateChannelSecret,
  useConnectChannel,
  useRefreshChannelStatus,
  useBeginChannelSwitch,
  useWhatsAppProviderMetadata,
  type ChannelConnectionResponse,
  type ChannelCredentials,
  type WhatsAppProviderMetadata,
} from "@/hooks/useWhatsAppChannels";
import {
  useAiProviderKeys,
  useUpsertAiProviderKey,
  useDeleteAiProviderKey,
} from "@/hooks/useAiProviderKeys";
import {
  useStripeAccount,
  useConnectStripe,
  useCheckStripeStatus,
  useDisconnectStripe,
} from "@/hooks/useStripeAccount";
import { useWhatsAppHealth } from "@/hooks/useWhatsAppHealth";
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogBody } from "@/components/ui/responsive-dialog";
import { DatafyAdminCard } from "@/components/whatsapp/DatafyAdminCard";
import { WhatsappServiceBanner } from "@/components/billing/WhatsappServiceBanner";
import type { WhatsAppChannel, WhatsAppProvider } from "@/types/reserva";
import { formatPhone } from "@/lib/utils";
import { describeInboundBacklog } from "@/lib/whatsapp-inbound-backlog";
/**
 * Núcleo puro do backend (sem Deno-only deps — `whatsapp-provider-core.ts` só
 * importa `phone.ts`, que também é puro). Import relativo fora de `src/` é o
 * mesmo padrão já validado por `src/pages/platform/WhatsappImplementations.tsx`
 * (documentado no CLAUDE.md). Decide QUAL segredo autentica o webhook de cada
 * provider — nunca decidir isso por nome de provider no call site, é assim que
 * o próximo provider Meta-shaped entra sem ninguém notar.
 */
import { WEBHOOK_SIGNATURE_SCHEME } from "../../../supabase/functions/_shared/whatsapp-provider-core";
import {
  MODELS_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  type AIProvider,
} from "@/lib/aiModels";

// ─── AI provider config ────────────────────────────────────────────────────────

interface AIConfig {
  provider: AIProvider;
  models: Partial<Record<AIProvider, string>>;
}

const PROVIDERS: Array<{
  id: AIProvider;
  label: string;
  envKey: string;
}> = [
  { id: "claude", label: "Claude (Anthropic)", envKey: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI (ChatGPT)", envKey: "OPENAI_API_KEY" },
  { id: "gemini", label: "Gemini (Google)", envKey: "GEMINI_API_KEY" },
  { id: "grok", label: "Grok (xAI)", envKey: "GROK_API_KEY" },
  { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY" },
];

const PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  zapi: "Z-API",
  uazapi: "UazAPI",
  waha: "WAHA (self-hosted)",
  official: "API Oficial (Meta)",
  datafy: "Datafy (API Oficial)",
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  connected: { label: "Conectado", icon: <Wifi className="h-3 w-3" />, className: "text-success bg-success/10 border-success/20" },
  disconnected: { label: "Desconectado", icon: <WifiOff className="h-3 w-3" />, className: "text-muted-foreground bg-muted" },
  not_configured: { label: "Não configurado", icon: <WifiOff className="h-3 w-3" />, className: "text-muted-foreground bg-muted" },
  provisioning: { label: "Preparando", icon: <RefreshCw className="h-3 w-3 animate-spin" />, className: "text-info bg-info/10 border-info/20" },
  waiting_qr: { label: "Aguardando QR", icon: <Phone className="h-3 w-3" />, className: "text-info bg-info/10 border-info/20" },
  connecting: { label: "Conectando", icon: <RefreshCw className="h-3 w-3 animate-spin" />, className: "text-info bg-info/10 border-info/20" },
  reconnecting: { label: "Reconectando", icon: <RefreshCw className="h-3 w-3 animate-spin" />, className: "text-info bg-info/10 border-info/20" },
  suspended: { label: "Suspenso", icon: <WifiOff className="h-3 w-3" />, className: "text-warning bg-warning/10 border-warning/20" },
  provider_error: { label: "Erro do provider", icon: <WifiOff className="h-3 w-3" />, className: "text-destructive bg-destructive/10 border-destructive/20" },
  switching_provider: { label: "Preparando troca", icon: <RefreshCw className="h-3 w-3 animate-spin" />, className: "text-info bg-info/10 border-info/20" },
  error: { label: "Erro", icon: <WifiOff className="h-3 w-3" />, className: "text-destructive bg-destructive/10 border-destructive/20" },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Automacao() {
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const { data: unit, isLoading } = useUnitBySlug(unitSlug);
  const unitId = unit?.id ?? "";

  if (isLoading) {
    return (
      <div className="space-y-3 max-w-3xl">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!unit) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Button asChild variant="ghost" size="sm" className="gap-1 -ml-2">
          <Link to="/platform/automacao">
            <ArrowLeft className="h-4 w-4" />
            Voltar para unidades
          </Link>
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Unidade não encontrada.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <Button asChild variant="ghost" size="sm" className="gap-1 -ml-2">
        <Link to="/platform/automacao">
          <ArrowLeft className="h-4 w-4" />
          Voltar para unidades
        </Link>
      </Button>

      <div>
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Automação</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          <span className="font-medium text-foreground">{unit.organization_name}</span>
          {" — "}
          {unit.name}
        </p>
        <p className="text-sm text-muted-foreground">
          Configure os canais de WhatsApp, o provedor de IA e as instruções do agente.
        </p>
      </div>

      {/* Visível pro platform_admin que está configurando a unidade — a
          suspensão é do WhatsApp, o resto do sistema da organização segue
          funcionando. */}
      <WhatsappServiceBanner organizationId={unit.organization_id} unitSlug={unit.slug} />

      <Tabs defaultValue="channels">
        <TabsList className="mb-4">
          <TabsTrigger value="channels" className="gap-2">
            <MessageSquare className="h-4 w-4" />
            Canais WhatsApp
          </TabsTrigger>
          <TabsTrigger value="ai" className="gap-2">
            <Bot className="h-4 w-4" />
            Provedor de IA
          </TabsTrigger>
          <TabsTrigger value="prompt" className="gap-2">
            <Info className="h-4 w-4" />
            Instruções do agente
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="gap-2">
            <Activity className="h-4 w-4" />
            Diagnóstico
          </TabsTrigger>
          <TabsTrigger value="payments" className="gap-2">
            <CreditCard className="h-4 w-4" />
            Pagamentos
          </TabsTrigger>
        </TabsList>

        <TabsContent value="channels">
          <ChannelsTab key={unitId} unitId={unitId} defaultProvider={unit.default_whatsapp_provider} />
        </TabsContent>

        <TabsContent value="ai">
          <AITab unitId={unitId} />
        </TabsContent>

        <TabsContent value="prompt">
          <PromptTab unitId={unitId} />
        </TabsContent>

        <TabsContent value="diagnostics">
          <DiagnosticsTab unitId={unitId} />
        </TabsContent>

        <TabsContent value="payments">
          <PaymentsTab unitId={unitId} unitSlug={unitSlug ?? ""} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Tab: WhatsApp Channels ───────────────────────────────────────────────────

// O `?secret=` só é emitido quando o esquema de assinatura do provider É o
// próprio secret do canal (zapi/waha/uazapi hoje). Para `official` a Meta
// valida por `app_secret` (o `&secret=` era inerte); para `datafy` o `whsec_`
// que autentica a entrega NUNCA pode ir na URL — colada no painel do provedor,
// vive nos logs de acesso do gateway para sempre. Pergunta feita pelo esquema
// de assinatura (`WEBHOOK_SIGNATURE_SCHEME`), não por nome de provider — um
// `provider !== "datafy"` resolveria hoje e erraria de novo no próximo
// provider Meta-shaped.
function buildWebhookUrl(channelId: string, secret: string, provider: WhatsAppProvider): string {
  const base = (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
  const secretParam = WEBHOOK_SIGNATURE_SCHEME[provider] === "channel_secret" ? `&secret=${secret}` : "";
  return `${base}/functions/v1/webhook-whatsapp?channel=${channelId}${secretParam}`;
}

function AdminQrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inlineImage = /^data:image\/(?:png|jpeg);base64,/i.test(value)
    ? value
    : /^iVBOR/i.test(value)
      ? `data:image/png;base64,${value}`
      : null;

  useEffect(() => {
    if (!canvasRef.current || inlineImage) return;
    QRCode.toCanvas(canvasRef.current, value, { width: 260, margin: 2 }).catch(() => undefined);
  }, [inlineImage, value]);

  return inlineImage
    ? <img src={inlineImage} alt="QR Code da conexão UazAPI" className="mx-auto h-64 w-64 object-contain" />
    : <canvas ref={canvasRef} aria-label="QR Code da conexão UazAPI" className="mx-auto h-64 w-64 max-w-full" />;
}

function ChannelsTab({ unitId, defaultProvider }: { unitId: string; defaultProvider?: WhatsAppProvider }) {
  const { data: channels, isLoading, isError, error, refetch } = useWhatsAppChannels(unitId);
  const { data: providerMetadata = [] } = useWhatsAppProviderMetadata(unitId);
  const deleteChannel = useDeleteChannel(unitId);
  const testChannel = useTestChannel(unitId);
  const rotateSecret = useRotateChannelSecret(unitId);
  const connectChannel = useConnectChannel(unitId);
  const refreshChannelStatus = useRefreshChannelStatus(unitId);
  const beginSwitch = useBeginChannelSwitch(unitId);
  const [addOpen, setAddOpen] = useState(false);
  const [editChannel, setEditChannel] = useState<WhatsAppChannel | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);

  const handleLifecycleResult = (data: ChannelConnectionResponse, success: string) => {
    if (data.connection?.qr_code) setQrCode(data.connection.qr_code);
    if (data.warnings?.includes("PROVISIONING_RECONCILIATION_PENDING")) {
      toast.warning("A criação ainda está sendo conciliada. Aguarde alguns minutos antes de tentar novamente.");
    } else if (data.warnings?.includes("INSTANCE_INVENTORY_RECONCILIATION_REQUIRED")) {
      toast.warning("Conexão criada; o inventário financeiro precisa de reconciliação.");
    } else {
      toast.success(success);
    }
  };

  const handleCopy = async (channelId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(channelId);
      toast.success("URL do webhook copiada.");
      setTimeout(() => setCopiedId((c) => (c === channelId ? null : c)), 2000);
    } catch {
      toast.error("Não foi possível copiar.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Adicione canais de WhatsApp para que o agente receba e envie mensagens.
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Adicionar canal
        </Button>
      </div>

      <DatafyAdminCard unitId={unitId} channels={channels ?? []} />
      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <AlertTriangle className="h-8 w-8 mx-auto text-destructive" />
            <p className="text-sm text-destructive">{error?.message ?? "Falha ao carregar os canais."}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Tentar novamente</Button>
          </CardContent>
        </Card>
      ) : !channels?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Phone className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Nenhum canal configurado. Adicione um canal acima.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {channels.map((ch) => {
            const statusCfg = STATUS_CONFIG[ch.status] ?? STATUS_CONFIG.disconnected;
            const capabilities = ch.capabilities;
            const automaticLifecycle = capabilities?.automaticProvisioning === true;
            const automaticWebhook = capabilities?.automaticWebhook === true;
            const hasAlternativeChannel = channels.some((row) => row.id !== ch.id);
            return (
              <Card key={ch.id}>
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-medium text-sm">{PROVIDER_LABELS[ch.provider]}</span>
                      <Badge variant="outline" className={`text-[10px] gap-1 ${statusCfg.className}`}>
                        {statusCfg.icon}
                        {statusCfg.label}
                      </Badge>
                      {ch.is_active === true && <Badge variant="success">Ativo</Badge>}
                      {ch.is_active === false && <Badge variant="secondary">Preparado</Badge>}
                      {ch.manual_echo_verified_at ? (
                        <Badge variant="outline">
                          {ch.manual_echo_verification_source === "provider_callback"
                            ? "Eco manual validado"
                            : "Webhook de conversa configurado"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-warning border-warning/40">
                          Validação de conversa pendente
                        </Badge>
                      )}
                      {ch.display_phone && (
                        <span className="text-sm text-muted-foreground">{formatPhone(ch.display_phone)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {automaticLifecycle ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => connectChannel.mutate(
                              { channelId: ch.id },
                              { onSuccess: (data) => handleLifecycleResult(data, "Conexão UazAPI iniciada.") },
                            )}
                            disabled={connectChannel.isPending}
                          >
                            <Phone className="h-3 w-3 mr-1" />
                            Conectar / QR
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => refreshChannelStatus.mutate(
                              { channelId: ch.id },
                              { onSuccess: (data) => handleLifecycleResult(data, "Status atualizado.") },
                            )}
                            disabled={refreshChannelStatus.isPending}
                          >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Status
                          </Button>
                          {ch.is_active !== true && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="sm">Ativar / trocar</Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Preparar troca para UazAPI?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {hasAlternativeChannel
                                      ? "O canal atual permanece ativo até a UazAPI conectar. O cutover só ocorre depois da validação."
                                      : "A UazAPI só será ativada depois de conectar e concluir a validação."}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => beginSwitch.mutate(
                                    { channelId: ch.id, targetProvider: ch.provider },
                                    { onSuccess: (data) => handleLifecycleResult(data, "Troca preparada.") },
                                  )}>
                                    Preparar troca
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => testChannel.mutate(ch.id)}
                            disabled={testChannel.isPending}
                          >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Testar
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditChannel(ch)}>
                            <Pencil className="h-3 w-3 mr-1" />
                            Editar
                          </Button>
                          {ch.is_active !== true && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button size="sm">Ativar / trocar</Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Validar e ativar {PROVIDER_LABELS[ch.provider]}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {hasAlternativeChannel
                                      ? "O canal atual só será substituído depois que conexão e eco manual forem confirmados ao vivo."
                                      : "O canal só será ativado depois que conexão e eco manual forem confirmados ao vivo."}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => beginSwitch.mutate(
                                    { channelId: ch.id, targetProvider: ch.provider },
                                    { onSuccess: (data) => handleLifecycleResult(data, "Canal validado e ativado.") },
                                  )}>
                                    Validar e ativar
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </>
                      )}
                      {!automaticWebhook && (
                        <RotateSecretAction
                          channel={ch}
                          isPending={rotateSecret.isPending}
                          onRotate={(webhookSecret) =>
                            rotateSecret.mutate({ channelId: ch.id, webhookSecret, provider: ch.provider })
                          }
                        />
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Remover
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remover canal {PROVIDER_LABELS[ch.provider]}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              O agente deixará de receber e enviar mensagens por este canal.
                              Lembre-se de também desativar o webhook no painel do provedor.
                              Esta ação não pode ser desfeita.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteChannel.mutate(ch.id)}
                              disabled={deleteChannel.isPending}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {deleteChannel.isPending ? "Removendo..." : "Remover"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>

                  {ch.last_error && (
                    <p className="text-xs text-destructive truncate">{ch.last_error}</p>
                  )}

                  {automaticWebhook ? (
                    <p className="text-xs text-muted-foreground">
                      Instância, webhook e token são gerenciados automaticamente; o token fica no Vault.
                    </p>
                  ) : <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {WEBHOOK_SIGNATURE_SCHEME[ch.provider] === "datafy_whsec"
                        ? "Webhook (URL estável — configure uma vez no painel da Datafy). O segredo que autentica a entrega rotaciona à parte, em \"Rotacionar secret\":"
                        : "Webhook (configure no painel do provedor):"}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <code
                        className="font-mono bg-muted px-1.5 py-0.5 rounded text-[10px] truncate flex-1 min-w-0"
                        title={buildWebhookUrl(ch.id, ch.webhook_secret, ch.provider)}
                      >
                        {buildWebhookUrl(ch.id, ch.webhook_secret, ch.provider)}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 shrink-0"
                        onClick={() =>
                          handleCopy(ch.id, buildWebhookUrl(ch.id, ch.webhook_secret, ch.provider))
                        }
                      >
                        {copiedId === ch.id ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddChannelDialog
        unitId={unitId}
        key={`${unitId}-${addOpen}`}
        defaultProvider={defaultProvider}
        providers={providerMetadata}
        open={addOpen}
        onClose={() => setAddOpen(false)}
      />
      <EditChannelDialog
        unitId={unitId}
        channel={editChannel}
        onClose={() => setEditChannel(null)}
      />
      <Dialog open={!!qrCode} onOpenChange={(open) => { if (!open) setQrCode(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Conectar WhatsApp</DialogTitle></DialogHeader>
          {qrCode && <AdminQrCode value={qrCode} />}
          <p className="text-sm text-muted-foreground text-center">
            Abra WhatsApp → Aparelhos conectados → Conectar um aparelho.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Datafy é o único provider cujo secret o admin PRECISA colar: ela emite o
// `whsec_` (rotacionado no painel dela) e a nossa ação só o grava. Os outros
// três providers (Z-API/WAHA/Official) seguem sem input — o backend gera.
function RotateSecretAction({
  channel,
  isPending,
  onRotate,
}: {
  channel: WhatsAppChannel;
  isPending: boolean;
  onRotate: (webhookSecret?: string) => void;
}) {
  const [secretDraft, setSecretDraft] = useState("");
  const isDatafy = channel.provider === "datafy";

  return (
    <AlertDialog onOpenChange={(open) => { if (!open) setSecretDraft(""); }}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <KeyRound className="h-3 w-3 mr-1" />
          Rotacionar secret
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rotacionar secret do canal {PROVIDER_LABELS[channel.provider]}?</AlertDialogTitle>
          <AlertDialogDescription>
            {isDatafy ? (
              "Cole o segredo novo gerado no painel da Datafy. O anterior deixa de ser aceito assim que você salvar."
            ) : (
              <>
                A URL antiga do webhook para de funcionar imediatamente.
                Depois de rotacionar, copie a URL nova neste card e configure-a
                no painel do provedor. O canal ficará inativo: envie uma mensagem
                pelo celular para validar o novo eco e depois use "Ativar / trocar".
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isDatafy && (
          <div className="space-y-1">
            <Label htmlFor={`rotate-secret-${channel.id}`}>Novo segredo do webhook</Label>
            <Input
              id={`rotate-secret-${channel.id}`}
              type="password"
              autoComplete="off"
              placeholder="whsec_..."
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              É o valor que está na aba Webhooks do número, no painel da Datafy.
            </p>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onRotate(isDatafy ? secretDraft.trim() : undefined)}
            disabled={isPending || (isDatafy && !secretDraft.trim())}
          >
            {isPending ? "Rotacionando..." : "Rotacionar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EditChannelDialog({
  unitId,
  channel,
  onClose,
}: {
  unitId: string;
  channel: WhatsAppChannel | null;
  onClose: () => void;
}) {
  const updateChannel = useUpdateChannel(unitId);
  const provider = channel?.provider;

  // Z-API fields
  const [instanceId, setInstanceId] = useState("");
  const [token, setToken] = useState("");
  const [clientToken, setClientToken] = useState("");

  // WAHA fields
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [sessionName, setSessionName] = useState("");

  // Official fields
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const reset = () => {
    setInstanceId(""); setToken(""); setClientToken("");
    setBaseUrl(""); setApiKey(""); setSessionName("");
    setPhoneNumberId(""); setBusinessAccountId(""); setAccessToken(""); setAppSecret("");
  };

  // Só envia campos preenchidos — o backend faz merge e mantém o resto.
  const getCredentials = (): ChannelCredentials => {
    const c: ChannelCredentials = {};
    if (provider === "zapi") {
      if (instanceId.trim()) c.instance_id = instanceId.trim();
      if (token.trim()) c.token = token.trim();
      if (clientToken.trim()) c.client_token = clientToken.trim();
    } else if (provider === "waha") {
      if (baseUrl.trim()) c.base_url = baseUrl.trim();
      if (apiKey.trim()) c.api_key = apiKey.trim();
      if (sessionName.trim()) c.session_name = sessionName.trim();
    } else if (provider === "datafy") {
      if (accessToken.trim()) c.access_token = accessToken.trim();
    } else if (provider === "official") {
      if (phoneNumberId.trim()) c.phone_number_id = phoneNumberId.trim();
      if (businessAccountId.trim()) c.business_account_id = businessAccountId.trim();
      if (accessToken.trim()) c.access_token = accessToken.trim();
      if (appSecret.trim()) c.app_secret = appSecret.trim();
    }
    return c;
  };

  const handleSave = () => {
    if (!channel) return;
    const credentials = getCredentials();
    if (Object.keys(credentials).length === 0) {
      toast.error("Preencha ao menos um campo para atualizar.");
      return;
    }
    updateChannel.mutate(
      { channelId: channel.id, credentials },
      {
        onSuccess: () => { onClose(); reset(); },
        onError: (err: Error) => toast.error(err.message || "Erro ao atualizar credenciais."),
      }
    );
  };

  return (
    <ResponsiveDialog open={!!channel} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Editar credenciais{provider ? ` — ${PROVIDER_LABELS[provider]}` : ""}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          <div className="rounded-lg border border-dashed p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
            <p>
              Deixe em branco o que quer manter — só os campos preenchidos são
              atualizados. O webhook não muda, então <span className="font-medium text-foreground">não precisa reconfigurar no provedor</span>.
            </p>
            <p>
              Depois de salvar, reconfigure o webhook se a identidade do canal mudou,
              envie uma mensagem pelo celular para validar o eco e só então use
              "Testar" e "Ativar / trocar".
            </p>
          </div>

          {provider === "zapi" && (
            <>
              <div className="space-y-1">
                <Label>Instance ID</Label>
                <Input value={instanceId} onChange={(e) => setInstanceId(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>Token</Label>
                <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>Client Token</Label>
                <Input type="password" autoComplete="off" value={clientToken} onChange={(e) => setClientToken(e.target.value)} placeholder="Novo client token" />
              </div>
            </>
          )}

          {provider === "waha" && (
            <>
              <div className="space-y-1">
                <Label>URL base</Label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>API Key</Label>
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>Session name</Label>
                <Input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="Manter atual" />
              </div>
            </>
          )}

          {provider === "datafy" && <div className="space-y-1"><Label htmlFor="edit-datafy-token">Token da Datafy</Label><Input id="edit-datafy-token" type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Manter atual" /></div>}
          {provider === "official" && (
            <>
              <div className="space-y-1">
                <Label>Phone Number ID</Label>
                <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>Business Account ID</Label>
                <Input value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>Access Token</Label>
                <Input type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Manter atual" />
              </div>
              <div className="space-y-1">
                <Label>App Secret</Label>
                <Input type="password" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="Manter atual" />
              </div>
            </>
          )}

          <Button onClick={handleSave} disabled={updateChannel.isPending} className="w-full">
            {updateChannel.isPending ? "Salvando…" : "Salvar alterações"}
          </Button>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function AddChannelDialog({
  unitId,
  providers,
  defaultProvider,
  open,
  onClose,
}: {
  unitId: string;
  providers: WhatsAppProviderMetadata[];
  defaultProvider?: WhatsAppProvider;
  open: boolean;
  onClose: () => void;
}) {
  const createChannel = useCreateChannel(unitId);
  const [provider, setProvider] = useState<WhatsAppProvider>(defaultProvider ?? "zapi");
  const selectedProvider = providers.find((item) => item.name === provider);

  // Z-API fields
  const [instanceId, setInstanceId] = useState("");
  const [token, setToken] = useState("");
  const [clientToken, setClientToken] = useState("");

  // WAHA fields
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [sessionName, setSessionName] = useState("");

  // Official fields
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  // Datafy fields — phone_number_id/waba_id/business_id vêm da descoberta por
  // /me no backend; aqui só entram o token e o webhook_secret que a Datafy emite.
  const [datafyToken, setDatafyToken] = useState("");
  const [datafyWebhookSecret, setDatafyWebhookSecret] = useState("");

  const reset = () => {
    setProvider(defaultProvider ?? "zapi");
    setInstanceId(""); setToken(""); setClientToken("");
    setBaseUrl(""); setApiKey(""); setSessionName("");
    setPhoneNumberId(""); setBusinessAccountId(""); setAccessToken(""); setAppSecret("");
    setDatafyToken(""); setDatafyWebhookSecret("");
  };

  const getCredentials = () => {
    if (selectedProvider?.capabilities.manualCredentials === false) return {};
    if (provider === "zapi") return { instance_id: instanceId, token, client_token: clientToken };
    if (provider === "waha") return { base_url: baseUrl, api_key: apiKey, session_name: sessionName };
    if (provider === "datafy") return { access_token: datafyToken };
    return { phone_number_id: phoneNumberId, business_account_id: businessAccountId, access_token: accessToken, app_secret: appSecret };
  };

  const handleCreate = () => {
    createChannel.mutate(
      {
        provider,
        credentials: getCredentials(),
        ...(provider === "datafy" ? { webhookSecret: datafyWebhookSecret } : {}),
      },
      {
        onSuccess: () => { onClose(); reset(); },
      }
    );
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader><ResponsiveDialogTitle>Adicionar canal WhatsApp</ResponsiveDialogTitle></ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          <div className="space-y-1">
            <Label>Plataforma</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as WhatsAppProvider)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {providers.map((item) => (
                  <SelectItem key={item.name} value={item.name}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider === "zapi" && (
            <>
              <div className="space-y-1">
                <Label>Instance ID</Label>
                <Input value={instanceId} onChange={(e) => setInstanceId(e.target.value)} placeholder="ex: 3D9F1A..." />
              </div>
              <div className="space-y-1">
                <Label>Token</Label>
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token da instância" />
              </div>
              <div className="space-y-1">
                <Label>Client Token</Label>
                <Input type="password" value={clientToken} onChange={(e) => setClientToken(e.target.value)} placeholder="Client token Z-API" />
              </div>
            </>
          )}

          {provider === "waha" && (
            <>
              <div className="space-y-1">
                <Label>URL base</Label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://waha.meuservidor.com" />
              </div>
              <div className="space-y-1">
                <Label>API Key</Label>
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key WAHA" />
              </div>
              <div className="space-y-1">
                <Label>Session name</Label>
                <Input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="default" />
              </div>
            </>
          )}

          {provider === "datafy" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="datafy-token">Token da Datafy</Label>
                <Input
                  id="datafy-token"
                  type="password"
                  autoComplete="off"
                  placeholder="sk_live_..."
                  value={datafyToken}
                  onChange={(e) => setDatafyToken(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  O número, o WABA e o Business ID são descobertos automaticamente por este token.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="datafy-whsec">Segredo do webhook</Label>
                <Input
                  id="datafy-whsec"
                  type="password"
                  autoComplete="off"
                  placeholder="whsec_..."
                  value={datafyWebhookSecret}
                  onChange={(e) => setDatafyWebhookSecret(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  A Datafy não permite configurar o webhook pela API. Depois de criar o canal,
                  copie a URL exibida e cole na aba Webhooks do número, no painel da Datafy.
                </p>
              </div>
            </>
          )}

          {provider === "official" && (
            <>
              <div className="space-y-1">
                <Label>Phone Number ID</Label>
                <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="ID do número no painel Meta" />
              </div>
              <div className="space-y-1">
                <Label>Business Account ID</Label>
                <Input value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} placeholder="WABA ID" />
              </div>
              <div className="space-y-1">
                <Label>Access Token</Label>
                <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="Token permanente" />
              </div>
              <div className="space-y-1">
                <Label>App Secret</Label>
                <Input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="App secret para validar webhooks" />
              </div>
            </>
          )}

          {selectedProvider?.capabilities.manualCredentials === false && (
            <div className="rounded-lg border border-info/20 bg-info/10 p-3 text-sm">
              Nenhuma credencial manual é necessária. A instância e o webhook serão configurados ao conectar.
            </div>
          )}

          <div className="rounded-lg border border-dashed p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Após adicionar:</p>
            <p>
              {selectedProvider?.capabilities.automaticWebhook
                ? "Clique em Conectar / QR no card. O webhook será configurado automaticamente."
                : "A URL completa do webhook será exibida no card. Copie e cole no painel do provedor."}
            </p>
            <p>
              Antes de ativar, envie uma mensagem pelo celular da loja. O sistema só libera a troca depois de receber e validar esse eco; na Meta isso exige Coexistence.
            </p>
          </div>

          <Button onClick={handleCreate} disabled={createChannel.isPending} className="w-full">
            Adicionar canal
          </Button>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ─── Tab: AI Provider ─────────────────────────────────────────────────────────

function AITab({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const [aiConfig, setAiConfig] = useState<AIConfig>({ provider: "claude", models: {} });
  const [apiKeyInput, setApiKeyInput] = useState("");

  const { data: settings } = useQuery({
    queryKey: ["settings", unitId],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("*").eq("unit_id", unitId);
      if (error) throw error;
      return data as Array<{ key: string; value: unknown }>;
    },
    enabled: !!unitId,
  });

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    if (map["ai_config"]) setAiConfig(map["ai_config"] as AIConfig);
  }, [settings]);

  const { data: aiKeys } = useAiProviderKeys(unitId);
  const upsertKey = useUpsertAiProviderKey(unitId);
  const deleteKey = useDeleteAiProviderKey(unitId);

  const savedKey = aiKeys?.find((k) => k.provider === aiConfig.provider);

  const handleSaveKey = () => {
    const trimmed = apiKeyInput.trim();
    if (trimmed.length < 10) {
      toast.error("Chave de API muito curta.");
      return;
    }
    upsertKey.mutate(
      { provider: aiConfig.provider, apiKey: trimmed },
      { onSuccess: () => setApiKeyInput("") }
    );
  };

  const handleDeleteKey = () => {
    deleteKey.mutate(aiConfig.provider);
  };

  const saveSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const { error } = await supabase
        .from("settings")
        .upsert({ key, value, unit_id: unitId }, { onConflict: "unit_id,key" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", unitId] });
      toast.success("Configuração salva.");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao salvar."),
  });

  const activeProvider = PROVIDERS.find((p) => p.id === aiConfig.provider)!;
  const activeProviderModels = MODELS_BY_PROVIDER[aiConfig.provider];
  const activeDefaultModel = DEFAULT_MODEL_BY_PROVIDER[aiConfig.provider];
  const savedModel = aiConfig.models?.[aiConfig.provider] ?? "";
  const savedModelInList = activeProviderModels.some((m) => m.value === savedModel);
  const showLegacyOption = savedModel !== "" && !savedModelInList;

  const updateAiConfig = (patch: Partial<AIConfig>) => {
    const updated = { ...aiConfig, ...patch };
    setAiConfig(updated);
    saveSetting.mutate({ key: "ai_config", value: updated });
  };

  const setModelOverride = (model: string) => {
    updateAiConfig({ models: { ...aiConfig.models, [aiConfig.provider]: model || undefined } });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Provedor de IA</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">Escolha qual IA responde os clientes via WhatsApp.</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1">
          <Label>Provedor ativo</Label>
          <Select value={aiConfig.provider} onValueChange={(v) => updateAiConfig({ provider: v as AIProvider })}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label>Modelo</Label>
          <Select
            value={savedModel === "" ? "__default__" : savedModel}
            onValueChange={(v) => setModelOverride(v === "__default__" ? "" : v)}
          >
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Selecione um modelo…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                Padrão ({activeDefaultModel})
              </SelectItem>
              {activeProviderModels.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                  {m.hint ? <span className="text-muted-foreground"> · {m.hint}</span> : null}
                </SelectItem>
              ))}
              {showLegacyOption && (
                <SelectItem value={savedModel} className="text-warning">
                  {savedModel} (descontinuado — trocar)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Recomendado deixar no padrão. A lista é atualizada conforme cada provedor lança modelos novos.
          </p>
        </div>

        <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-primary shrink-0" />
            Chave de API — {activeProvider.label}
          </div>

          {savedKey ? (
            <div className="flex items-center justify-between rounded bg-background border px-3 py-2">
              <div className="space-y-0.5">
                <p className="font-mono text-sm">••••••••{savedKey.last4}</p>
                <p className="text-[11px] text-muted-foreground">
                  Atualizada em {new Date(savedKey.updated_at).toLocaleString("pt-BR")}
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] text-success border-success/20 bg-success/10">
                Salva
              </Badge>
            </div>
          ) : (
            <div className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-medium">Chave obrigatória nesta unidade.</p>
                <p>
                  Sem chave cadastrada, o agente IA não responde mensagens —
                  cada conversa que chegar vira handoff humano automaticamente.
                  Cadastre a chave de {activeProvider.label} abaixo.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="ai-api-key" className="text-xs">
              {savedKey ? "Substituir chave" : "Cadastrar chave"}
            </Label>
            <div className="flex gap-2">
              <Input
                id="ai-api-key"
                type="password"
                autoComplete="off"
                placeholder={`${activeProvider.envKey === "ANTHROPIC_API_KEY" ? "sk-ant-..." : activeProvider.envKey === "OPENAI_API_KEY" ? "sk-..." : activeProvider.envKey === "GEMINI_API_KEY" ? "AIza..." : activeProvider.envKey === "GROK_API_KEY" ? "xai-..." : "sk-..."}`}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                disabled={upsertKey.isPending || deleteKey.isPending}
              />
              <Button
                onClick={handleSaveKey}
                disabled={!apiKeyInput.trim() || upsertKey.isPending || deleteKey.isPending}
              >
                {upsertKey.isPending ? "Salvando…" : "Salvar"}
              </Button>
              {savedKey && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={deleteKey.isPending || upsertKey.isPending}
                      title="Remover chave"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remover chave de {activeProvider.label}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        O agente IA para de responder mensagens desta unidade até
                        você cadastrar uma chave nova. As próximas mensagens viram
                        handoff humano automaticamente. Esta ação não pode ser desfeita.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDeleteKey}>Remover</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-muted-foreground rounded bg-background border border-dashed p-2">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>
              A chave fica isolada por unidade no banco e nunca é exibida em texto puro depois de salva.
              Apenas as Edge Functions do servidor a leem para chamar o provedor de IA.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Tab: Configuração do Agente ─────────────────────────────────────────────

function PromptTab({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const [agentMode, setAgentMode] = useState<"reservations" | "reservations_faq">("reservations");
  const [agentName, setAgentName] = useState("");
  const [restaurantMenu, setRestaurantMenu] = useState("");
  const [deliveryResponse, setDeliveryResponse] = useState("");
  const [restaurantExtraInfo, setRestaurantExtraInfo] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [aiContextExtra, setAiContextExtra] = useState("");

  const { data: settings } = useQuery({
    queryKey: ["settings", unitId],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("*").eq("unit_id", unitId);
      if (error) throw error;
      return data as Array<{ key: string; value: unknown }>;
    },
    enabled: !!unitId,
  });

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    setAgentMode(((map["agent_mode"] as string) ?? "reservations") as "reservations" | "reservations_faq");
    setAgentName((map["agent_name"] as string) ?? "");
    setRestaurantMenu((map["restaurant_menu"] as string) ?? "");
    setDeliveryResponse((map["delivery_response"] as string) ?? "");
    setRestaurantExtraInfo((map["restaurant_extra_info"] as string) ?? "");
    setSystemPrompt((map["ai_system_prompt"] as string) ?? "");
    setAiContextExtra((map["ai_context_extra"] as string) ?? "");
  }, [settings]);

  const [isSavingAll, setIsSavingAll] = useState(false);

  const saveSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const { error } = await supabase
        .from("settings")
        .upsert({ key, value, unit_id: unitId }, { onConflict: "unit_id,key" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", unitId] });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao salvar."),
  });

  async function saveAll() {
    if (isSavingAll) return;
    setIsSavingAll(true);
    try {
      await Promise.all([
        saveSetting.mutateAsync({ key: "agent_mode", value: agentMode }),
        saveSetting.mutateAsync({ key: "agent_name", value: agentName.trim() }),
        saveSetting.mutateAsync({ key: "restaurant_menu", value: restaurantMenu }),
        saveSetting.mutateAsync({ key: "delivery_response", value: deliveryResponse }),
        saveSetting.mutateAsync({ key: "restaurant_extra_info", value: restaurantExtraInfo }),
        saveSetting.mutateAsync({ key: "ai_system_prompt", value: systemPrompt }),
        saveSetting.mutateAsync({ key: "ai_context_extra", value: aiContextExtra }),
      ]);
      toast.success("Configuração do agente salva.");
    } catch (err) {
      toast.error((err as Error)?.message || "Erro ao salvar configuração.");
    } finally {
      setIsSavingAll(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configuração do Agente IA</CardTitle>
        <p className="text-sm text-muted-foreground">
          Define o escopo e o contexto que o agente usa ao responder via WhatsApp.
          Endereço e horários de funcionamento são lidos automaticamente das telas Unidade e Horários.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>Modo do agente</Label>
          <Select value={agentMode} onValueChange={(v) => setAgentMode(v as typeof agentMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="reservations">Apenas reservas — foca 100% em criar/alterar/cancelar reservas</SelectItem>
              <SelectItem value="reservations_faq">Reservas + FAQ — responde também cardápio, horário, endereço e outras dúvidas gerais</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Nome do agente</Label>
          <Input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Yumi"
            maxLength={40}
          />
          <p className="text-xs text-muted-foreground">
            Nome usado pelo atendente no WhatsApp. Ele se apresenta como pessoa da equipe e só revela que é um atendimento virtual se o cliente perguntar diretamente. Em branco, usa "Yumi".
          </p>
        </div>

        <div className="space-y-2">
          <Label>Cardápio (URL ou texto)</Label>
          <Textarea
            rows={4}
            value={restaurantMenu}
            onChange={(e) => setRestaurantMenu(e.target.value)}
            placeholder="https://seurestaurante.com/cardapio  — ou cole o cardápio em texto simples"
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">Deixe em branco para a IA não citar o cardápio.</p>
        </div>

        <div className="space-y-2">
          <Label>Resposta sobre delivery / take-away</Label>
          <Textarea
            rows={3}
            value={deliveryResponse}
            onChange={(e) => setDeliveryResponse(e.target.value)}
            placeholder="Não fazemos delivery. Para pedidos fora do restaurante, sugerimos os apps iFood e Rappi."
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">Se o sistema não oferecer delivery, deixe claro aqui para a IA orientar o cliente corretamente.</p>
        </div>

        <div className="space-y-2">
          <Label>Outras informações (estacionamento, contatos, regras da casa)</Label>
          <Textarea
            rows={3}
            value={restaurantExtraInfo}
            onChange={(e) => setRestaurantExtraInfo(e.target.value)}
            placeholder="Temos estacionamento gratuito na rua X. Aceitamos pets na área externa. Dress code: traje esporte fino às sextas."
            className="text-sm"
          />
        </div>

        <div className="space-y-2">
          <Label>Instruções adicionais ao agente</Label>
          <Textarea
            rows={5}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Ex: Sempre pergunte se o cliente tem alguma alergia antes de confirmar a reserva."
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">Complementa o comportamento padrão do agente. Use para regras específicas do seu negócio.</p>
        </div>

        <div className="space-y-2">
          <Label>Observações extras para o bot</Label>
          <Textarea
            rows={4}
            value={aiContextExtra}
            onChange={(e) => setAiContextExtra(e.target.value)}
            placeholder="Ex: O rodízio funciona via tablet na mesa, sem precisar chamar garçom. Para grupos acima de 12 pessoas confirmamos pelo telefone após a reserva."
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Use para informações úteis que o bot precisa saber para responder dúvidas frequentes — coisas que não cabem em cardápio, delivery ou outras informações.
          </p>
        </div>

        <Button onClick={saveAll} disabled={isSavingAll || saveSetting.isPending}>
          {isSavingAll ? "Salvando…" : "Salvar configuração"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Tab: Pagamentos (Stripe Connect) ───────────────────────────────────────

function PaymentsTab({ unitId, unitSlug }: { unitId: string; unitSlug: string }) {
  const { data: account, isLoading } = useStripeAccount(unitId);
  const connectStripe = useConnectStripe(unitId);
  const checkStatus = useCheckStripeStatus(unitId);
  const disconnectStripe = useDisconnectStripe(unitId);

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  if (!account) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Pagamentos via Stripe</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Conecte a conta Stripe do restaurante para cobrar caução nas reservas online.
            O dinheiro vai direto para a conta do restaurante.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-dashed p-4 bg-muted/30 space-y-3">
            <p className="text-sm text-muted-foreground">
              Nenhuma conta Stripe conectada. Clique abaixo para iniciar o processo de conexão.
              O restaurante será redirecionado para o Stripe para completar o cadastro.
            </p>
            <Button
              onClick={() => connectStripe.mutate({ unitSlug })}
              disabled={connectStripe.isPending}
              className="gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              {connectStripe.isPending ? "Redirecionando…" : "Conectar conta Stripe"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Pagamentos via Stripe</CardTitle>
          </div>
          <Badge
            variant="outline"
            className={`text-[10px] gap-1 ${
              account.charges_enabled
                ? "text-success bg-success/10 border-success/20"
                : account.onboarding_complete
                  ? "text-warning bg-warning/10 border-warning/20"
                  : "text-muted-foreground bg-muted"
            }`}
          >
            {account.charges_enabled
              ? "Ativo"
              : account.onboarding_complete
                ? "Pendente de ativação"
                : "Onboarding incompleto"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Nome</p>
            <p className="font-medium">{account.display_name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cobranças</p>
            <Badge
              variant="outline"
              className={`text-[10px] ${
                account.charges_enabled
                  ? "text-success bg-success/10 border-success/20"
                  : "text-muted-foreground bg-muted"
              }`}
            >
              {account.charges_enabled ? "Habilitadas" : "Desabilitadas"}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Pagamentos</p>
            <Badge
              variant="outline"
              className={`text-[10px] ${
                account.payouts_enabled
                  ? "text-success bg-success/10 border-success/20"
                  : "text-muted-foreground bg-muted"
              }`}
            >
              {account.payouts_enabled ? "Habilitados" : "Desabilitados"}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Modo</p>
            <p className="font-medium">{account.livemode ? "Produção" : "Teste"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Conta</p>
            <p className="font-mono text-xs">{account.stripe_account_id}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Conectada em</p>
            <p className="text-xs">{new Date(account.created_at).toLocaleDateString("pt-BR")}</p>
          </div>
        </div>

        {!account.onboarding_complete && (
          <div className="rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Onboarding incompleto</p>
              <p>
                O restaurante precisa completar o cadastro no Stripe para começar a receber pagamentos.
                Clique em "Retomar onboarding" para continuar.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {!account.onboarding_complete && (
            <Button
              size="sm"
              onClick={() => connectStripe.mutate({ unitSlug })}
              disabled={connectStripe.isPending}
              className="gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              {connectStripe.isPending ? "Redirecionando…" : "Retomar onboarding"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => checkStatus.mutate()}
            disabled={checkStatus.isPending}
            className="gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${checkStatus.isPending ? "animate-spin" : ""}`} />
            Atualizar status
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive gap-1"
              >
                <Trash2 className="h-3 w-3" />
                Desconectar
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Desconectar conta Stripe?</AlertDialogTitle>
                <AlertDialogDescription>
                  As reservas com cobrança deixarão de aceitar pagamento online
                  até uma nova conta ser conectada. Reservas já pagas não são afetadas.
                  Esta ação não pode ser desfeita.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => disconnectStripe.mutate()}
                  disabled={disconnectStripe.isPending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {disconnectStripe.isPending ? "Desconectando…" : "Desconectar"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-muted-foreground rounded bg-background border border-dashed p-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            Os pagamentos vão direto para a conta Stripe do restaurante.
            Para configurar quais horários cobram caução, acesse Salões &gt; Horários no painel de gestão da unidade.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Tab: Diagnóstico ────────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<string, string> = {
  success: "Sucesso",
  duplicate: "Duplicada",
  empty_response: "Resposta vazia",
  agent_error: "Erro do agente",
  send_error: "Erro de envio",
  rate_limited: "Rate limit",
  human_active_silent: "Em atendimento humano",
  human_active_reminded: "Lembrete enviado",
  handoff_auto_resolved: "Handoff resolvido",
  ai_key_unavailable: "Sem chave de IA",
  webhook_unauthorized: "Secret inválido",
  channel_not_found: "Canal não encontrado",
  ignored_non_text: "Não-texto",
  survey_response: "Avaliação registrada",
  customer_upsert_failed: "Erro no customer",
  webhook_error: "Erro inesperado",
  missing_channel_param: "Sem channel param",
};

const OUTCOME_TONE: Record<string, "good" | "warn" | "bad" | "neutral"> = {
  success: "good",
  survey_response: "good",
  handoff_auto_resolved: "good",
  duplicate: "neutral",
  human_active_silent: "neutral",
  human_active_reminded: "neutral",
  ignored_non_text: "neutral",
  rate_limited: "warn",
  empty_response: "warn",
  agent_error: "bad",
  send_error: "bad",
  ai_key_unavailable: "bad",
  webhook_unauthorized: "bad",
  channel_not_found: "bad",
  customer_upsert_failed: "bad",
  webhook_error: "bad",
  missing_channel_param: "bad",
};

function outcomeBadgeClass(outcome: string): string {
  const tone = OUTCOME_TONE[outcome] ?? "neutral";
  if (tone === "good") return "text-success bg-success/10 border-success/20";
  if (tone === "warn") return "text-warning bg-warning/10 border-warning/20";
  if (tone === "bad") return "text-destructive bg-destructive/10 border-destructive/20";
  return "text-muted-foreground bg-muted border-transparent";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "agora";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min atrás`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h atrás`;
  return `${Math.round(ms / 86_400_000)} d atrás`;
}

function DiagnosticsTab({ unitId }: { unitId: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useWhatsAppHealth(unitId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-3">
          <AlertTriangle className="h-8 w-8 mx-auto text-destructive" />
          <p className="text-sm text-destructive">{(error as Error).message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-6">
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const { channel, ai, stats_24h, inbound_queue, last_executions, generated_at } = data;
  const successRate = stats_24h.total > 0
    ? Math.round(((stats_24h.by_outcome.success ?? 0) / stats_24h.total) * 100)
    : null;

  return (
    <div className="space-y-4">
      <p className="text-sm">Alerta operacional: {data.ops_alert_configured === true ? "Configurado" : data.ops_alert_configured === false ? "Não configurado" : "Não disponível"}. Ingestão efetiva: {channel?.ingestion_mode_effective ?? "Não disponível"}. Canal ativo: {channel?.is_active === true ? "Sim" : "Não"}.</p>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Atualizado {relativeTime(generated_at)}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>

      {/* Canal */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Canal WhatsApp</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!channel ? (
            <p className="text-sm text-muted-foreground">Nenhum canal configurado para esta unidade.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge variant="outline" className={`text-[10px] gap-1 ${STATUS_CONFIG[channel.status]?.className ?? ""}`}>
                    {STATUS_CONFIG[channel.status]?.icon}
                    {STATUS_CONFIG[channel.status]?.label ?? channel.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Provedor</p>
                  <p className="font-medium">{PROVIDER_LABELS[channel.provider]}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Número</p>
                  <p className="font-medium">{channel.display_phone ? formatPhone(channel.display_phone) : "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Último evento</p>
                  <p className="font-medium">{relativeTime(channel.last_event_at)}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Credenciais presentes</p>
                  <p className="font-mono text-xs">
                    {channel.credentials_present.length
                      ? channel.credentials_present.join(", ")
                      : "(nenhuma)"}
                  </p>
                </div>
              </div>
              {channel.last_error && (
                <div className="rounded bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
                  Último erro: {channel.last_error}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* IA */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Provedor de IA</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Provedor</p>
              <p className="font-medium capitalize">{ai.provider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Modelo</p>
              <p className="font-medium font-mono text-xs">{ai.model ?? "padrão"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Origem da chave</p>
              {ai.key_source === "byok" && (
                <Badge variant="outline" className="text-[10px] text-success bg-success/10 border-success/20">
                  BYOK ••••{ai.byok_last4}
                </Badge>
              )}
              {ai.key_source === "global" && (
                <Badge variant="outline" className="text-[10px] text-warning bg-warning/10 border-warning/20">
                  Secret global
                </Badge>
              )}
              {ai.key_source === "missing" && (
                <Badge variant="outline" className="text-[10px] text-destructive bg-destructive/10 border-destructive/20">
                  Não configurada
                </Badge>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Variável global</p>
              <p className="font-mono text-xs">{ai.global_env}</p>
            </div>
          </div>
          {ai.key_source === "missing" && (
            <div className="mt-3 rounded bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
              Sem chave nem fallback global — o agente vai falhar ao tentar responder.
              Cadastre uma chave na aba "Provedor de IA".
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats 24h */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Atividade — últimas 24h</CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              {stats_24h.total} {stats_24h.total === 1 ? "execução" : "execuções"}
              {successRate !== null && ` · ${successRate}% sucesso`}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {stats_24h.total === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma execução nas últimas 24h.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats_24h.by_outcome)
                .sort((a, b) => b[1] - a[1])
                .map(([outcome, count]) => (
                  <Badge
                    key={outcome}
                    variant="outline"
                    className={`text-[11px] ${outcomeBadgeClass(outcome)}`}
                  >
                    {OUTCOME_LABEL[outcome] ?? outcome}: {count}
                  </Badge>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fila de inbound — só aparece quando a EF informa os números.
          A ausência é "esta EF ainda não sabe responder" (deploy manual, versão
          antiga no ar), não "não há nada": renderizar 0 nesse caso afirmaria o
          negativo sobre uma pergunta que ninguém fez. Mesma razão pela qual o
          `count` nulo vira "—" e não "0". */}
      {inbound_queue && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Fila de inbound</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* O BACKLOG VEM PRIMEIRO, e em linha própria, porque é a única coisa
                aqui que responde "o pipeline está andando?". As duas contagens
                abaixo são de estados TERMINAIS, e a de dead letter responde com a
                verdade mais enganosa disponível: quem promove a `dead` é a
                varredura, então varredura parada devolve `0` honestamente enquanto
                a fila enche. Hierarquia visual é parte da correção, não enfeite.

                `pending` pode faltar mesmo com o bloco presente (a EF é deployada à
                mão e as duas contagens acima foram ao ar antes deste campo): a
                ausência esconde o tile em vez de renderizar 0. */}
            {inbound_queue.pending && (() => {
              // `generated_at` e não `Date.now()`: o `received_at` vem do relógio do
              // BANCO, e medir contra o relógio do NAVEGADOR deixaria um viewer com
              // hora errada inventando horas de backlog. Servidor contra servidor.
              const backlog = describeInboundBacklog(inbound_queue.pending, generated_at);
              return (
                <div
                  className={
                    backlog.alarming
                      ? "rounded border border-destructive/20 bg-destructive/10 px-3 py-2"
                      : ""
                  }
                >
                  <p className="text-xs text-muted-foreground">
                    Na fila agora (aguardando ou em processamento)
                  </p>
                  <p
                    className={`font-medium ${backlog.alarming ? "text-destructive" : ""}`}
                  >
                    {backlog.value}
                  </p>
                  <p
                    className={`text-xs ${
                      backlog.alarming ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {backlog.detail}
                  </p>
                </div>
              );
            })()}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">
                  Dead letter (últimos {inbound_queue.dead_letter.window_days} dias)
                </p>
                <p className="font-medium">{inbound_queue.dead_letter.count ?? "—"}</p>
                <p className="text-xs text-muted-foreground">
                  Entregas que a fila desistiu de processar. Quando havia conversa,
                  ela está em atendimento humano.
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Recusadas por identidade (últimos{" "}
                  {inbound_queue.unauthorized_terminal.window_days} dias)
                </p>
                <p className="font-medium">
                  {inbound_queue.unauthorized_terminal.count ?? "—"}
                </p>
                {/* DUAS causas, não uma — o núcleo (`queuedEventVerdict`) nomeia
                    as duas e a copy nomeava só a primeira. A segunda é a que faz
                    desta contagem um sinal de SEGURANÇA: a âncora
                    `phone_number_id` que aceitou o payload pode ter migrado para
                    um canal de outra organização. Descrever só a rotação ensina o
                    admin a ler contagem > 0 como rotina e parar de olhar,
                    perdendo o único rastro que esse caso deixa. */}
                <p className="text-xs text-muted-foreground">
                  Descartadas sem resposta, de propósito. Esperado durante rotação de
                  credencial do canal, com mensagem em trânsito. Fora disso,
                  investigue: pode ser payload aceito pela âncora
                  (`phone_number_id`) de outra organização.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Últimas execuções */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Últimas execuções</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {last_executions.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">Nada registrado ainda.</p>
          ) : (
            <div className="divide-y">
              {last_executions.map((e) => (
                <div key={e.id} className="px-4 py-2 text-sm flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${outcomeBadgeClass(e.outcome)}`}
                  >
                    {OUTCOME_LABEL[e.outcome] ?? e.outcome}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{e.phone_hash ?? "—"}</span>
                      {e.duration_ms != null && <span>· {e.duration_ms} ms</span>}
                      <span>· {relativeTime(e.created_at)}</span>
                    </div>
                    {e.error && (
                      <p className="text-xs text-destructive truncate">{e.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

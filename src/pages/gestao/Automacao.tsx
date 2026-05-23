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
import { useState, useEffect } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  Copy,
  Info,
  KeyRound,
  MessageSquare,
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
  useDeleteChannel,
  useTestChannel,
} from "@/hooks/useWhatsAppChannels";
import {
  useAiProviderKeys,
  useUpsertAiProviderKey,
  useDeleteAiProviderKey,
} from "@/hooks/useAiProviderKeys";
import { useWhatsAppHealth } from "@/hooks/useWhatsAppHealth";
import type { WhatsAppChannel, WhatsAppProvider } from "@/types/reserva";
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
  waha: "WAHA (self-hosted)",
  official: "API Oficial (Meta)",
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  connected: { label: "Conectado", icon: <Wifi className="h-3 w-3" />, className: "text-green-700 bg-green-50 border-green-200" },
  disconnected: { label: "Desconectado", icon: <WifiOff className="h-3 w-3" />, className: "text-muted-foreground bg-muted" },
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
        </TabsList>

        <TabsContent value="channels">
          <ChannelsTab unitId={unitId} />
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
      </Tabs>
    </div>
  );
}

// ─── Tab: WhatsApp Channels ───────────────────────────────────────────────────

function buildWebhookUrl(channelId: string, secret: string): string {
  const base = (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/webhook-whatsapp?channel=${channelId}&secret=${secret}`;
}

function ChannelsTab({ unitId }: { unitId: string }) {
  const { data: channels, isLoading } = useWhatsAppChannels(unitId);
  const deleteChannel = useDeleteChannel(unitId);
  const testChannel = useTestChannel(unitId);
  const [addOpen, setAddOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
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
                      {ch.display_phone && (
                        <span className="text-sm text-muted-foreground">{ch.display_phone}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => testChannel.mutate(ch.id)}
                        disabled={testChannel.isPending}
                      >
                        <RefreshCw className="h-3 w-3 mr-1" />
                        Testar
                      </Button>
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

                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Webhook (configure no painel do provedor):
                    </p>
                    <div className="flex items-center gap-1.5">
                      <code
                        className="font-mono bg-muted px-1.5 py-0.5 rounded text-[10px] truncate flex-1 min-w-0"
                        title={buildWebhookUrl(ch.id, ch.webhook_secret)}
                      >
                        {buildWebhookUrl(ch.id, ch.webhook_secret)}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 shrink-0"
                        onClick={() =>
                          handleCopy(ch.id, buildWebhookUrl(ch.id, ch.webhook_secret))
                        }
                      >
                        {copiedId === ch.id ? (
                          <Check className="h-3 w-3 text-green-600" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddChannelDialog unitId={unitId} open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

function AddChannelDialog({
  unitId,
  open,
  onClose,
}: {
  unitId: string;
  open: boolean;
  onClose: () => void;
}) {
  const createChannel = useCreateChannel(unitId);
  const [provider, setProvider] = useState<WhatsAppProvider>("zapi");

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
    setProvider("zapi");
    setInstanceId(""); setToken(""); setClientToken("");
    setBaseUrl(""); setApiKey(""); setSessionName("");
    setPhoneNumberId(""); setBusinessAccountId(""); setAccessToken(""); setAppSecret("");
  };

  const getCredentials = () => {
    if (provider === "zapi") return { instance_id: instanceId, token, client_token: clientToken };
    if (provider === "waha") return { base_url: baseUrl, api_key: apiKey, session_name: sessionName };
    return { phone_number_id: phoneNumberId, business_account_id: businessAccountId, access_token: accessToken, app_secret: appSecret };
  };

  const handleCreate = () => {
    createChannel.mutate(
      { provider, credentials: getCredentials() },
      {
        onSuccess: () => { toast.success("Canal adicionado."); onClose(); reset(); },
        onError: (err: Error) => toast.error(err.message || "Erro ao adicionar canal."),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Adicionar canal WhatsApp</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="space-y-1">
            <Label>Plataforma</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as WhatsAppProvider)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
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

          <div className="rounded-lg border border-dashed p-3 bg-muted/30 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Após adicionar:</p>
            <p>
              A URL completa do webhook (com o secret) será exibida no card do canal.
              Copie e cole no painel do provedor (campo "Ao receber" / "On receive").
            </p>
          </div>

          <Button onClick={handleCreate} disabled={createChannel.isPending} className="w-full">
            Adicionar canal
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
                <SelectItem value={savedModel} className="text-amber-700">
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
              <Badge variant="outline" className="text-[10px] text-green-700 border-green-200 bg-green-50">
                Salva
              </Badge>
            </div>
          ) : (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
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
  if (tone === "good") return "text-green-700 bg-green-50 border-green-200";
  if (tone === "warn") return "text-amber-700 bg-amber-50 border-amber-200";
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

  const { channel, ai, stats_24h, last_executions, generated_at } = data;
  const successRate = stats_24h.total > 0
    ? Math.round(((stats_24h.by_outcome.success ?? 0) / stats_24h.total) * 100)
    : null;

  return (
    <div className="space-y-4">
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
                  <p className="font-medium">{channel.display_phone ?? "—"}</p>
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
                <Badge variant="outline" className="text-[10px] text-green-700 bg-green-50 border-green-200">
                  BYOK ••••{ai.byok_last4}
                </Badge>
              )}
              {ai.key_source === "global" && (
                <Badge variant="outline" className="text-[10px] text-amber-700 bg-amber-50 border-amber-200">
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

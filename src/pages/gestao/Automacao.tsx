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
import type { WhatsAppChannel, WhatsAppProvider } from "@/types/reserva";

// ─── AI provider config ────────────────────────────────────────────────────────

type AIProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek";

interface AIConfig {
  provider: AIProvider;
  models: Partial<Record<AIProvider, string>>;
}

const PROVIDERS: Array<{
  id: AIProvider;
  label: string;
  defaultModel: string;
  envKey: string;
  modelPlaceholder: string;
}> = [
  { id: "claude", label: "Claude (Anthropic)", defaultModel: "claude-haiku-4-5", envKey: "ANTHROPIC_API_KEY", modelPlaceholder: "claude-haiku-4-5" },
  { id: "openai", label: "OpenAI (ChatGPT)", defaultModel: "gpt-4o", envKey: "OPENAI_API_KEY", modelPlaceholder: "gpt-4o" },
  { id: "gemini", label: "Gemini (Google)", defaultModel: "gemini-2.0-flash", envKey: "GEMINI_API_KEY", modelPlaceholder: "gemini-2.0-flash" },
  { id: "grok", label: "Grok (xAI)", defaultModel: "grok-3", envKey: "GROK_API_KEY", modelPlaceholder: "grok-3" },
  { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat", envKey: "DEEPSEEK_API_KEY", modelPlaceholder: "deepseek-chat" },
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
                <CardContent className="py-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium text-sm">{PROVIDER_LABELS[ch.provider]}</span>
                      <Badge variant="outline" className={`text-[10px] gap-1 ${statusCfg.className}`}>
                        {statusCfg.icon}
                        {statusCfg.label}
                      </Badge>
                    </div>
                    {ch.display_phone && (
                      <p className="text-sm text-muted-foreground">{ch.display_phone}</p>
                    )}
                    {ch.last_error && (
                      <p className="text-xs text-destructive mt-0.5 truncate">{ch.last_error}</p>
                    )}
                    <div className="mt-2 space-y-1">
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
                        <Button variant="ghost" size="icon">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remover canal?</AlertDialogTitle>
                          <AlertDialogDescription>
                            O agente deixará de receber mensagens por este canal. Esta ação não pode ser desfeita.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteChannel.mutate(ch.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remover
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
        onError: () => toast.error("Erro ao adicionar canal."),
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
    onError: () => toast.error("Erro ao salvar."),
  });

  const activeProvider = PROVIDERS.find((p) => p.id === aiConfig.provider)!;

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
          <Input
            className="w-64"
            placeholder={activeProvider.modelPlaceholder}
            value={aiConfig.models?.[aiConfig.provider] ?? ""}
            onChange={(e) =>
              setAiConfig((prev) => ({
                ...prev,
                models: { ...prev.models, [prev.provider]: e.target.value },
              }))
            }
            onBlur={(e) => setModelOverride(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Padrão: <code className="bg-muted px-1 rounded">{activeProvider.defaultModel}</code>
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
            <p className="text-xs text-muted-foreground">
              Nenhuma chave cadastrada para este provedor nesta unidade.
              Enquanto não cadastrar, o agente usa o secret global da plataforma (se configurado).
            </p>
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
                        O agente voltará a usar o secret global da plataforma (se houver).
                        Sem chave nem fallback, as mensagens vão falhar.
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
  }, [settings]);

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
    onError: () => toast.error("Erro ao salvar."),
  });

  function saveAll() {
    Promise.all([
      saveSetting.mutateAsync({ key: "agent_mode", value: agentMode }),
      saveSetting.mutateAsync({ key: "restaurant_menu", value: restaurantMenu }),
      saveSetting.mutateAsync({ key: "delivery_response", value: deliveryResponse }),
      saveSetting.mutateAsync({ key: "restaurant_extra_info", value: restaurantExtraInfo }),
      saveSetting.mutateAsync({ key: "ai_system_prompt", value: systemPrompt }),
    ])
      .then(() => toast.success("Configuração do agente salva."))
      .catch(() => toast.error("Erro ao salvar configuração."));
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

        <Button onClick={saveAll} disabled={saveSetting.isPending}>
          Salvar configuração
        </Button>
      </CardContent>
    </Card>
  );
}

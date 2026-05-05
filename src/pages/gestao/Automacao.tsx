import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
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
  Bot,
  Check,
  Copy,
  Info,
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
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center gap-2">
        <Zap className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Automação</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Configure os canais de WhatsApp, o provedor de IA e as instruções do agente.
      </p>

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

        <div className="rounded-lg border border-dashed p-4 space-y-2 bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Info className="h-4 w-4 text-primary shrink-0" />
            Como configurar a chave de API
          </div>
          <p className="text-sm text-muted-foreground">
            Por segurança, a chave de API é configurada como secret no Supabase.
          </p>
          <div className="mt-2 rounded bg-background border p-3 font-mono text-xs space-y-1">
            <p className="text-muted-foreground"># Execute no terminal:</p>
            <p>supabase secrets set <span className="text-primary">{activeProvider.envKey}</span>=sua_chave_aqui</p>
          </div>
          <div className="mt-3 space-y-1">
            <p className="text-xs text-muted-foreground font-medium">Variáveis por provedor:</p>
            <div className="grid grid-cols-1 gap-1">
              {PROVIDERS.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between rounded px-2 py-1 text-xs ${
                    p.id === aiConfig.provider ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground"
                  }`}
                >
                  <span>{p.label}</span>
                  <code className="font-mono">{p.envKey}</code>
                  {p.id === aiConfig.provider && (
                    <Badge variant="outline" className="text-[10px] ml-2 text-primary border-primary/30">ativo</Badge>
                  )}
                </div>
              ))}
            </div>
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

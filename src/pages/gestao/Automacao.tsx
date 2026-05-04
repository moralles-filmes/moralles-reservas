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
  { id: "claude", label: "Claude (Anthropic)", defaultModel: "claude-sonnet-4-6", envKey: "ANTHROPIC_API_KEY", modelPlaceholder: "claude-sonnet-4-6" },
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

function ChannelsTab({ unitId }: { unitId: string }) {
  const { data: channels, isLoading } = useWhatsAppChannels(unitId);
  const deleteChannel = useDeleteChannel(unitId);
  const testChannel = useTestChannel(unitId);
  const [addOpen, setAddOpen] = useState(false);

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
                    <p className="text-xs text-muted-foreground mt-2">
                      Webhook:{" "}
                      <code className="font-mono bg-muted px-1 rounded text-[10px]">
                        /functions/v1/webhook-whatsapp?channel={ch.id}
                      </code>
                    </p>
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
            <p>Configure o webhook no painel da plataforma apontando para:</p>
            <code className="block font-mono bg-background rounded px-2 py-1 text-[11px]">
              /functions/v1/webhook-whatsapp?channel={"<id-do-canal>"}
            </code>
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

// ─── Tab: System Prompt ───────────────────────────────────────────────────────

function PromptTab({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
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
      toast.success("Instruções salvas.");
    },
    onError: () => toast.error("Erro ao salvar."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Instruções do Agente IA</CardTitle>
        <p className="text-sm text-muted-foreground">
          Personalize como o agente se comporta. Válido para todos os provedores.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={10}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Você é o assistente de reservas do restaurante. Seja cordial e eficiente..."
          className="font-mono text-sm"
        />
        <Button
          onClick={() => saveSetting.mutate({ key: "ai_system_prompt", value: systemPrompt })}
          disabled={saveSetting.isPending}
        >
          Salvar instruções
        </Button>
      </CardContent>
    </Card>
  );
}

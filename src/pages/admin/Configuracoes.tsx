import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BusinessHour } from "@/types/reserva";
import { DAY_NAMES } from "@/types/reserva";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Bot, Info } from "lucide-react";

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
  {
    id: "claude",
    label: "Claude (Anthropic)",
    defaultModel: "claude-sonnet-4-6",
    envKey: "ANTHROPIC_API_KEY",
    modelPlaceholder: "claude-sonnet-4-6",
  },
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
    modelPlaceholder: "gpt-4o",
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    defaultModel: "gemini-2.0-flash",
    envKey: "GEMINI_API_KEY",
    modelPlaceholder: "gemini-2.0-flash",
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    defaultModel: "grok-3",
    envKey: "GROK_API_KEY",
    modelPlaceholder: "grok-3",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    modelPlaceholder: "deepseek-chat",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function Configuracoes() {
  const queryClient = useQueryClient();

  const [systemPrompt, setSystemPrompt] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    provider: "claude",
    models: {},
  });

  // ── Load data ──────────────────────────────────────────────────────────────

  const { data: businessHours, isLoading: loadingHours } = useQuery({
    queryKey: ["business-hours"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_hours")
        .select("*")
        .order("day_of_week");
      if (error) throw error;
      return data as BusinessHour[];
    },
  });

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("settings").select("*");
      if (error) throw error;
      return data as Array<{ key: string; value: any }>;
    },
  });

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    setSystemPrompt(map["ai_system_prompt"] ?? "");
    setRestaurantName(map["restaurant_name"] ?? "");
    if (map["ai_config"]) {
      setAiConfig(map["ai_config"] as AIConfig);
    }
  }, [settings]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateHour = useMutation({
    mutationFn: async (hour: BusinessHour) => {
      const { error } = await supabase
        .from("business_hours")
        .update(hour)
        .eq("id", hour.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["business-hours"] }),
    onError: () => toast.error("Erro ao salvar horário."),
  });

  const saveSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      const { error } = await supabase
        .from("settings")
        .upsert({ key, value }, { onConflict: "key" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Configuração salva.");
    },
    onError: () => toast.error("Erro ao salvar."),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const activeProvider = PROVIDERS.find((p) => p.id === aiConfig.provider)!;

  const updateAiConfig = (patch: Partial<AIConfig>) => {
    const updated = { ...aiConfig, ...patch };
    setAiConfig(updated);
    saveSetting.mutate({ key: "ai_config", value: updated });
  };

  const setModelOverride = (model: string) => {
    updateAiConfig({
      models: { ...aiConfig.models, [aiConfig.provider]: model || undefined },
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Configurações</h1>

      {/* Restaurant info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Informações do restaurante</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Nome do restaurante</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                placeholder="Ex: Moralles Restaurante"
              />
              <Button
                variant="secondary"
                onClick={() =>
                  saveSetting.mutate({ key: "restaurant_name", value: restaurantName })
                }
              >
                Salvar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Business hours */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Horários de funcionamento</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingHours ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {(businessHours || []).map((h) => (
                <div key={h.id} className="flex items-center gap-3 flex-wrap">
                  <span className="w-20 text-sm font-medium shrink-0">
                    {DAY_NAMES[h.day_of_week]}
                  </span>
                  <Switch
                    checked={!h.is_closed}
                    onCheckedChange={(open) =>
                      updateHour.mutate({ ...h, is_closed: !open })
                    }
                  />
                  {!h.is_closed ? (
                    <>
                      <Input
                        type="time"
                        defaultValue={h.open_time}
                        className="w-28"
                        onBlur={(e) =>
                          updateHour.mutate({ ...h, open_time: e.target.value })
                        }
                      />
                      <span className="text-muted-foreground text-sm">até</span>
                      <Input
                        type="time"
                        defaultValue={h.close_time}
                        className="w-28"
                        onBlur={(e) =>
                          updateHour.mutate({ ...h, close_time: e.target.value })
                        }
                      />
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">Fechado</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* AI Provider */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Provedor de IA</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Escolha qual IA responde os clientes via WhatsApp.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Provider selector */}
          <div className="space-y-1">
            <Label>Provedor ativo</Label>
            <Select
              value={aiConfig.provider}
              onValueChange={(v) => updateAiConfig({ provider: v as AIProvider })}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model override */}
          <div className="space-y-1">
            <Label>Modelo</Label>
            <Input
              className="w-64"
              placeholder={activeProvider.modelPlaceholder}
              value={aiConfig.models?.[aiConfig.provider] ?? ""}
              onChange={(e) => {
                setAiConfig((prev) => ({
                  ...prev,
                  models: { ...prev.models, [prev.provider]: e.target.value },
                }));
              }}
              onBlur={(e) => setModelOverride(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Padrão: <code className="bg-muted px-1 rounded">{activeProvider.defaultModel}</code>
            </p>
          </div>

          {/* API key instructions */}
          <div className="rounded-lg border border-dashed p-4 space-y-2 bg-muted/30">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4 text-primary shrink-0" />
              Como configurar a chave de API
            </div>
            <p className="text-sm text-muted-foreground">
              Por segurança, a chave de API é configurada como secret no Supabase — não fica
              armazenada no banco de dados.
            </p>
            <div className="mt-2 rounded bg-background border p-3 font-mono text-xs space-y-1">
              <p className="text-muted-foreground"># Execute no terminal:</p>
              <p>
                supabase secrets set{" "}
                <span className="text-primary">{activeProvider.envKey}</span>=sua_chave_aqui
              </p>
            </div>
            <div className="mt-3 space-y-1">
              <p className="text-xs text-muted-foreground font-medium">
                Variáveis de ambiente por provedor:
              </p>
              <div className="grid grid-cols-1 gap-1">
                {PROVIDERS.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between rounded px-2 py-1 text-xs ${
                      p.id === aiConfig.provider
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground"
                    }`}
                  >
                    <span>{p.label}</span>
                    <code className="font-mono">{p.envKey}</code>
                    {p.id === aiConfig.provider && (
                      <Badge variant="outline" className="text-[10px] ml-2 text-primary border-primary/30">
                        ativo
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* AI System Prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Instruções do Agente IA</CardTitle>
          <p className="text-sm text-muted-foreground">
            Personalize como o agente se comporta nas conversas via WhatsApp. Vale para todos os
            provedores.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={8}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Você é o assistente de reservas do restaurante. Seja cordial e eficiente..."
            className="font-mono text-sm"
          />
          <Button
            onClick={() =>
              saveSetting.mutate({ key: "ai_system_prompt", value: systemPrompt })
            }
            disabled={saveSetting.isPending}
          >
            Salvar instruções
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

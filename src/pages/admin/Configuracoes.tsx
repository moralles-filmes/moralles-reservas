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
import type { BusinessHour } from "@/types/reserva";
import { DAY_NAMES } from "@/types/reserva";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Bot, CalendarPlus, Info, Mail, KeyRound, UserPlus, Users, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  useAdminUsers,
  useCreateAdmin,
  useDeleteAdmin,
  type AdminUser,
} from "@/hooks/useAdminUsers";
import {
  useSpecialDates,
  useUpsertSpecialDate,
  useDeleteSpecialDate,
} from "@/hooks/useSpecialDates";
import type { SpecialDate } from "@/types/reserva";
import { formatDateBR } from "@/lib/utils";

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
    defaultModel: "claude-haiku-4-5",
    envKey: "ANTHROPIC_API_KEY",
    modelPlaceholder: "claude-haiku-4-5",
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
  const { user, isSuperAdmin, updateEmail, updatePassword } = useAuth();

  const [systemPrompt, setSystemPrompt] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    provider: "claude",
    models: {},
  });

  // Account form state
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // New admin form state
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  // Admin users data + mutations
  const { data: adminUsers, isLoading: loadingAdmins } = useAdminUsers();
  const createAdmin = useCreateAdmin();
  const deleteAdmin = useDeleteAdmin();

  const updateEmailMutation = useMutation({
    mutationFn: (email: string) => updateEmail(email),
    onSuccess: () => {
      toast.success("E-mail atualizado. Confirme o link enviado, se solicitado.");
      setNewEmail("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updatePasswordMutation = useMutation({
    mutationFn: (password: string) => updatePassword(password),
    onSuccess: () => {
      toast.success("Senha atualizada.");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleUpdateEmail = () => {
    const email = newEmail.trim();
    if (!email) {
      toast.error("Informe o novo e-mail.");
      return;
    }
    if (email === user?.email) {
      toast.error("O novo e-mail é igual ao atual.");
      return;
    }
    updateEmailMutation.mutate(email);
  };

  const handleUpdatePassword = () => {
    if (newPassword.length < 6) {
      toast.error("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("As senhas não coincidem.");
      return;
    }
    updatePasswordMutation.mutate(newPassword);
  };

  const handleCreateAdmin = () => {
    const email = adminEmail.trim().toLowerCase();
    if (!email || !adminPassword) {
      toast.error("Preencha e-mail e senha.");
      return;
    }
    if (adminPassword.length < 6) {
      toast.error("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    createAdmin.mutate(
      { email, password: adminPassword },
      {
        onSuccess: () => {
          setAdminEmail("");
          setAdminPassword("");
        },
      }
    );
  };

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
      return data as Array<{ key: string; value: unknown }>;
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
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
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

      {/* Special dates */}
      <SpecialDatesSection />

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

      <Separator />

      {/* My account */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Minha conta</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Atualize o e-mail e a senha do usuário logado.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Email */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" />
              E-mail
            </Label>
            <p className="text-xs text-muted-foreground">
              Atual: <span className="font-mono">{user?.email ?? "—"}</span>
            </p>
            <div className="flex gap-2">
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="novo@email.com"
              />
              <Button
                variant="secondary"
                onClick={handleUpdateEmail}
                disabled={updateEmailMutation.isPending}
              >
                Atualizar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Se o Supabase exigir confirmação, um link será enviado para o novo e-mail.
            </p>
          </div>

          <Separator />

          {/* Password */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5" />
              Trocar senha
            </Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Nova senha (mín. 6 caracteres)"
            />
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirmar nova senha"
            />
            <Button
              variant="secondary"
              onClick={handleUpdatePassword}
              disabled={updatePasswordMutation.isPending}
            >
              Atualizar senha
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* end of main column — special dates inserted above; admin users below */}
      {/* Admin users — super admin only */}
      {isSuperAdmin && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">Usuários administradores</CardTitle>
              </div>
              <p className="text-sm text-muted-foreground">
                Cadastre novos administradores e gerencie quem tem acesso ao painel.
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Create form */}
              <div className="space-y-2 rounded-lg border border-dashed p-4 bg-muted/30">
                <Label className="flex items-center gap-2">
                  <UserPlus className="h-3.5 w-3.5" />
                  Cadastrar novo administrador
                </Label>
                <Input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="email@exemplo.com"
                />
                <Input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Senha (mín. 6 caracteres)"
                />
                <Button
                  onClick={handleCreateAdmin}
                  disabled={createAdmin.isPending}
                >
                  Cadastrar admin
                </Button>
              </div>

              {/* List */}
              <div className="space-y-2">
                <Label>Administradores cadastrados</Label>
                {loadingAdmins ? (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : !adminUsers || adminUsers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum administrador cadastrado.
                  </p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {adminUsers.map((admin: AdminUser) => {
                      const isSelf = admin.id === user?.id;
                      const isProtected =
                        isSelf || admin.role === "super_admin";
                      return (
                        <div
                          key={admin.id}
                          className="flex items-center justify-between gap-3 p-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm truncate">
                                {admin.email}
                              </span>
                              {admin.role === "super_admin" && (
                                <Badge variant="outline" className="text-[10px] text-primary border-primary/30">
                                  super admin
                                </Badge>
                              )}
                              {isSelf && (
                                <Badge variant="outline" className="text-[10px]">
                                  você
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Cadastrado em {formatDateBR(admin.created_at)}
                            </p>
                          </div>
                          {!isProtected && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Excluir">
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Excluir administrador?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    A conta de <span className="font-mono">{admin.email}</span>{" "}
                                    será removida do sistema e essa pessoa perderá acesso ao
                                    painel imediatamente. Esta ação não pode ser desfeita.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => deleteAdmin.mutate(admin.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Excluir
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Datas especiais (feriados, eventos, horário diferenciado) ───────────────

function SpecialDatesSection() {
  const { data: dates, isLoading } = useSpecialDates();
  const upsert = useUpsertSpecialDate();
  const remove = useDeleteSpecialDate();

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [isClosed, setIsClosed] = useState(false);
  const [openTime, setOpenTime] = useState("12:00");
  const [closeTime, setCloseTime] = useState("22:00");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setDate("");
    setName("");
    setIsClosed(false);
    setOpenTime("12:00");
    setCloseTime("22:00");
    setNotes("");
  };

  const handleSave = () => {
    if (!date || !name.trim()) {
      toast.error("Preencha data e nome.");
      return;
    }
    if (!isClosed && (!openTime || !closeTime)) {
      toast.error("Defina abertura e fechamento, ou marque como fechado.");
      return;
    }
    upsert.mutate(
      {
        date,
        name: name.trim(),
        is_closed: isClosed,
        open_time: isClosed ? null : openTime,
        close_time: isClosed ? null : closeTime,
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success("Data salva.");
          setOpen(false);
          reset();
        },
        onError: () => toast.error("Erro ao salvar data."),
      }
    );
  };

  const upcoming = (dates ?? []).filter((d) => d.date >= new Date().toISOString().slice(0, 10));
  const past = (dates ?? []).filter((d) => d.date < new Date().toISOString().slice(0, 10));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarPlus className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Datas especiais</CardTitle>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
          <DialogTrigger asChild>
            <Button size="sm" variant="secondary">
              Adicionar data
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Data especial</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground -mt-2">
              Sobrescreve o horário padrão da semana nesta data específica.
            </p>
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Data</Label>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Nome</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Natal, Réveillon, Show…"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={isClosed} onCheckedChange={setIsClosed} />
                <span className="text-sm">Fechado neste dia</span>
              </div>
              {!isClosed && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Abertura</Label>
                    <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Fechamento</Label>
                    <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label>Observação (opcional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Ex: menu fixo, reservas obrigatórias…"
                />
              </div>
              <Button onClick={handleSave} disabled={upsert.isPending} className="w-full">
                Salvar
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !dates?.length ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Nenhuma data cadastrada.
          </p>
        ) : (
          <div className="space-y-4">
            {upcoming.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Próximas
                </p>
                <SpecialDatesList dates={upcoming} onDelete={(id) => remove.mutate(id)} />
              </div>
            )}
            {past.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Anteriores
                </p>
                <SpecialDatesList dates={past} onDelete={(id) => remove.mutate(id)} dimmed />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SpecialDatesList({
  dates,
  onDelete,
  dimmed = false,
}: {
  dates: SpecialDate[];
  onDelete: (id: string) => void;
  dimmed?: boolean;
}) {
  return (
    <div className={`divide-y rounded-lg border ${dimmed ? "opacity-60" : ""}`}>
      {dates.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{formatDateBR(d.date)}</span>
              <span className="text-sm text-muted-foreground truncate">{d.name}</span>
              {d.is_closed ? (
                <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">
                  Fechado
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  {d.open_time?.slice(0, 5)} – {d.close_time?.slice(0, 5)}
                </Badge>
              )}
            </div>
            {d.notes && (
              <p className="text-xs text-muted-foreground italic mt-0.5 truncate">{d.notes}</p>
            )}
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Excluir data">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir data especial?</AlertDialogTitle>
                <AlertDialogDescription>
                  O horário desta data voltará ao padrão da semana.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(d.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Excluir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ))}
    </div>
  );
}

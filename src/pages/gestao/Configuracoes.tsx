import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import type { BusinessHour, SpecialDate } from "@/types/reserva";
import { DAY_NAMES } from "@/types/reserva";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { CalendarPlus, KeyRound, Mail, Trash2, UserPlus, Users } from "lucide-react";
import {
  useSpecialDates,
  useUpsertSpecialDate,
  useDeleteSpecialDate,
} from "@/hooks/useSpecialDates";
import {
  useUnitMembers,
  useCreateUnitMember,
  useDeleteUnitMember,
  useUpdateMemberRole,
  type UnitMemberRow,
} from "@/hooks/useUnitMembers";
import { formatDateBR } from "@/lib/utils";
import type { UnitRole } from "@/types/reserva";

export default function Configuracoes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const queryClient = useQueryClient();
  const { user, updateEmail, updatePassword, isPlatformAdmin } = useAuth();
  const isOwnerOrGerente = unit?.isOwner || unit?.isGerente;

  const [restaurantName, setRestaurantName] = useState("");
  const [restaurantAddress, setRestaurantAddress] = useState("");
  const [restaurantPhone, setRestaurantPhone] = useState("");
  const [restaurantInstagram, setRestaurantInstagram] = useState("");
  const [restaurantWebsite, setRestaurantWebsite] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const { data: businessHours, isLoading: loadingHours } = useQuery({
    queryKey: ["business-hours", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_hours")
        .select("*")
        .eq("unit_id", unitId)
        .order("day_of_week");
      if (error) throw error;
      return data as BusinessHour[];
    },
    enabled: !!unitId,
  });

  const { data: settings } = useQuery({
    queryKey: ["settings", unitId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .eq("unit_id", unitId);
      if (error) throw error;
      return data as Array<{ key: string; value: unknown }>;
    },
    enabled: !!unitId,
  });

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    setRestaurantName((map["restaurant_name"] as string) ?? "");
    setRestaurantAddress((map["restaurant_address"] as string) ?? "");
    setRestaurantPhone((map["restaurant_phone"] as string) ?? "");
    setRestaurantInstagram((map["restaurant_instagram"] as string) ?? "");
    setRestaurantWebsite((map["restaurant_website"] as string) ?? "");
  }, [settings]);

  const updateHour = useMutation({
    mutationFn: async (hour: BusinessHour) => {
      const { error } = await supabase
        .from("business_hours")
        .update(hour)
        .eq("id", hour.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["business-hours", unitId] }),
    onError: () => toast.error("Erro ao salvar horário."),
  });

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
    if (!email) { toast.error("Informe o novo e-mail."); return; }
    if (email === user?.email) { toast.error("O novo e-mail é igual ao atual."); return; }
    updateEmailMutation.mutate(email);
  };

  const handleUpdatePassword = () => {
    if (newPassword.length < 6) { toast.error("A senha deve ter pelo menos 6 caracteres."); return; }
    if (newPassword !== confirmPassword) { toast.error("As senhas não coincidem."); return; }
    updatePasswordMutation.mutate(newPassword);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Configurações</h1>

      {/* Restaurant info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Informações da unidade</CardTitle>
          <p className="text-sm text-muted-foreground">
            Esses dados aparecem nas confirmações de reserva por e-mail. Endereço, telefone, Instagram e site são opcionais.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Nome do restaurante</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                placeholder="Ex: Moralles Centro"
                disabled={!isOwnerOrGerente}
              />
              <Button
                variant="secondary"
                onClick={() => saveSetting.mutate({ key: "restaurant_name", value: restaurantName })}
                disabled={saveSetting.isPending || !isOwnerOrGerente}
              >
                Salvar
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Endereço completo</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantAddress}
                onChange={(e) => setRestaurantAddress(e.target.value)}
                placeholder="Rua das Flores, 123 — Centro, São Paulo/SP"
                disabled={!isOwnerOrGerente}
              />
              <Button
                variant="secondary"
                onClick={() => saveSetting.mutate({ key: "restaurant_address", value: restaurantAddress })}
                disabled={saveSetting.isPending || !isOwnerOrGerente}
              >
                Salvar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Vira link clicável "Ver no Google Maps" no e-mail.
            </p>
          </div>

          <div className="space-y-1">
            <Label>Telefone para contato</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantPhone}
                onChange={(e) => setRestaurantPhone(e.target.value)}
                placeholder="(11) 3000-0000"
                disabled={!isOwnerOrGerente}
              />
              <Button
                variant="secondary"
                onClick={() => saveSetting.mutate({ key: "restaurant_phone", value: restaurantPhone })}
                disabled={saveSetting.isPending || !isOwnerOrGerente}
              >
                Salvar
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Instagram</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantInstagram}
                onChange={(e) => setRestaurantInstagram(e.target.value)}
                placeholder="@morallesrestaurante"
                disabled={!isOwnerOrGerente}
              />
              <Button
                variant="secondary"
                onClick={() => saveSetting.mutate({ key: "restaurant_instagram", value: restaurantInstagram })}
                disabled={saveSetting.isPending || !isOwnerOrGerente}
              >
                Salvar
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Site / link extra</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantWebsite}
                onChange={(e) => setRestaurantWebsite(e.target.value)}
                placeholder="https://moralles.com.br"
                disabled={!isOwnerOrGerente}
              />
              <Button
                variant="secondary"
                onClick={() => saveSetting.mutate({ key: "restaurant_website", value: restaurantWebsite })}
                disabled={saveSetting.isPending || !isOwnerOrGerente}
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
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <div className="space-y-3">
              {(businessHours || []).map((h) => (
                <div key={h.id} className="flex items-center gap-3 flex-wrap">
                  <span className="w-20 text-sm font-medium shrink-0">{DAY_NAMES[h.day_of_week]}</span>
                  <Switch
                    checked={!h.is_closed}
                    onCheckedChange={(open) => updateHour.mutate({ ...h, is_closed: !open })}
                  />
                  {!h.is_closed ? (
                    <>
                      <Input
                        type="time"
                        defaultValue={h.open_time}
                        className="w-28"
                        onBlur={(e) => updateHour.mutate({ ...h, open_time: e.target.value })}
                      />
                      <span className="text-muted-foreground text-sm">até</span>
                      <Input
                        type="time"
                        defaultValue={h.close_time}
                        className="w-28"
                        onBlur={(e) => updateHour.mutate({ ...h, close_time: e.target.value })}
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
      <SpecialDatesSection unitId={unitId} />

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

      {/* Unit members — owner/gerente only */}
      {(isOwnerOrGerente || isPlatformAdmin) && (
        <>
          <Separator />
          <UnitMembersSection unitId={unitId} currentUserId={user?.id ?? ""} isOwner={!!unit?.isOwner || isPlatformAdmin} />
        </>
      )}
    </div>
  );
}

// ─── Special dates ────────────────────────────────────────────────────────────

function SpecialDatesSection({ unitId }: { unitId: string }) {
  const { data: dates, isLoading } = useSpecialDates(unitId);
  const upsert = useUpsertSpecialDate(unitId);
  const remove = useDeleteSpecialDate(unitId);

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [isClosed, setIsClosed] = useState(false);
  const [openTime, setOpenTime] = useState("12:00");
  const [closeTime, setCloseTime] = useState("22:00");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setDate(""); setName(""); setIsClosed(false);
    setOpenTime("12:00"); setCloseTime("22:00"); setNotes("");
  };

  const handleSave = () => {
    if (!date || !name.trim()) { toast.error("Preencha data e nome."); return; }
    if (!isClosed && (!openTime || !closeTime)) { toast.error("Defina abertura e fechamento, ou marque como fechado."); return; }
    upsert.mutate(
      { date, name: name.trim(), is_closed: isClosed, open_time: isClosed ? null : openTime, close_time: isClosed ? null : closeTime, notes: notes.trim() || null },
      {
        onSuccess: () => { toast.success("Data salva."); setOpen(false); reset(); },
        onError: () => toast.error("Erro ao salvar data."),
      }
    );
  };

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (dates ?? []).filter((d) => d.date >= today);
  const past = (dates ?? []).filter((d) => d.date < today);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarPlus className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Datas especiais</CardTitle>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
          <DialogTrigger asChild>
            <Button size="sm" variant="secondary">Adicionar data</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Data especial</DialogTitle></DialogHeader>
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
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Natal, Réveillon, Show…" />
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
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex: menu fixo, reservas obrigatórias…" />
              </div>
              <Button onClick={handleSave} disabled={upsert.isPending} className="w-full">Salvar</Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !dates?.length ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma data cadastrada.</p>
        ) : (
          <div className="space-y-4">
            {upcoming.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Próximas</p>
                <SpecialDatesList dates={upcoming} onDelete={(id) => remove.mutate(id)} />
              </div>
            )}
            {past.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Anteriores</p>
                <SpecialDatesList dates={past} onDelete={(id) => remove.mutate(id)} dimmed />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SpecialDatesList({ dates, onDelete, dimmed = false }: { dates: SpecialDate[]; onDelete: (id: string) => void; dimmed?: boolean }) {
  return (
    <div className={`divide-y rounded-lg border ${dimmed ? "opacity-60" : ""}`}>
      {dates.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{formatDateBR(d.date)}</span>
              <span className="text-sm text-muted-foreground truncate">{d.name}</span>
              {d.is_closed ? (
                <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">Fechado</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">{d.open_time?.slice(0, 5)} – {d.close_time?.slice(0, 5)}</Badge>
              )}
            </div>
            {d.notes && <p className="text-xs text-muted-foreground italic mt-0.5 truncate">{d.notes}</p>}
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
                <AlertDialogDescription>O horário desta data voltará ao padrão da semana.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={() => onDelete(d.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Excluir</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ))}
    </div>
  );
}

// ─── Unit members ─────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<UnitRole, string> = {
  owner: "Proprietário",
  gerente: "Gerente",
  operador: "Operador",
};

function UnitMembersSection({
  unitId,
  currentUserId,
  isOwner,
}: {
  unitId: string;
  currentUserId: string;
  isOwner: boolean;
}) {
  const { data: members, isLoading } = useUnitMembers(unitId);
  const createMember = useCreateUnitMember(unitId);
  const deleteMember = useDeleteUnitMember(unitId);
  const updateRole = useUpdateMemberRole(unitId);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UnitRole>("operador");

  const handleCreate = () => {
    const trimEmail = email.trim().toLowerCase();
    if (!trimEmail || !password) { toast.error("Preencha e-mail e senha."); return; }
    if (password.length < 6) { toast.error("A senha deve ter pelo menos 6 caracteres."); return; }
    createMember.mutate(
      { email: trimEmail, password, role },
      { onSuccess: () => { setEmail(""); setPassword(""); } }
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Membros da equipe</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Gerencie quem tem acesso ao painel desta unidade.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {isOwner && (
          <div className="space-y-2 rounded-lg border border-dashed p-4 bg-muted/30">
            <Label className="flex items-center gap-2">
              <UserPlus className="h-3.5 w-3.5" />
              Cadastrar membro
            </Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@exemplo.com" />
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Senha (mín. 6 caracteres)" />
            <Select value={role} onValueChange={(v) => setRole(v as UnitRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="operador">Operador</SelectItem>
                <SelectItem value="gerente">Gerente</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleCreate} disabled={createMember.isPending}>Cadastrar membro</Button>
          </div>
        )}

        <div className="space-y-2">
          {isLoading ? (
            <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !members?.length ? (
            <p className="text-sm text-muted-foreground">Nenhum membro cadastrado.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {members.map((m: UnitMemberRow) => {
                const isSelf = m.user_id === currentUserId;
                return (
                  <div key={m.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{m.email ?? m.user_id.slice(0, 8)}</span>
                        <Badge variant="outline" className="text-[10px]">{ROLE_LABELS[m.role]}</Badge>
                        {isSelf && <Badge variant="outline" className="text-[10px]">você</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">Adicionado em {formatDateBR(m.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isOwner && !isSelf && m.role !== "owner" && (
                        <Select
                          value={m.role}
                          onValueChange={(v) => updateRole.mutate({ memberId: m.id, role: v as UnitRole })}
                        >
                          <SelectTrigger className="h-8 w-32 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="operador">Operador</SelectItem>
                            <SelectItem value="gerente">Gerente</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      {isOwner && !isSelf && m.role !== "owner" && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Remover membro">
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remover membro?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Esta pessoa perderá acesso ao painel desta unidade imediatamente.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMember.mutate(m.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Remover
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

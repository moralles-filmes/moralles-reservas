import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAuth } from "@/hooks/useAuth";
import { slugify } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { KeyRound, Mail } from "lucide-react";

const SLUG_REGEX = /^[a-z0-9-]+$/;

export default function Configuracoes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, updateEmail, updatePassword, refreshMemberships } = useAuth();
  const isOwnerOrGerente = unit?.isOwner || unit?.isGerente;

  const [restaurantName, setRestaurantName] = useState("");
  const [restaurantSlug, setRestaurantSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [restaurantAddress, setRestaurantAddress] = useState("");
  const [restaurantPhone, setRestaurantPhone] = useState("");
  const [restaurantInstagram, setRestaurantInstagram] = useState("");
  const [restaurantWebsite, setRestaurantWebsite] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setRestaurantName(unit?.unit_name ?? "");
  }, [unit?.unit_name]);

  useEffect(() => {
    setRestaurantSlug(unit?.unit_slug ?? "");
    setSlugTouched(false);
  }, [unit?.unit_slug]);

  useEffect(() => {
    if (!settings) return;
    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    setRestaurantAddress((map["restaurant_address"] as string) ?? "");
    setRestaurantPhone((map["restaurant_phone"] as string) ?? "");
    setRestaurantInstagram((map["restaurant_instagram"] as string) ?? "");
    setRestaurantWebsite((map["restaurant_website"] as string) ?? "");
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

  const saveUnitIdentity = useMutation({
    mutationFn: async ({ name, slug }: { name: string; slug: string }) => {
      const trimmedName = name.trim();
      const normalizedSlug = slug.trim().toLowerCase();
      if (!trimmedName) throw new Error("Nome não pode ficar vazio.");
      if (!normalizedSlug) throw new Error("Slug não pode ficar vazio.");
      if (!SLUG_REGEX.test(normalizedSlug)) {
        throw new Error("Slug aceita apenas letras minúsculas, números e hífens.");
      }
      const oldSlug = unit?.unit_slug ?? "";
      const nameChanged = trimmedName !== (unit?.unit_name ?? "");
      const slugChanged = normalizedSlug !== oldSlug;
      if (!nameChanged && !slugChanged) return { oldSlug, newSlug: oldSlug, slugChanged: false };

      const patch: { name?: string; slug?: string } = {};
      if (nameChanged) patch.name = trimmedName;
      if (slugChanged) patch.slug = normalizedSlug;

      const { error: updateError } = await supabase
        .from("units")
        .update(patch)
        .eq("id", unitId);
      if (updateError) {
        if (updateError.code === "23505") {
          throw new Error("Esse slug já está em uso por outra unidade.");
        }
        throw updateError;
      }
      // Limpa setting legado para que e-mails/WhatsApp passem a usar units.name via fallback
      if (nameChanged) {
        await supabase
          .from("settings")
          .delete()
          .eq("unit_id", unitId)
          .eq("key", "restaurant_name");
      }
      return { oldSlug, newSlug: normalizedSlug, slugChanged };
    },
    onSuccess: async ({ oldSlug, newSlug, slugChanged }) => {
      await refreshMemberships();
      queryClient.invalidateQueries({ queryKey: ["settings", unitId] });
      queryClient.invalidateQueries({ queryKey: ["all-units"] });
      queryClient.invalidateQueries({ queryKey: ["unit-public-content", unitId] });
      queryClient.invalidateQueries({ queryKey: ["public-unit"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success(
        slugChanged
          ? "Unidade atualizada. URLs antigas com o slug anterior deixaram de funcionar."
          : "Unidade atualizada.",
      );
      if (slugChanged && oldSlug && newSlug) {
        const nextPath = location.pathname.replace(`/g/${oldSlug}`, `/g/${newSlug}`);
        navigate(nextPath, { replace: true });
      }
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao salvar."),
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
            <Input
              value={restaurantName}
              onChange={(e) => {
                const nextName = e.target.value;
                setRestaurantName(nextName);
                if (!slugTouched) setRestaurantSlug(slugify(nextName));
              }}
              placeholder="Ex: Moralles Centro"
              disabled={!isOwnerOrGerente}
            />
          </div>

          <div className="space-y-1">
            <Label>Slug (URL pública)</Label>
            <div className="flex gap-2">
              <Input
                value={restaurantSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setRestaurantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
                placeholder="moralles-centro"
                disabled={!isOwnerOrGerente}
                className="font-mono"
              />
              <Button
                variant="secondary"
                onClick={() =>
                  saveUnitIdentity.mutate({ name: restaurantName, slug: restaurantSlug })
                }
                disabled={saveUnitIdentity.isPending || !isOwnerOrGerente}
              >
                Salvar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Aparece em <span className="font-mono">/r/{restaurantSlug || "—"}</span>,{" "}
              <span className="font-mono">/g/{restaurantSlug || "—"}</span> e nos links de
              confirmação/lembrete. Alterar invalida QR codes impressos e links já enviados.
            </p>
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
    </div>
  );
}

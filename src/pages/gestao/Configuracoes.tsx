import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useState } from "react";
import { KeyRound, Mail } from "lucide-react";

export default function Configuracoes() {
  const unit = useCurrentUnit();
  const unitSlug = unit?.unit_slug ?? "";
  const { user, updateEmail, updatePassword } = useAuth();

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
      <PageHeader
        breadcrumb={[
          { label: "Início", to: `/g/${unitSlug}` },
          { label: "Minha conta" },
        ]}
        title="Minha conta"
        description="E-mail e senha do usuário logado. Dados da unidade ficam em Conta."
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Acesso</CardTitle>
          </div>
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

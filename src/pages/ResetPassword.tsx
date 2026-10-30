import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent, CardHeader } from "@/components/ui/card";
import { BrandMark } from "@/components/layouts/BrandMark";
import { toast } from "sonner";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      toast.error("As senhas não coincidem.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Senha atualizada com sucesso!");
      navigate("/admin");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao atualizar senha.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ambient min-h-[100dvh] flex items-center justify-center bg-background px-4 py-8">
      <div className="glass rounded-panel w-full max-w-[400px] text-card-foreground">
        <CardHeader className="p-6 text-center sm:p-8">
          <div className="mb-4 flex justify-center">
            <BrandMark />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Nova senha</h1>
          <p className="text-sm text-muted-foreground">Moralles Reservas</p>
        </CardHeader>
        <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="password">Nova senha</Label>
              <Input
                className="h-12 sm:h-11 coarse:h-12 text-base"
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                placeholder="mín. 6 caracteres"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm">Confirmar senha</Label>
              <Input
                className="h-12 sm:h-11 coarse:h-12 text-base"
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                placeholder="repita a senha"
              />
            </div>
            <Button type="submit" className="w-full h-12 sm:h-11" disabled={loading}>
              {loading ? "Salvando..." : "Salvar nova senha"}
            </Button>
          </form>
        </CardContent>
      </div>
    </div>
  );
}

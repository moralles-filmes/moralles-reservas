import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent, CardHeader } from "@/components/ui/card";
import { BrandMark } from "@/components/layouts/BrandMark";
import { toast } from "sonner";

export default function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const { user, signIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate("/admin", { replace: true });
  }, [user, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await signIn(email, password);
      navigate("/admin");
    } catch (err: any) {
      toast.error(err?.message || "Credenciais inválidas.");
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      toast.success("E-mail enviado! Verifique sua caixa de entrada.");
      setMode("login");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao enviar e-mail.");
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
          <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Área Administrativa" : "Redefinir senha"}</h1>
          <p className="text-sm text-muted-foreground">Moralles Reservas</p>
        </CardHeader>
        <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
          {mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  className="h-12 sm:h-11 coarse:h-12 text-base"
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="password">Senha</Label>
                <Input
                  className="h-12 sm:h-11 coarse:h-12 text-base"
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full h-12 sm:h-11" disabled={loading}>
                {loading ? "Entrando..." : "Entrar"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground text-sm"
                onClick={() => setMode("forgot")}
              >
                Esqueci minha senha
              </Button>
            </form>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Informe seu e-mail e enviaremos um link para redefinir a senha.
              </p>
              <div className="space-y-1">
                <Label htmlFor="email-forgot">E-mail</Label>
                <Input
                  className="h-12 sm:h-11 coarse:h-12 text-base"
                  id="email-forgot"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full h-12 sm:h-11" disabled={loading}>
                {loading ? "Enviando..." : "Enviar link"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground text-sm"
                onClick={() => setMode("login")}
              >
                Voltar ao login
              </Button>
            </form>
          )}
        </CardContent>
      </div>
    </div>
  );
}

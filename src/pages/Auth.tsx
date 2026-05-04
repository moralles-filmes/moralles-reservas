import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UtensilsCrossed } from "lucide-react";
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <UtensilsCrossed className="h-8 w-8 text-primary" />
          </div>
          <CardTitle>{mode === "login" ? "Área Administrativa" : "Redefinir senha"}</CardTitle>
          <p className="text-sm text-muted-foreground">Moralles Reservas</p>
        </CardHeader>
        <CardContent>
          {mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="email">E-mail</Label>
                <Input
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
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
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
                  id="email-forgot"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
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
      </Card>
    </div>
  );
}

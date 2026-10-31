import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useConnectInstagramCallback } from "@/hooks/useInstagram";
import { takeOauthState } from "@/features/instagram/oauth";
import { actionError } from "@/features/instagram/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/** Códigos da Meta são de uso único: cada code vai à EF no máximo uma vez. */
const submittedCodes = new Set<string>();

const MSG_MISSING = "Não encontramos o retorno da Meta nesta página. Se ainda não conectou, inicie a conexão de novo.";
const MSG_DENIED = "A autorização no Instagram não foi concluída. Inicie a conexão de novo se quiser conectar.";
const MSG_STATE = "A conexão não pôde ser confirmada (a sessão de segurança não confere). Inicie a conexão de novo.";
const MSG_GENERIC = "Não foi possível concluir a conexão com o Instagram. Tente novamente.";

type Params = { code: string | null; state: string | null; error: string | null };

function lastSlug(): string | null {
  try { return localStorage.getItem("moralles:lastUnitSlug"); } catch { return null; }
}

export default function InstagramCallback() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const callback = useConnectInstagramCallback();
  const params = useRef<Params | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Passo 1, antes de qualquer await: captura code/state e limpa a URL.
  // No efeito (não no render): o StrictMode renderiza duas vezes e o segundo
  // render já não enxergaria os parâmetros. O ref sobrevive ao efeito duplo.
  useEffect(() => {
    if (params.current !== null) return;
    const sp = new URLSearchParams(window.location.search);
    params.current = { code: sp.get("code"), state: sp.get("state"), error: sp.get("error") };
    if (["code", "state", "error", "error_reason", "error_description"].some((k) => sp.has(k))) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (loading || !user) return;
    const p = params.current;
    if (!p || !p.code || !p.state) {
      takeOauthState();
      setError(p?.error ? MSG_DENIED : MSG_MISSING);
      return;
    }
    if (submittedCodes.has(p.code)) return;
    submittedCodes.add(p.code);

    // Compara e apaga o state guardado ANTES de chamar a EF.
    const stored = takeOauthState();
    if (!stored || stored !== p.state) {
      setError(MSG_STATE);
      return;
    }

    callback
      .mutateAsync({ code: p.code, state: p.state })
      .then((result) => navigate(`/g/${result.unit_slug}/instagram`, { replace: true }))
      .catch((e: unknown) => {
        setError(actionError(e, MSG_GENERIC));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/admin/login" replace />;

  if (error) {
    const slug = lastSlug();
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">Conexão com o Instagram</h1>
        <p role="alert" className="text-sm">{error}</p>
        <Button asChild variant="outline"><Link to={slug ? `/g/${slug}/instagram` : "/admin"}>Voltar ao Instagram</Link></Button>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-md p-6" role="status">
      <p className="text-sm text-muted-foreground">Concluindo a conexão com o Instagram…</p>
    </main>
  );
}

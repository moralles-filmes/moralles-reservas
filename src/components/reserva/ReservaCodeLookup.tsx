// Consulta pública por código, no rodapé do portal /r/:slug.
//
// Mora AQUI, e não num hook em src/hooks/useReservas.ts, de propósito: foi um
// hook público morando no arquivo de hooks de painel que produziu o comentário
// `-- Caller: (hook do painel)` da migration 085 e, com ele, 54 dias com esta
// consulta respondendo HTTP 401 para todo visitante. Superfície pública fica
// visível na pasta pública.
//
// A RPC devolve SÓ o token de /acompanhar/:token, nunca dado do cliente — quem
// entrega payload público é get_public_tracking (migration 055).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChevronRight, Clock, Search } from "lucide-react";

export type LookupState = "idle" | "pending" | "notFound" | "error";

// Props-only, para os quatro ramos serem testáveis sem rede nem router.
export function ReservaCodeLookupResult({
  state,
  onRetry,
}: {
  state: LookupState;
  onRetry: () => void;
}) {
  if (state === "pending") {
    return <p className="text-sm text-muted-foreground">Buscando...</p>;
  }

  if (state === "notFound") {
    return (
      <p className="text-sm text-destructive">Reserva não encontrada. Verifique o código.</p>
    );
  }

  // Erro NÃO é "não encontrada". Silenciar um como o outro já mascarou
  // incidente neste repo — é o motivo desta frente existir.
  if (state === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">
          Não foi possível consultar agora. Tente novamente em instantes.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  return null;
}

export function ReservaCodeLookup({ unitId }: { unitId: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  const lookup = useMutation({
    mutationFn: async (rawCode: string) => {
      const { data, error } = await supabase.rpc("resolve_tracking_token_by_code", {
        p_code: rawCode,
        p_unit_id: unitId,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    onSuccess: (token) => {
      // A troca de rota desmonta o diálogo — não é preciso fechá-lo à mão.
      if (token) navigate(`/acompanhar/${token}`);
    },
  });

  const state: LookupState = lookup.isPending
    ? "pending"
    : lookup.isError
      ? "error"
      : lookup.isSuccess && lookup.data === null
        ? "notFound"
        : "idle";

  const buscar = () => {
    const limpo = code.trim().toUpperCase();
    if (limpo.length < 4) return;
    lookup.mutate(limpo);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCode("");
          lookup.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
        >
          <Clock className="h-3.5 w-3.5" />
          Já tem reserva? Consulte pelo código
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Consultar reserva</DialogTitle>
          <DialogDescription>
            Informe o código de 8 caracteres recebido no WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Ex: AB1C2DEF"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") buscar();
              }}
              className="font-mono"
              maxLength={8}
            />
            <Button
              variant="secondary"
              onClick={buscar}
              disabled={code.trim().length < 4 || lookup.isPending}
              aria-label="Buscar"
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>

          <ReservaCodeLookupResult state={state} onRetry={buscar} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

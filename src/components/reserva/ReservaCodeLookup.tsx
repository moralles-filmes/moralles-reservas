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

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { extractReservationCode } from "@/lib/reservation-code";
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

  // Texto CRU da última colagem, antes de o <input> mexer nele.
  //
  // Um `<input type="text">` remove as quebras de linha do texto colado ANTES
  // do onChange rodar (HTML padrão), sem pôr espaço no lugar — então
  // "Código: #8GY6EG9X\n\nAcompanhe" chega ao onChange como
  // "Código: #8GY6EG9XAcompanhe", com o código fundido na palavra seguinte.
  // Isso acontece com o template DEFAULT do lembrete D-0
  // (useReservationTemplates.ts), sem customização nenhuma; basta o lojista
  // acrescentar UMA hashtag ao corpo pra que nenhum candidato tenha o
  // comprimento 8 que extractReservationCode() usa pra desambiguar, e a
  // extração caia no fallback sem âncora (os 8 primeiros alfanuméricos da
  // mensagem inteira). ClipboardEvent.clipboardData entrega o texto com os
  // "\n" intactos — a função pura já acerta quando os recebe.
  const pastedRef = useRef<string | null>(null);

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
    // `code` já chega limpo do onChange (extractReservationCode) — o único
    // resíduo possível é comprimento curto demais.
    if (code.length < 4) return;
    lookup.mutate(code);
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
              // Só REGISTRA o texto cru: sem preventDefault e sem escrever no
              // state, pra que a colagem siga o fluxo normal do campo (o que
              // o cliente vê continua sendo o que ele colou, e o onChange
              // seguinte decide).
              onPaste={(e) => {
                pastedRef.current = e.clipboardData.getData("text");
              }}
              onChange={(e) => {
                // Consome e limpa INCONDICIONALMENTE, em toda mudança: um
                // onPaste sem onChange (medido: só o paste de texto vazio faz
                // isso, porque qualquer texto muda o campo) deixaria o ref
                // preenchido, e ele não pode sobreviver até uma digitação
                // posterior. Limpar não basta sozinho — a mudança seguinte
                // ainda consome o ref antes de limpá-lo; quem torna essa
                // janela inofensiva é a condição do "#" logo abaixo, e o
                // teste do paste vazio reprova se ela sair.
                const pasted = pastedRef.current;
                pastedRef.current = null;

                // O caminho do clipboard existe SÓ pro caso em que o <input>
                // destruiu uma quebra de linha que importava — mensagem
                // decorada com "#". Sem "#", o texto cru não acrescenta nada
                // e atrapalha: colar um pedaço no meio do que já está no
                // campo ("AB1C" + colar "2DEF") devolveria só o pedaço
                // colado, apagando o resto. Aí quem manda é o valor do campo.
                const fonte = pasted?.includes("#") ? pasted : e.target.value;
                setCode(extractReservationCode(fonte));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") buscar();
              }}
              className="font-mono"
              // SEM maxLength no DOM, de propósito: qualquer limite aqui trunca a
              // colagem ANTES do onChange rodar — é a mesma falha do round 1
              // (maxLength=8 cortava o "#"), só que reaparece em outro número
              // assim que o cliente cola a mensagem inteira do WhatsApp em vez
              // do código puro. extractReservationCode() é o ÚNICO lugar que
              // limita o tamanho (sempre ≤ 8), e só depois de achar o código de
              // verdade.
            />
            <Button
              variant="secondary"
              onClick={buscar}
              disabled={code.length < 4 || lookup.isPending}
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

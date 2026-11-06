/**
 * Página do link de escolha de mesa enviado pelo agente no WhatsApp (/mesa/:token).
 *
 * Só leitura: mostra o salão do link (public-seat-map no modo token), o cliente
 * toca numa mesa livre e volta ao WhatsApp com "Quero a mesa 12" pronto. Quem
 * cria a reserva é o agente, ao receber a mensagem. Nenhuma chamada desta
 * página escreve nada.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CenaEscolha } from "@/components/planta/escolha/CenaEscolha";
import { useSeatMap } from "@/components/planta/escolha/useSeatMap";
import { buildChoiceMessage } from "@/components/planta/escolha/seat-label";
import { formatDateBR } from "@/lib/utils";
import type { SeatChoice } from "@/types/reserva";

function whatsappHref(phone: string, message: string | null): string {
  const base = `https://wa.me/${phone}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

type Escolha = { choice: SeatChoice; label: string };

export default function EscolherMesa() {
  const { token } = useParams<{ token: string }>();
  const query = useSeatMap(token ? { token } : null);
  const [escolha, setEscolha] = useState<Escolha | null>(null);

  const data = query.data;
  const ok = data && data.ok === true ? data : null;
  const reason = data && data.ok === false ? data.reason : null;

  let body: React.ReactNode;
  if (!token || reason === "link_invalid") {
    body = <Aviso titulo="Este link expirou." texto="Peça outro link no WhatsApp." />;
  } else if (query.isLoading) {
    body = <Carregando />;
  } else if (reason === "choice_disabled") {
    body = (
      <Aviso
        titulo="A escolha de mesa não está disponível agora."
        texto="Volte ao WhatsApp para seguir com a sua reserva."
      />
    );
  } else if (!ok) {
    body = (
      <Aviso titulo="Não foi possível carregar o salão agora." texto="Confira sua conexão e tente de novo.">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          Tentar de novo
        </Button>
      </Aviso>
    );
  } else {
    const semMesa = !ok.map.hall.plan || !ok.map.options.some(option => option.available);
    body = (
      <div className="space-y-4">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">{ok.unit.name}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDateBR(ok.date)} · {ok.time.slice(0, 5)} · {ok.party_size}{" "}
            {ok.party_size === 1 ? "pessoa" : "pessoas"}
          </p>
          <p className="text-sm text-muted-foreground">{ok.map.hall.name}</p>
        </header>
        {semMesa ? (
          <Aviso
            titulo="Não há mesa livre para escolher nesse horário."
            texto="Volte ao WhatsApp para seguir com a sua reserva."
          />
        ) : (
          <>
            <p className="text-sm">Toque numa mesa livre para escolher.</p>
            <CenaEscolha
              map={ok.map}
              partySize={ok.party_size}
              selected={escolha?.choice ?? null}
              onChoose={(choice, label) => setEscolha({ choice, label })}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen ambient bg-background text-foreground flex flex-col items-center px-4 pt-6 sm:pt-10 pb-36">
      <main className="w-full max-w-3xl">{body}</main>
      {ok && (
        <BarraVoltar
          phone={ok.whatsapp_phone}
          escolha={escolha}
          semMesa={!ok.map.hall.plan || !ok.map.options.some(option => option.available)}
        />
      )}
    </div>
  );
}

function BarraVoltar({ phone, escolha, semMesa }: { phone: string | null; escolha: Escolha | null; semMesa: boolean }) {
  const message = escolha ? buildChoiceMessage(escolha.label) : null;

  const copiar = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      toast.success("Mensagem copiada.");
    } catch {
      toast.error("Não foi possível copiar. Escreva a mensagem no WhatsApp.");
    }
  };

  return (
    <div
      role="region"
      aria-label="Voltar para o WhatsApp"
      className="surface fixed inset-x-0 bottom-0 z-40 border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex min-h-14 w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-2">
        <p className="text-sm" aria-live="polite">
          {escolha
            ? phone
              ? `${escolha.label} escolhida`
              : `Volte ao WhatsApp e envie: ${message}`
            : semMesa
              ? "Volte ao WhatsApp para seguir com a sua reserva."
              : phone
                ? "Escolha a mesa ou volte quando quiser."
                : "Escolha uma mesa e depois volte ao WhatsApp."}
        </p>
        {phone ? (
          <Button asChild className="min-h-11">
            <a href={whatsappHref(phone, message)} rel="noopener noreferrer">
              Voltar para o WhatsApp
            </a>
          </Button>
        ) : (
          escolha && (
            <Button type="button" className="min-h-11" onClick={copiar}>
              Copiar mensagem
            </Button>
          )
        )}
      </div>
    </div>
  );
}

function Aviso({ titulo, texto, children }: { titulo: string; texto: string; children?: React.ReactNode }) {
  return (
    <Card className="surface rounded-panel mx-auto max-w-md">
      <CardContent className="space-y-3 py-8 text-center">
        <p className="font-medium">{titulo}</p>
        <p className="text-sm text-muted-foreground">{texto}</p>
        {children}
      </CardContent>
    </Card>
  );
}

function Carregando() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando o salão">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-80 w-full rounded-panel" />
    </div>
  );
}

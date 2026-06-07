// Página pública de acompanhamento (sem login) — /acompanhar/:token.
//
// O cliente abre um link único (enviado por WhatsApp) e acompanha o status da
// sua reserva OU da sua posição na fila de espera. O :token é o `id` UUID v4 da
// reserva/fila — lookup feito pela RPC SECURITY DEFINER `get_public_tracking`,
// que devolve só dados públicos (1º nome, status, etc.) e gateia por
// units.is_public. Anon NUNCA lê tabela de negócio direto (padrão do projeto).
//
// Atualização: polling visibility-aware (20s, pausa em background) + botão
// "Atualizar" + "Última atualização HH:MM". Realtime não cabe aqui (anon só lê
// via RPC). Tema warm `:root` herdado (página fora de qualquer layout admin).

import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR } from "@/lib/utils";
import {
  AlertCircle,
  Calendar,
  Clock,
  Hash,
  MapPin,
  MessageCircle,
  RefreshCw,
  Users,
} from "lucide-react";

// ── Tipos da RPC ──────────────────────────────────────────────────────────────

type ReservationStatus = "pending" | "confirmed" | "cancelled" | "no_show";
type WaitlistStatusT = "waiting" | "notified" | "seated" | "cancelled";

interface TrackingReservation {
  type: "reservation";
  first_name: string;
  unit_name: string;
  unit_slug: string;
  unit_logo_url: string | null;
  unit_whatsapp: string; // só dígitos; "" quando não há
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  party_size: number;
  status: ReservationStatus;
  reservation_code: string;
  payment_status: string | null;
  status_updated_at: string; // ISO
}

interface TrackingWaitlist {
  type: "waitlist";
  first_name: string;
  unit_name: string;
  unit_slug: string;
  unit_logo_url: string | null;
  unit_whatsapp: string;
  party_size: number;
  code: number | null;
  status: WaitlistStatusT;
  position: number | null;
  created_at: string;
  status_updated_at: string;
}

type TrackingPayload = TrackingReservation | TrackingWaitlist;

// UUID v4 (aceita também v1-5 por segurança) — valida o shape ANTES de bater na
// rede, pra path inválido cair direto no "não encontrado" sem request.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Pausa o polling quando a aba está em background (espelha pollWhenVisible de
// useWaitlist.ts). 20s conforme decidido.
const pollWhenVisible = () =>
  typeof document !== "undefined" && document.hidden ? false : 20_000;

// ── Mapa de status → rótulo + cor + mensagem amigável ─────────────────────────

interface StatusView {
  label: string;
  variant: BadgeProps["variant"];
  message: string;
}

function reservationStatusView(status: ReservationStatus): StatusView {
  switch (status) {
    case "confirmed":
      return {
        label: "Confirmada",
        variant: "success",
        message:
          "Sua reserva está confirmada! Chegue com alguns minutos de antecedência para garantir a melhor experiência.",
      };
    case "pending":
      return {
        label: "Aguardando confirmação",
        variant: "warning",
        message:
          "Recebemos sua reserva e ela está aguardando confirmação do restaurante. Avisaremos por aqui assim que for confirmada.",
      };
    case "cancelled":
      return {
        label: "Cancelada",
        variant: "destructive",
        message:
          "Sua reserva foi cancelada. Caso tenha dúvidas, fale com a equipe do restaurante.",
      };
    case "no_show":
      return {
        label: "Não compareceu",
        variant: "secondary",
        message:
          "Esta reserva consta como não comparecida. Caso tenha dúvidas, fale com a equipe.",
      };
    default:
      return {
        label: "Indisponível",
        variant: "secondary",
        message: "Não foi possível obter o status no momento.",
      };
  }
}

function waitlistStatusView(
  status: WaitlistStatusT,
  position: number | null,
): StatusView {
  switch (status) {
    case "waiting":
      // Próximo da vez: realce quando faltam poucas posições.
      if (position != null && position <= 2) {
        return {
          label: "Quase na sua vez",
          variant: "info",
          message:
            "Você está próximo de ser chamado. Fique atento ao WhatsApp e esteja por perto.",
        };
      }
      return {
        label: "Na fila de espera",
        variant: "warning",
        message:
          "Você está na fila de espera. Acompanhe por aqui sua posição e aguarde ser chamado.",
      };
    case "notified":
      return {
        label: "Chegou sua vez",
        variant: "info",
        message:
          "Chegou sua vez! Procure a recepção ou aguarde as instruções da equipe.",
      };
    case "seated":
      return {
        label: "Acomodado",
        variant: "success",
        message: "Você já foi acomodado. Boa refeição! 🍽️",
      };
    case "cancelled":
      return {
        label: "Fora da fila",
        variant: "destructive",
        message:
          "Você não está mais na fila de espera. Caso tenha dúvidas, fale com a equipe.",
      };
    default:
      return {
        label: "Indisponível",
        variant: "secondary",
        message: "Não foi possível obter o status no momento.",
      };
  }
}

// wa.me exige número internacional. units.phone BR costuma vir sem DDI — se tiver
// 10/11 dígitos (fixo/celular local), prefixa 55.
function whatsappHref(digits: string): string {
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}`;
}

// ── Página ────────────────────────────────────────────────────────────────────

export default function AcompanharReserva() {
  const { token } = useParams<{ token: string }>();
  const isValidToken = !!token && UUID_RE.test(token);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["public-tracking", token],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_public_tracking", {
        p_token: token,
      });
      if (error) throw error;
      return (data as TrackingPayload | null) ?? null;
    },
    enabled: isValidToken,
    refetchInterval: pollWhenVisible,
  });

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex flex-col items-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-md space-y-4">
        {!isValidToken ? (
          <NotFoundState />
        ) : isLoading ? (
          <LoadingState />
        ) : isError || data == null ? (
          <NotFoundState />
        ) : (
          <TrackingView
            data={data}
            onRefresh={() => refetch()}
            isFetching={isFetching}
            dataUpdatedAt={dataUpdatedAt}
          />
        )}
      </div>
    </div>
  );
}

// ── Estados ───────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <Card>
      <CardContent className="py-8 space-y-4">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-16 w-16 rounded-full" />
          <Skeleton className="h-5 w-40" />
        </div>
        <Skeleton className="h-9 w-32 mx-auto" />
        <div className="space-y-3 pt-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

function NotFoundState() {
  return (
    <Card>
      <CardContent className="py-12 flex flex-col items-center gap-4 text-center">
        <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
          <AlertCircle className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">Acompanhamento indisponível</h1>
          <p className="text-sm text-muted-foreground">
            Não encontramos esta reserva ou fila de espera. O link pode ter
            expirado ou estar incorreto. Verifique o link ou fale com a equipe do
            restaurante.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── View de sucesso ───────────────────────────────────────────────────────────

function TrackingView({
  data,
  onRefresh,
  isFetching,
  dataUpdatedAt,
}: {
  data: TrackingPayload;
  onRefresh: () => void;
  isFetching: boolean;
  dataUpdatedAt: number;
}) {
  const view =
    data.type === "reservation"
      ? reservationStatusView(data.status)
      : waitlistStatusView(data.status, data.position);

  const updatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      {/* Cabeçalho com logo + nome da unidade */}
      <div className="flex flex-col items-center gap-3 text-center">
        {data.unit_logo_url ? (
          <img
            src={data.unit_logo_url}
            alt={data.unit_name}
            className="h-16 w-16 rounded-full object-cover border border-border shadow-soft"
          />
        ) : (
          <div className="h-16 w-16 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xl font-bold">
            {data.unit_name.charAt(0).toUpperCase()}
          </div>
        )}
        <h1 className="text-lg font-bold leading-tight">{data.unit_name}</h1>
      </div>

      {/* Card principal de status */}
      <Card className="overflow-hidden">
        <CardContent className="py-6 space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <Badge variant={view.variant} className="text-xs px-3 py-1.5">
              {view.label}
            </Badge>
            <p className="text-sm text-foreground/90 leading-relaxed">
              {data.type === "reservation"
                ? `${data.first_name ? data.first_name + ", " : ""}${view.message}`
                : view.message}
            </p>
          </div>

          {/* Destaque de posição na fila */}
          {data.type === "waitlist" &&
            data.position != null &&
            (data.status === "waiting" || data.status === "notified") && (
              <div className="flex flex-col items-center gap-0.5 rounded-xl bg-primary/5 py-4">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Sua posição na fila
                </span>
                <span className="text-3xl font-bold text-primary">
                  {data.position}º
                </span>
              </div>
            )}

          {/* Linhas de informação */}
          <div className="space-y-2.5">
            {data.type === "reservation" ? (
              <>
                <InfoRow
                  icon={Calendar}
                  label="Data"
                  value={formatDateBR(data.date, {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                  })}
                />
                <InfoRow icon={Clock} label="Horário" value={data.time} />
                <InfoRow
                  icon={Users}
                  label="Pessoas"
                  value={`${data.party_size} ${data.party_size === 1 ? "pessoa" : "pessoas"}`}
                />
                <InfoRow
                  icon={Hash}
                  label="Código"
                  value={data.reservation_code}
                />
              </>
            ) : (
              <>
                <InfoRow
                  icon={Users}
                  label="Pessoas"
                  value={`${data.party_size} ${data.party_size === 1 ? "pessoa" : "pessoas"}`}
                />
                {data.code != null && (
                  <InfoRow icon={Hash} label="Senha" value={`#${data.code}`} />
                )}
              </>
            )}
          </div>

          {/* Atualizar + última atualização */}
          <div className="flex flex-col items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isFetching}
              className="gap-2"
            >
              <RefreshCw
                className={isFetching ? "animate-spin" : undefined}
              />
              {isFetching ? "Atualizando…" : "Atualizar status"}
            </Button>
            {updatedLabel && (
              <p className="text-xs text-muted-foreground">
                Última atualização: {updatedLabel}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Ações: WhatsApp + ver restaurante */}
      <div className="space-y-2">
        {data.unit_whatsapp && (
          <Button asChild className="w-full gap-2">
            <a
              href={whatsappHref(data.unit_whatsapp)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle />
              Falar com o restaurante
            </a>
          </Button>
        )}
        <Button asChild variant="ghost" size="sm" className="w-full gap-2">
          <Link to={`/r/${data.unit_slug}`}>
            <MapPin />
            Ver página do restaurante
          </Link>
        </Button>
      </div>
    </>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Calendar;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground w-20 shrink-0">
        {label}
      </span>
      <span className="text-sm font-medium text-foreground first-letter:uppercase ml-auto text-right">
        {value}
      </span>
    </div>
  );
}

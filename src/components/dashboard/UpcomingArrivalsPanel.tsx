import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { upcomingArrivals } from "@/lib/arrivals-today";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, STATUS_LABELS, type Reserva } from "@/types/reserva";

function currentHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// Relógio de minuto: chegada que já passou sai da lista sem esperar o próximo refetch.
function useMinuteClock(): string {
  const [hhmm, setHhmm] = useState(currentHHMM);
  useEffect(() => {
    const id = window.setInterval(() => setHhmm(currentHHMM()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return hhmm;
}

interface UpcomingArrivalsPanelProps {
  reservas: Reserva[] | undefined;
  isLoading: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

export function UpcomingArrivalsPanel({ reservas, isLoading, isError, onRetry }: UpcomingArrivalsPanelProps) {
  const nowHHMM = useMinuteClock();
  const arrivals = upcomingArrivals(reservas ?? [], nowHHMM);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Próximas chegadas</h2>
      {isLoading ? (
        [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)
      ) : isError ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Não foi possível carregar as reservas de hoje</p>
          {onRetry && <Button variant="outline" onClick={onRetry}>Tentar de novo</Button>}
        </div>
      ) : arrivals.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma chegada prevista daqui para frente</p>
      ) : arrivals.map((reserva) => (
        <div key={reserva.id} className="surface rounded-block p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="tabular text-2xl font-semibold">{reserva.time.slice(0, 5)}</span>
            <span className={cn("rounded-full border px-2 py-1 text-xs", STATUS_COLORS[reserva.status])}>{STATUS_LABELS[reserva.status]}</span>
          </div>
          <p className="truncate font-medium">{reserva.customer?.name || "—"}</p>
          <p className="text-sm text-muted-foreground">{reserva.party_size} {reserva.party_size === 1 ? "pessoa" : "pessoas"}</p>
        </div>
      ))}
    </section>
  );
}

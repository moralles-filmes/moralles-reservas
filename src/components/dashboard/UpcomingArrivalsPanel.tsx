import { Skeleton } from "@/components/ui/skeleton";
import { upcomingArrivals } from "@/lib/arrivals-today";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, STATUS_LABELS, type Reserva } from "@/types/reserva";

export function UpcomingArrivalsPanel({ reservas, isLoading }: { reservas: Reserva[] | undefined; isLoading: boolean }) {
  const now = new Date();
  const nowHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const arrivals = upcomingArrivals(reservas ?? [], nowHHMM);
  return (
    <section className="space-y-4">
      <h3 className="text-lg font-semibold">Próximas chegadas</h3>
      {isLoading ? (
        [1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)
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

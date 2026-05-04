import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useReservas } from "@/hooks/useReservas";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon } from "lucide-react";
import { formatDateBR } from "@/lib/utils";

export default function ReservasDia() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const today = new Date().toISOString().split("T")[0];

  const { data: reservas, isLoading } = useReservas(unitId, { date: today });

  const pending = reservas?.filter((r) => r.status === "pending") ?? [];
  const confirmed = reservas?.filter((r) => r.status === "confirmed") ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <CalendarIcon className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">Reservas de hoje</h1>
        <Badge variant="outline">{formatDateBR(today, { weekday: "long", day: "numeric", month: "long" })}</Badge>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : !reservas?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            Nenhuma reserva para hoje.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Aguardando confirmação ({pending.length})
              </p>
              {pending.map((r) => (
                <ReservaCard key={r.id} reserva={r} showActions unitId={unitId} />
              ))}
            </div>
          )}
          {confirmed.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Confirmadas ({confirmed.length})
              </p>
              {confirmed.map((r) => (
                <ReservaCard key={r.id} reserva={r} showActions unitId={unitId} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

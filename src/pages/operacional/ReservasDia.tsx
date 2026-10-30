import { useMemo, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useReservas } from "@/hooks/useReservas";
import {
  useReservationDeliveries,
  findDelivery,
} from "@/hooks/useNotificationDeliveries";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { ManualReservaDialog } from "@/components/reserva/ManualReservaDialog";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Plus } from "lucide-react";
import { formatDateBR, todayLocalISO } from "@/lib/utils";

export default function ReservasDia() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const organizationId = unit?.organization_id ?? "";
  const today = todayLocalISO();
  const [manualOpen, setManualOpen] = useState(false);

  const { data: reservas, isLoading, isError, refetch } = useReservas(unitId, { date: today });

  const pending = reservas?.filter((r) => r.status === "pending") ?? [];
  const confirmed = reservas?.filter((r) => r.status === "confirmed") ?? [];

  // Status de entrega da confirmação (kind `confirmation`), por reserva.
  const reservaIds = useMemo(() => reservas?.map((r) => r.id) ?? [], [reservas]);
  const { data: deliveries } = useReservationDeliveries(unitId, reservaIds);
  const cancelled = reservas?.filter((r) => r.status === "cancelled").length ?? 0;
  const noShow = reservas?.filter((r) => r.status === "no_show").length ?? 0;
  // Considera "vazio" quando não há nada acionável pra hoje (canceladas/no_show
  // não aparecem como cards; sem essa checagem, dia inteiro cancelado renderiza
  // só o header sem conteúdo nem mensagem).
  const hasActive = pending.length > 0 || confirmed.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reservas de hoje"
        description={formatDateBR(today, { weekday: "long", day: "numeric", month: "long" })}
      >
        <Button
          size="sm"
          onClick={() => setManualOpen(true)}
          disabled={!unitId}
        >
          <Plus className="h-4 w-4 mr-1" /> Nova reserva manual
        </Button>
      </PageHeader>

      {unitId && (
        <ManualReservaDialog
          open={manualOpen}
          onOpenChange={setManualOpen}
          unitId={unitId}
          organizationId={organizationId}
        />
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-block" />)}</div>
      ) : isError ? (
        <div className="surface rounded-card border-destructive/40 py-8 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium">Erro ao carregar reservas de hoje.</p>
            <p className="text-xs text-muted-foreground">
              Verifique sua conexão e tente novamente.
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Tentar de novo
            </Button>
        </div>
      ) : !hasActive ? (
        <div className="surface rounded-card py-12 text-center text-muted-foreground text-sm">
            <p>Nenhuma reserva ativa para hoje.</p>
            {(cancelled > 0 || noShow > 0) && (
              <p className="text-xs mt-2">
                {cancelled > 0 && <span>{cancelled} cancelada{cancelled !== 1 ? "s" : ""}</span>}
                {cancelled > 0 && noShow > 0 && <span> · </span>}
                {noShow > 0 && <span>{noShow} não compareceu</span>}
              </p>
            )}
        </div>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Aguardando confirmação ({pending.length})
              </h2>
              {pending.map((r) => (
                <ReservaCard
                  key={r.id}
                  reserva={r}
                  showActions
                  unitId={unitId}
                  confirmationDelivery={findDelivery(deliveries?.[r.id], "confirmation")}
                />
              ))}
            </div>
          )}
          {confirmed.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Confirmadas ({confirmed.length})
              </h2>
              {confirmed.map((r) => (
                <ReservaCard
                  key={r.id}
                  reserva={r}
                  showActions
                  unitId={unitId}
                  confirmationDelivery={findDelivery(deliveries?.[r.id], "confirmation")}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

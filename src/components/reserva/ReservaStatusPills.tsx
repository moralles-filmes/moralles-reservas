import { StatusPill, type StatusTone } from "@/components/ui/status-pill";
import { useNow } from "@/hooks/useNow";
import { useReservationDuration } from "@/hooks/useReservationDuration";
import { reservationLiveSituation } from "@/lib/table-situation-core";
import type { Reserva, ReservaStatus } from "@/types/reserva";
import { STATUS_LABELS } from "@/types/reserva";

const STATUS_TONES: Record<ReservaStatus, StatusTone> = {
  pending: "pending",
  confirmed: "reserved",
  cancelled: "destructive",
  no_show: "muted",
};

/** Pílula do status gravado e, quando houver, a da situação ao vivo ao lado (no máximo duas). */
export function ReservaStatusPills({
  reserva,
  unitId,
}: {
  reserva: Pick<Reserva, "date" | "time" | "status" | "arrived_at" | "released_at">;
  unitId: string;
}) {
  const now = useNow(60_000);
  const duration = useReservationDuration(unitId);
  const live = reservationLiveSituation(reserva, now, duration);
  return (
    <>
      <StatusPill tone={STATUS_TONES[reserva.status]}>{STATUS_LABELS[reserva.status]}</StatusPill>
      {live && <StatusPill tone={live.tone}>{live.label}</StatusPill>}
    </>
  );
}

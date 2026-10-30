import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUpdateReservaStatus } from "@/hooks/useReservas";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { cn, formatDateBR, formatPhone } from "@/lib/utils";
import type { Reserva } from "@/types/reserva";
import { STATUS_COLORS, STATUS_LABELS } from "@/types/reserva";
import {
  deriveDeliveryState,
  deliveryTooltip,
  type DeliveryRow,
} from "@/hooks/useNotificationDeliveries";
import { DeliveryBadge } from "@/components/notifications/DeliveryBadge";
import { AlertTriangle, Banknote, BellOff, CalendarIcon, Phone, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";

interface ReservaCardProps {
  reserva: Reserva;
  showActions?: boolean;
  unitId?: string;
  /** Entrega da confirmação (kind `confirmation`). Só existe pra reservas web —
   *  reservas via WhatsApp são confirmadas no chat pelo agente, sem essa linha. */
  confirmationDelivery?: DeliveryRow | null;
}

export function ReservaCard({ reserva, showActions = false, unitId, confirmationDelivery }: ReservaCardProps) {
  const effectiveUnitId = unitId ?? reserva.unit_id ?? "";
  const updateStatus = useUpdateReservaStatus(effectiveUnitId);
  // Operador não pode cancelar reservas — só gerente/owner/platform_admin.
  // (isGerente cobre owner+gerente; platform_admin entra via pseudo-role "owner".)
  const unit = useCurrentUnit();
  const canCancel = unit?.isGerente ?? false;

  const handleStatus = async (status: "confirmed" | "cancelled" | "no_show") => {
    try {
      await updateStatus.mutateAsync({ id: reserva.id, status });
      toast.success("Status atualizado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar status.");
    }
  };

  return (
    <div className="surface rounded-block p-4">
      <div className="flex items-start gap-4">
        <span className="tabular text-2xl font-semibold leading-none shrink-0 w-14">
          {reserva.time.slice(0, 5)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-semibold truncate">
              {reserva.customer?.name || "—"}
            </span>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium shrink-0", STATUS_COLORS[reserva.status])}>
              {STATUS_LABELS[reserva.status]}
            </span>
            {reserva.customer?.vip_notes && (
              <Badge className="text-[11px] gap-1 bg-gold/10 text-gold border-gold/20 hover:bg-gold/10">
                <Sparkles className="h-2.5 w-2.5" />
                VIP
              </Badge>
            )}
            {(reserva.customer?.allergies || reserva.customer?.dietary_restrictions) && (
              <Badge variant="outline" className="text-[11px] gap-1 text-destructive border-destructive/30">
                <AlertTriangle className="h-2.5 w-2.5" />
                {reserva.customer?.allergies ? "Alergia" : "Restrição"}
              </Badge>
            )}
            {reserva.customer?.do_not_contact && (
              <Badge variant="outline" className="text-[11px] gap-1">
                <BellOff className="h-2.5 w-2.5" />
                Não contatar
              </Badge>
            )}
            {reserva.payment_status === "paid" && (
              <Badge variant="outline" className="text-[11px] gap-1 text-success bg-success/10 border-success/20">
                <Banknote className="h-2.5 w-2.5" />
                Pago{reserva.payment_amount_cents ? ` R$ ${(reserva.payment_amount_cents / 100).toFixed(2).replace(".", ",")}` : ""}
              </Badge>
            )}
            {reserva.payment_status === "pending_payment" && (
              <Badge variant="outline" className="text-[11px] gap-1 text-warning bg-warning/10 border-warning/20">
                <Banknote className="h-2.5 w-2.5" />
                Aguardando pgto
              </Badge>
            )}
            {reserva.payment_status === "expired" && (
              <Badge variant="outline" className="text-[11px] gap-1 text-destructive bg-destructive/10 border-destructive/20">
                <Banknote className="h-2.5 w-2.5" />
                Pgto expirado
              </Badge>
            )}
            {reserva.payment_status === "refunded" && (
              <Badge variant="outline" className="text-[11px] gap-1 text-muted-foreground bg-muted">
                <Banknote className="h-2.5 w-2.5" />
                Reembolsado
              </Badge>
            )}
            {confirmationDelivery && (
              <DeliveryBadge
                prefix="Confirmação"
                state={deriveDeliveryState(confirmationDelivery, !!reserva.customer?.phone)}
                title={deliveryTooltip(confirmationDelivery)}
              />
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <CalendarIcon className="h-3 w-3" />
              {formatDateBR(reserva.date)}
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {reserva.party_size} {reserva.party_size === 1 ? "pessoa" : "pessoas"}
            </span>
            {reserva.customer?.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {formatPhone(reserva.customer.phone)}
              </span>
            )}
            <span className="sm:hidden tabular">#{reserva.reservation_code}</span>
          </div>

          {reserva.notes && (
            <p className="mt-1 text-xs text-muted-foreground italic truncate">
              {reserva.notes}
            </p>
          )}

          {showActions && reserva.status === "pending" && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Button
                size="sm"
                variant="default"
                onClick={() => handleStatus("confirmed")}
                disabled={updateStatus.isPending}
              >
                Confirmar
              </Button>
              {canCancel && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => handleStatus("cancelled")}
                  disabled={updateStatus.isPending}
                >
                  Cancelar
                </Button>
              )}
            </div>
          )}

          {showActions && reserva.status === "confirmed" && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleStatus("no_show")}
                disabled={updateStatus.isPending}
              >
                Não compareceu
              </Button>
              {canCancel && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => handleStatus("cancelled")}
                  disabled={updateStatus.isPending}
                >
                  Cancelar
                </Button>
              )}
            </div>
          )}
        </div>
        <span className="hidden sm:block tabular text-xs text-muted-foreground shrink-0">
          #{reserva.reservation_code}
        </span>
      </div>
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useUpdateReservaStatus } from "@/hooks/useReservas";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { formatDateBR, formatPhone } from "@/lib/utils";
import type { Reserva } from "@/types/reserva";
import { STATUS_COLORS, STATUS_LABELS } from "@/types/reserva";
import {
  deriveDeliveryState,
  deliveryTooltip,
  type DeliveryRow,
} from "@/hooks/useNotificationDeliveries";
import { DeliveryBadge } from "@/components/notifications/DeliveryBadge";
import { AlertTriangle, Banknote, BellOff, CalendarIcon, Clock, Phone, Sparkles, Users } from "lucide-react";
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
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-semibold truncate">
                {reserva.customer?.name || "—"}
              </span>
              <Badge
                variant="outline"
                className={`text-xs shrink-0 ${STATUS_COLORS[reserva.status]}`}
              >
                {STATUS_LABELS[reserva.status]}
              </Badge>
              {reserva.customer?.vip_notes && (
                <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-900 border-amber-200 hover:bg-amber-100">
                  <Sparkles className="h-2.5 w-2.5" />
                  VIP
                </Badge>
              )}
              {(reserva.customer?.allergies || reserva.customer?.dietary_restrictions) && (
                <Badge variant="outline" className="text-[10px] gap-1 text-destructive border-destructive/30">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {reserva.customer?.allergies ? "Alergia" : "Restrição"}
                </Badge>
              )}
              {reserva.customer?.do_not_contact && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <BellOff className="h-2.5 w-2.5" />
                  Não contatar
                </Badge>
              )}
              {reserva.payment_status === "paid" && (
                <Badge variant="outline" className="text-[10px] gap-1 text-green-700 bg-green-50 border-green-200">
                  <Banknote className="h-2.5 w-2.5" />
                  Pago{reserva.payment_amount_cents ? ` R$ ${(reserva.payment_amount_cents / 100).toFixed(2).replace(".", ",")}` : ""}
                </Badge>
              )}
              {reserva.payment_status === "pending_payment" && (
                <Badge variant="outline" className="text-[10px] gap-1 text-amber-700 bg-amber-50 border-amber-200">
                  <Banknote className="h-2.5 w-2.5" />
                  Aguardando pgto
                </Badge>
              )}
              {reserva.payment_status === "expired" && (
                <Badge variant="outline" className="text-[10px] gap-1 text-destructive bg-destructive/10 border-destructive/20">
                  <Banknote className="h-2.5 w-2.5" />
                  Pgto expirado
                </Badge>
              )}
              {reserva.payment_status === "refunded" && (
                <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground bg-muted">
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
                <Clock className="h-3 w-3" />
                {reserva.time}
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
            </div>

            {reserva.notes && (
              <p className="mt-1 text-xs text-muted-foreground italic truncate">
                {reserva.notes}
              </p>
            )}
          </div>

          <span className="font-mono text-xs text-muted-foreground shrink-0">
            #{reserva.reservation_code}
          </span>
        </div>

        {showActions && reserva.status === "pending" && (
          <div className="flex gap-2 mt-3">
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
          <div className="flex gap-2 mt-3">
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
      </CardContent>
    </Card>
  );
}

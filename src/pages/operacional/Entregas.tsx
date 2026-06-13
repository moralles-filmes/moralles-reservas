import { useMemo, useState } from "react";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useUndeliveredNotifications,
  useResendNotification,
  isResendableKind,
  type UndeliveredNotification,
} from "@/hooks/useUndeliveredNotifications";
import {
  deriveDeliveryState,
  deliveryTooltip,
} from "@/hooks/useNotificationDeliveries";
import { DeliveryBadge } from "@/components/notifications/DeliveryBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR, formatPhone } from "@/lib/utils";
import { AlertCircle, MailWarning, Phone, Send } from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  waitlist_entered: "Entrada na fila",
  waitlist_table_ready: "Aviso de mesa pronta",
  confirmation: "Confirmação de reserva",
  reminder_d1: "Lembrete de reserva",
  survey_d1: "Pesquisa de satisfação",
  voucher_issued: "Voucher / giftback",
};

const FILA_KINDS = new Set(["waitlist_entered", "waitlist_table_ready"]);

type Category = "todas" | "fila" | "reservas";

function rowCategory(kind: string): Exclude<Category, "todas"> {
  return FILA_KINDS.has(kind) ? "fila" : "reservas";
}

// Rótulo de contexto: "Fila #12" / "Reserva 13/06 #A1B2" / "Voucher".
function contextLabel(row: UndeliveredNotification): string {
  if (FILA_KINDS.has(row.kind)) {
    return row.ref_code ? `Fila #${row.ref_code}` : "Fila de espera";
  }
  if (row.ref_date) {
    const code = row.ref_code ? ` #${row.ref_code}` : "";
    return `Reserva ${formatDateBR(row.ref_date, { day: "2-digit", month: "2-digit" })}${code}`;
  }
  return row.ref_code ? `#${row.ref_code}` : "—";
}

export default function Entregas() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [filter, setFilter] = useState<Category>("todas");

  const { data: rows, isLoading, isError, refetch } = useUndeliveredNotifications(unitId);
  const resend = useResendNotification(unitId);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (filter === "todas") return rows;
    return rows.filter((r) => rowCategory(r.kind) === filter);
  }, [rows, filter]);

  const isRowResending = (row: UndeliveredNotification) =>
    resend.isPending &&
    (FILA_KINDS.has(row.kind)
      ? resend.variables?.waitlist_id === row.waitlist_id
      : resend.variables?.reservation_id === row.reservation_id);

  const handleResend = (row: UndeliveredNotification) => {
    resend.mutate({
      kind: row.kind,
      waitlist_id: row.waitlist_id,
      reservation_id: row.reservation_id,
    });
  };

  const FILTERS: Array<{ key: Category; label: string }> = [
    { key: "todas", label: "Todas" },
    { key: "fila", label: "Fila" },
    { key: "reservas", label: "Reservas" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <MailWarning className="h-5 w-5 text-primary shrink-0" />
        <h1 className="text-xl font-bold">Mensagens não entregues</h1>
        {rows && rows.length > 0 && (
          <Badge className="bg-amber-100 text-amber-800 border-amber-200">{rows.length}</Badge>
        )}
        <div className="flex gap-1 sm:ml-auto">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? "default" : "outline"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        Mensagens que o WhatsApp não confirmou entrega (ou falharam) nos últimos 7 dias. Reenvie com 1 clique.
      </p>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError ? (
        <Card className="border-destructive">
          <CardContent className="py-8 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium">Erro ao carregar as entregas.</p>
            <p className="text-xs text-muted-foreground">Verifique sua conexão e tente novamente.</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Tentar de novo
            </Button>
          </CardContent>
        </Card>
      ) : !filtered.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            <MailWarning className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {rows && rows.length > 0
              ? "Nenhuma mensagem neste filtro."
              : "Tudo certo — nenhuma mensagem pendente de entrega. 🎉"}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => {
            const state = deriveDeliveryState(row, !!row.customer_phone);
            const resendable = isResendableKind(row.kind);
            return (
              <Card key={row.id}>
                <CardContent className="py-3 flex items-start gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="font-medium text-sm">{row.customer_name || "Cliente sem nome"}</p>
                      <DeliveryBadge state={state} title={deliveryTooltip(row)} />
                      <Badge variant="outline" className="text-[10px] bg-muted text-foreground border-border">
                        {contextLabel(row)}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      <span>{KIND_LABEL[row.kind] ?? row.kind}</span>
                      {row.customer_phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {formatPhone(row.customer_phone)}
                        </span>
                      )}
                      {row.sent_at && (
                        <span>
                          enviada{" "}
                          {new Date(row.sent_at).toLocaleString("pt-BR", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {resendable && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => handleResend(row)}
                        disabled={!row.customer_phone || isRowResending(row)}
                        title={
                          row.customer_phone
                            ? "Reenviar esta mensagem"
                            : "Cliente sem WhatsApp — edite o número primeiro"
                        }
                      >
                        <Send className="h-3 w-3" />
                        Reenviar
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

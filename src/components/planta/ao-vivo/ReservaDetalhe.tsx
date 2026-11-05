import type { ReactNode } from "react";
import { StatusPill } from "@/components/ui/status-pill";
import { canonicalBrPhone } from "@/lib/phone";
import { reservationLiveSituation } from "@/lib/table-situation-core";
import { formatPhone } from "@/lib/utils";
import type { ReservaComCliente } from "@/types/reserva";

interface Props {
  reserva: ReservaComCliente;
  tableNumbers: number[];
  now: Date;
  durationMinutes: number;
  inUse: boolean;
  actions?: ReactNode;
}

const SOURCE_LABEL: Record<NonNullable<ReservaComCliente["source"]>, string> = {
  web: "Página online",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
};

const TABLE_CHOICE_LABEL = {
  customer: "Escolhida pelo cliente",
  system: "Definida pelo sistema",
  staff: "Ajustada pela equipe",
} as const;

export function ReservaDetalhe({ reserva, tableNumbers, now, durationMinutes, inUse, actions }: Props) {
  const phone = reserva.customer?.phone;
  const orderedTables = [...tableNumbers].sort((a, b) => a - b);
  const tablesLabel = orderedTables.length === 0
    ? "Sem mesa"
    : `${orderedTables.length > 1 ? "Mesas" : "Mesa"} ${orderedTables.join("+")}`;
  const live = reservationLiveSituation(reserva, now, durationMinutes);

  return (
    <div data-testid="reserva-detalhe" className="surface rounded-md p-3">
      <div className="space-y-1">
        <p className="font-medium">{reserva.customer?.name?.trim() || "Cliente"}</p>
        <p className="text-sm text-muted-foreground">#{reserva.reservation_code}</p>
        {phone && (
          <a className="block text-sm text-foreground underline" href={`tel:+55${canonicalBrPhone(phone)}`}>
            {formatPhone(phone)}
          </a>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Pessoas</dt>
          <dd>{reserva.party_size} {reserva.party_size === 1 ? "pessoa" : "pessoas"}</dd>
          {reserva.original_party_size != null && reserva.original_party_size !== reserva.party_size && (
            <dd className="text-xs text-muted-foreground">reservou para {reserva.original_party_size}</dd>
          )}
        </div>
        <div><dt className="text-muted-foreground">Horário</dt><dd>{reserva.time.slice(0, 5)}</dd></div>
        <div><dt className="text-muted-foreground">Mesas</dt><dd>{tablesLabel}</dd></div>
        {reserva.source && SOURCE_LABEL[reserva.source] && (
          <div><dt className="text-muted-foreground">Origem</dt><dd>{SOURCE_LABEL[reserva.source]}</dd></div>
        )}
      </dl>

      {reserva.notes?.trim() && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">Observações</p>
          <p className="whitespace-pre-wrap text-sm">{reserva.notes}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {reserva.table_choice && <StatusPill tone="muted">{TABLE_CHOICE_LABEL[reserva.table_choice]}</StatusPill>}
        {live && <StatusPill tone={live.tone}>{live.label}</StatusPill>}
        {inUse && <span className="rounded-md border border-status-late/40 bg-status-late/10 px-2 py-1 text-xs font-medium text-foreground">Mesa em uso</span>}
      </div>
      {actions}
    </div>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Mesa, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";
import type { TableState } from "@/lib/table-situation-core";
import { SITUATION_TONE, TONE_CLASS, situationText } from "../situation-labels";

type ReservaComCliente = Reserva & { customer?: { name?: string | null } | null };

interface Props {
  table: Mesa | null;
  state: TableState | null;
  reservations: ReservaComCliente[];
  walkIns: WalkIn[];
  waitlistSeated: WaitlistEntry[];
  /** Preenchido pelas ações da planta (Task 12). */
  actions?: ReactNode;
}

const hhmmBrt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const plural = (n: number) => `${n} ${n === 1 ? "pessoa" : "pessoas"}`;

export function PainelMesa({ table, state, reservations, walkIns, waitlistSeated, actions }: Props) {
  let body: ReactNode = <p className="text-sm text-muted-foreground">Toque numa mesa para ver os detalhes</p>;

  if (table && state) {
    const reservaPorId = (id?: string) => reservations.find((r) => r.id === id);
    let name: string | null = null;
    let partySize: number | null = null;
    let timeText: string | null = null;
    const occ = state.occupant;
    if (occ) {
      partySize = occ.partySize;
      if (occ.kind === "reservation") {
        name = reservaPorId(occ.id)?.customer?.name ?? null;
      } else if (occ.kind === "walk_in") {
        name = walkIns.find((w) => w.id === occ.id)?.customer_name ?? null;
      } else {
        name = waitlistSeated.find((w) => w.id === occ.id)?.customer_name ?? null;
      }
    } else {
      const focus = reservaPorId(state.focusReservationId);
      if (focus) {
        name = focus.customer?.name ?? null;
        partySize = focus.party_size;
        timeText = focus.time.slice(0, 5);
      }
    }
    const next = reservaPorId(state.nextReservationId);
    const nextTime = next ? next.time.slice(0, 5) : null;

    let note: string | null = null;
    if (occ) {
      note = `Ocupada desde ${hhmmBrt.format(new Date(occ.since))}.${nextTime ? ` Próxima reserva às ${nextTime}` : ""}`;
    } else if (state.situation === "free") {
      note = nextTime ? `Livre até a reserva das ${nextTime}` : "Livre pelo resto do dia";
    }

    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold leading-tight">{`Mesa ${table.number}`}</h2>
            <p className="text-sm text-muted-foreground">{`${table.max_capacity ?? table.capacity} lugares`}</p>
          </div>
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium",
              TONE_CLASS[SITUATION_TONE[state.situation]].pill,
            )}
          >
            {situationText(state)}
          </span>
        </div>
        {name && (
          <div>
            <p className="font-medium">{name}</p>
            {partySize != null && (
              <p className="text-sm text-muted-foreground">
                {timeText ? `${plural(partySize)} às ${timeText}` : plural(partySize)}
              </p>
            )}
          </div>
        )}
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        {actions}
      </div>
    );
  }

  return (
    <section data-testid="painel-mesa" aria-live="polite" className="surface rounded-lg p-4">
      {body}
    </section>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/status-pill";
import type { Mesa, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";
import { brtNow, reservationLiveSituation, type TableState } from "@/lib/table-situation-core";
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
  now: Date;
  durationMinutes: number;
  /** Reserva tocada em "Próximas chegadas": fica destacada na lista da mesa. */
  pickedReservationId?: string | null;
}

const hhmmBrt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const plural = (n: number) => `${n} ${n === 1 ? "pessoa" : "pessoas"}`;

export function PainelMesa({
  table,
  state,
  reservations,
  walkIns,
  waitlistSeated,
  actions,
  now,
  durationMinutes,
  pickedReservationId,
}: Props) {
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

    // As demais reservas de hoje desta mesa, ainda não chegadas. Sem elas, tocar no Guilherme
    // das 19:00 abria a mesa mostrando só a reserva atrasada do meio-dia, como se fosse a dele.
    const today = brtNow(now).date;
    const shownId = occ?.kind === "reservation" ? occ.id : state.focusReservationId;
    const others = reservations
      .filter(
        (r) =>
          r.table_id === table.id &&
          r.id !== shownId &&
          r.date === today &&
          !r.arrived_at &&
          !r.released_at &&
          (r.status === "pending" || r.status === "confirmed"),
      )
      .sort((a, b) => a.time.localeCompare(b.time));

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
        {others.length > 0 && (
          <div data-testid="painel-mesa-outras" className="border-t border-border pt-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Outras reservas de hoje nesta mesa</p>
            <ul className="space-y-1">
              {others.map((r) => {
                const live = reservationLiveSituation(r, now, durationMinutes);
                const picked = r.id === pickedReservationId;
                return (
                  <li
                    key={r.id}
                    aria-current={picked ? "true" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
                      picked && "bg-accent/50 ring-1 ring-ring",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{r.customer?.name ?? "Cliente"}</span>
                      <span className="block text-xs text-muted-foreground">{plural(r.party_size)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {live && <StatusPill tone={live.tone}>{live.label}</StatusPill>}
                      <span className="text-sm tabular-nums">{r.time.slice(0, 5)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <section data-testid="painel-mesa" className="surface rounded-lg p-4">
      {/* Só a troca de mesa é anunciada; o tique de minuto no corpo não. */}
      <p key={table?.id ?? "nenhuma"} className="sr-only" role="status" aria-live="polite">
        {table ? `Mesa ${table.number} selecionada` : ""}
      </p>
      {body}
    </section>
  );
}

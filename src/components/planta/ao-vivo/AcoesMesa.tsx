import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useReleaseWaitlistEntry,
  useReleaseWalkIn,
  useReservationPresence,
  useSeatWaitlistEntry,
} from "@/hooks/useMesaAcoes";
import { useCreateWalkIn, useUpdateWalkInStatus } from "@/hooks/useWalkIns";
import { conversationHref } from "@/lib/conversation-link";
import { activeQueueToday } from "@/lib/waitlist-queue";
import type { BlockWindow, TableState } from "@/lib/table-situation-core";
import type { Mesa, Reserva, WaitlistEntry, WalkIn } from "@/types/reserva";

interface Props {
  unitId: string;
  /** `/o/:unitSlug`; sem ele (slug ausente) o botão "Abrir conversa" some. */
  basePath?: string;
  table: Mesa;
  state: TableState;
  now: Date;
  reservations: Reserva[];
  waitlistSeated: WaitlistEntry[];
  /** Entradas `waiting`/`notified`. */
  waitlistActive: WaitlistEntry[];
  /** Passantes `waiting`. */
  waitingWalkIns: WalkIn[];
  blocks: BlockWindow[];
}

const BTN = "coarse:min-h-[44px]";

const hhmmBrt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const pessoas = (n: number) => `${n} ${n === 1 ? "pessoa" : "pessoas"}`;

/** Fim do bloqueio em vigor que cobre a mesa (o mais tardio), em HH:MM BRT. */
function blockEnd(table: Mesa, blocks: BlockWindow[], now: Date): string | null {
  const nowMs = now.getTime();
  let end = 0;
  for (const b of blocks) {
    const from = new Date(b.blocked_from).getTime();
    const to = new Date(b.blocked_to).getTime();
    if (!(from <= nowMs && nowMs < to)) continue;
    const covers =
      b.table_id != null ? b.table_id === table.id : b.hall_id != null ? b.hall_id === table.hall_id : true;
    if (covers && to > end) end = to;
  }
  return end ? hhmmBrt.format(new Date(end)) : null;
}

export function AcoesMesa({
  unitId,
  basePath,
  table,
  state,
  now,
  reservations,
  waitlistSeated,
  waitlistActive,
  waitingWalkIns,
  blocks,
}: Props) {
  const presence = useReservationPresence(unitId);
  const seatEntry = useSeatWaitlistEntry(unitId);
  const releaseEntry = useReleaseWaitlistEntry(unitId);
  const releaseWalkIn = useReleaseWalkIn(unitId);
  const createWalkIn = useCreateWalkIn(unitId);
  const updateWalkIn = useUpdateWalkInStatus(unitId);
  const [name, setName] = useState("");
  const [people, setPeople] = useState("2");

  const capacity = table.max_capacity ?? table.capacity;
  const occ = state.occupant;

  const openChat = (customerId: string | null | undefined) =>
    customerId && basePath ? (
      <Button asChild variant="outline" size="sm" className={BTN}>
        <Link to={conversationHref(basePath, customerId)}>Abrir conversa</Link>
      </Button>
    ) : null;

  if (state.situation === "blocked") {
    const end = blockEnd(table, blocks, now);
    return <p className="text-sm text-muted-foreground">{end ? `Mesa bloqueada até ${end}` : "Mesa bloqueada"}</p>;
  }

  if (occ) {
    if (occ.kind === "reservation") {
      const r = reservations.find((x) => x.id === occ.id);
      const busy = presence.isPending && presence.variables?.reservationId === occ.id;
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className={BTN}
            disabled={busy}
            onClick={() => presence.mutate({ reservationId: occ.id, action: "release" })}
          >
            Liberar mesa
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={BTN}
            disabled={busy}
            onClick={() => presence.mutate({ reservationId: occ.id, action: "undo_arrive" })}
          >
            Desfazer chegada
          </Button>
          {openChat(r?.customer_id)}
        </div>
      );
    }
    if (occ.kind === "waitlist") {
      const w = waitlistSeated.find((x) => x.id === occ.id);
      const busy = releaseEntry.isPending && releaseEntry.variables?.waitlistId === occ.id;
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className={BTN}
            disabled={busy}
            onClick={() => releaseEntry.mutate({ waitlistId: occ.id })}
          >
            Liberar mesa
          </Button>
          {openChat(w?.customer_id)}
        </div>
      );
    }
    const busy = releaseWalkIn.isPending && releaseWalkIn.variables?.walkInId === occ.id;
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className={BTN}
          disabled={busy}
          onClick={() => releaseWalkIn.mutate({ walkInId: occ.id })}
        >
          Liberar mesa
        </Button>
      </div>
    );
  }

  if (state.focusReservationId) {
    const id = state.focusReservationId;
    const r = reservations.find((x) => x.id === id);
    const busy = presence.isPending && presence.variables?.reservationId === id;
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className={BTN}
          disabled={busy}
          onClick={() => presence.mutate({ reservationId: id, action: "arrive" })}
        >
          Marcar chegada
        </Button>
        {openChat(r?.customer_id)}
      </div>
    );
  }

  if (state.situation !== "free") return null;

  const queue = activeQueueToday(
    waitlistActive.filter((e) => e.status === "waiting" || e.status === "notified"),
    now,
  );
  const waiting = waitingWalkIns.filter((w) => w.status === "waiting");
  const partyNumber = Number(people);
  const formValid = name.trim().length > 0 && Number.isInteger(partyNumber) && partyNumber >= 1;

  const submitNew = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid || createWalkIn.isPending) return;
    createWalkIn.mutate(
      { customer_name: name.trim(), party_size: partyNumber, table_id: table.id, seated: true },
      {
        onSuccess: () => {
          setName("");
          setPeople("2");
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2" aria-label="Sentar passante">
        <h3 className="text-sm font-semibold">Sentar passante</h3>
        {waiting.length > 0 && (
          <ul className="space-y-1.5">
            {waiting.map((w) => {
              const busy = updateWalkIn.isPending && updateWalkIn.variables?.id === w.id;
              return (
                <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{`${w.customer_name}, ${pessoas(w.party_size)}`}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={BTN}
                    disabled={busy}
                    aria-label={`Sentar passante ${w.customer_name}`}
                    onClick={() => updateWalkIn.mutate({ id: w.id, status: "seated", table_id: table.id })}
                  >
                    Sentar
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <form onSubmit={submitNew} className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Nome do passante"
            placeholder="Nome"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 coarse:min-h-[44px]"
          />
          <Input
            aria-label="Pessoas"
            type="number"
            inputMode="numeric"
            min={1}
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            className="w-20 coarse:min-h-[44px]"
          />
          <Button type="submit" size="sm" className={BTN} disabled={!formValid || createWalkIn.isPending}>
            Sentar novo passante
          </Button>
        </form>
      </section>

      <section className="space-y-2" aria-label="Sentar da fila">
        <h3 className="text-sm font-semibold">Sentar da fila</h3>
        {queue.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguém aguardando na fila</p>
        ) : (
          <ul className="space-y-1.5">
            {queue.map((e) => {
              const busy = seatEntry.isPending && seatEntry.variables?.waitlistId === e.id;
              return (
                <li key={e.id} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{`${e.customer_name}, ${pessoas(e.party_size)}`}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={BTN}
                      disabled={busy}
                      aria-label={`Sentar da fila ${e.customer_name}`}
                      onClick={() =>
                        seatEntry.mutate({ waitlistId: e.id, tableId: table.id, tableNumber: table.number })
                      }
                    >
                      Sentar da fila
                    </Button>
                  </div>
                  {e.party_size > capacity && (
                    <p className="text-xs text-muted-foreground">
                      {`O grupo (${e.party_size}) passa da capacidade da mesa (${capacity})`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

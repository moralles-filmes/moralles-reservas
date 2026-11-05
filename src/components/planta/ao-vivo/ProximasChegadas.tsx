import type { Mesa, ReservaComCliente } from "@/types/reserva";

const MAX_ROWS = 8;

interface Props {
  reservations: ReservaComCliente[];
  tables: Mesa[];
  /** "Hoje" em BRT (YYYY-MM-DD). */
  today: string;
  /** Mesa da reserva e a própria reserva: o painel destaca a escolhida, não só a da vez da mesa. */
  onPick: (table: Mesa, reservationId: string) => void;
}

export function ProximasChegadas({ reservations, tables, today, onPick }: Props) {
  const rows = reservations
    .filter(
      (r) => r.date === today && !r.arrived_at && (r.status === "pending" || r.status === "confirmed"),
    )
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, MAX_ROWS);

  return (
    <section data-testid="proximas-chegadas" className="surface rounded-lg p-4">
      <h2 className="mb-2 text-sm font-semibold">Próximas chegadas</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma chegada pendente hoje</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => {
            const table = tables.find((t) => t.id === r.table_id) ?? null;
            const where = r.table_id == null ? "sem mesa" : table ? `na mesa ${table.number}` : "em mesa fora da planta";
            const detail = `${r.party_size} ${r.party_size === 1 ? "pessoa" : "pessoas"} ${where}`;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={!table}
                  onClick={() => table && onPick(table, r.id)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-transform duration-200 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 coarse:min-h-[44px]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.customer?.name ?? "Cliente"}</span>
                    <span className="block text-xs text-muted-foreground">{detail}</span>
                  </span>
                  <span className="text-sm tabular-nums">{r.time.slice(0, 5)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

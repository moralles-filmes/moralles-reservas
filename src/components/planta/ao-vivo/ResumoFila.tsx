import type { WaitlistEntry } from "@/types/reserva";

interface Props {
  entries: WaitlistEntry[];
  now: Date;
}

const minutesSince = (iso: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));

export function ResumoFila({ entries, now }: Props) {
  const sorted = [...entries].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const next = sorted[0];
  const avg = sorted.length
    ? Math.round(sorted.reduce((sum, e) => sum + minutesSince(e.created_at, now), 0) / sorted.length)
    : 0;

  return (
    <section data-testid="resumo-fila" className="surface rounded-lg p-4">
      <h2 className="mb-2 text-sm font-semibold">Fila de espera</h2>
      {!next ? (
        <p className="text-sm text-muted-foreground">Ninguém aguardando</p>
      ) : (
        <div className="space-y-1 text-sm">
          <p>{`${sorted.length} ${sorted.length === 1 ? "grupo aguardando" : "grupos aguardando"}`}</p>
          <p className="text-muted-foreground">
            {`Próximo: ${next.customer_name}, ${next.party_size} ${next.party_size === 1 ? "pessoa" : "pessoas"}, há ${minutesSince(next.created_at, now)} min`}
          </p>
          <p className="text-muted-foreground">{`Espera média: ${avg} min`}</p>
        </div>
      )}
    </section>
  );
}

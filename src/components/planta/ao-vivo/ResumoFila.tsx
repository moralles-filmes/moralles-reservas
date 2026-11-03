import { Button } from "@/components/ui/button";
import type { WaitlistEntry } from "@/types/reserva";
import { brtNow } from "@/lib/table-situation-core";

interface Props {
  entries: WaitlistEntry[];
  now: Date;
  /** "Chamar no WhatsApp" para o próximo da fila; sem ela, o botão não aparece. */
  onCall?: (entry: WaitlistEntry) => void;
  /** Aviso em andamento para esta entrada. */
  callingId?: string | null;
}

const minutesSince = (iso: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));

export function ResumoFila({ entries, now, onCall, callingId }: Props) {
  // Só entradas criadas hoje (BRT): fila esquecida de dias atrás não infla a espera média.
  const today = brtNow(now).date;
  const sorted = entries
    .filter((e) => brtNow(new Date(e.created_at)).date === today)
    // Mesma ordem da tela Fila e do "Sentar da fila": prioridade, depois chegada.
    .sort(
      (a, b) =>
        (a.priority ?? 0) - (b.priority ?? 0) ||
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
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
          {onCall && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="coarse:min-h-[44px]"
              disabled={!next.customer_phone || callingId === next.id}
              onClick={() => onCall(next)}
            >
              {!next.customer_phone
                ? "Sem WhatsApp cadastrado"
                : next.status === "notified"
                  ? "Chamar de novo"
                  : "Chamar no WhatsApp"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

import type { WaitlistEntry } from "@/types/reserva";
import { brtNow } from "@/lib/table-situation-core";

/**
 * Fila do dia: só entradas criadas hoje (BRT), por prioridade e depois chegada.
 * Fonte única do "Próximo"/espera média (ResumoFila) e do "Sentar da fila" (AcoesMesa);
 * fila esquecida de dias anteriores não entra. Não filtra por status — quem chama já decide.
 */
export function activeQueueToday(entries: WaitlistEntry[], now: Date): WaitlistEntry[] {
  const today = brtNow(now).date;
  return entries
    .filter((e) => brtNow(new Date(e.created_at)).date === today)
    .sort(
      (a, b) =>
        (a.priority ?? 0) - (b.priority ?? 0) ||
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
}

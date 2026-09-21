import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateBR } from "@/lib/utils";
import type { CustomerStats } from "@/types/reserva";

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className={`text-xl font-bold ${highlight ? "text-destructive" : ""}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Histórico do cliente na ficha. Não busca dado próprio: recebe tudo por prop,
 * o que mantém os quatro ramos testáveis sem `QueryClientProvider` nem mock do
 * cliente Supabase.
 *
 * `isError` vence `stats` de propósito. A RPC `get_customer_stats` recusa com
 * `42501` quem não é membro da org do cliente (migration 108), e o React Query
 * conserva o `data` anterior quando um refetch falha — mostrar número velho como
 * se fosse atual é pior que dizer que falhou.
 */
export function CustomerStatsBlock({
  stats,
  isLoading,
  isError,
  onRetry,
}: {
  stats: CustomerStats | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const noShowRate = stats?.no_show_rate ?? null;
  // Amostra pequena não decide nada: 1 de 2 é 50% e não diz mais que ruído.
  const hasShowDecision =
    stats != null && stats.confirmed + stats.no_shows >= 3 && noShowRate != null;

  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Histórico</p>
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : isError ? (
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar as estatísticas.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Tentar de novo
          </Button>
        </div>
      ) : stats ? (
        <div className="grid grid-cols-4 gap-3 text-center">
          <Stat label="Reservas" value={stats.total} />
          <Stat label="Confirmadas" value={stats.confirmed} />
          <Stat label="Não vieram" value={stats.no_shows} />
          <Stat
            label="Taxa no-show"
            value={noShowRate != null ? `${Math.round(noShowRate * 100)}%` : "—"}
            highlight={hasShowDecision && noShowRate! >= 0.3}
          />
        </div>
      ) : null}
      {!isLoading && !isError && stats?.last_visit && (
        <p className="text-xs text-muted-foreground mt-3 text-center">
          Última presença: {formatDateBR(stats.last_visit)}
        </p>
      )}
    </div>
  );
}

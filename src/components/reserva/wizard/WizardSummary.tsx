import { Pencil, CalendarDays, Users, Clock, SquareStack, Banknote } from "lucide-react";
import { formatDateBR } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";

interface WizardSummaryProps {
  /** Inclui o nome do hall (true no step 3). */
  includeHall?: boolean;
}

/**
 * Header de resumo exibido nos steps 2 e 3 mostrando data/pessoas/hora
 * (e opcionalmente o salão) com botão "Editar" que volta pro step 1.
 */
export function WizardSummary({ includeHall = false }: WizardSummaryProps) {
  const { state, input, computed, actions } = useReservaWizardContext();
  const hall = input.halls.find((h) => h.id === state.hall_id);

  return (
    <div className="rounded-xl border bg-muted/40 px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1.5">
        {includeHall && hall && (
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <SquareStack className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="truncate">{hall.name}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground/80">
          {state.date && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5 text-primary" />
              {formatDateBR(state.date)}
            </span>
          )}
          {state.party_size > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5 text-primary" />
              {state.party_size}
            </span>
          )}
          {state.time && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-primary" />
              {state.time}
            </span>
          )}
          {computed.chargeInfo && (
            <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
              <Banknote className="h-3.5 w-3.5" />
              Caução R$ {(computed.chargeInfo.amountCents / 100).toFixed(2).replace(".", ",")}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => actions.goToStep(1)}
        className="shrink-0 text-xs font-medium text-primary hover:text-primary/80 inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-primary/5 transition-colors"
        aria-label="Editar passo 1"
      >
        <Pencil className="h-3 w-3" />
        Editar
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ChevronDown, SquareStack, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";
import { WizardSummary } from "./WizardSummary";
import type { PublicHall } from "@/types/reserva";

/**
 * Passo 2 — Seleção de ambiente (hall).
 *
 * Mostra:
 *   - Resumo editável (data/pessoas/hora) no topo
 *   - Cards dos halls compatíveis com slot + capacidade
 *   - Acordeão "Não encontrou opção ideal?" listando halls alternativos
 *     (clicável: volta pro step 1 com aquele hall pré-fixado pra usuário
 *     escolher outro horário)
 */
export function StepHall() {
  const { state, computed, actions } = useReservaWizardContext();
  const { compatible, alternative } = computed.partition;
  const hasAlternatives = alternative.length > 0;
  const noCompatible = compatible.length === 0;

  // Acordeão aberto por default quando não há compatíveis
  const [showAlternatives, setShowAlternatives] = useState(noCompatible && hasAlternatives);

  // Quando o usuário entra no step e há só 1 hall, garantir seleção
  useEffect(() => {
    if (compatible.length === 1 && state.hall_id !== compatible[0].id) {
      actions.set("hall_id", compatible[0].id);
    }
  }, [compatible, state.hall_id, actions]);

  return (
    <div className="space-y-5">
      <WizardSummary />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">
          Selecione um ambiente
        </h3>

        {noCompatible ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Nenhum ambiente disponível para {state.party_size} pessoa
            {state.party_size === 1 ? "" : "s"} às {state.time}.
            {hasAlternatives
              ? " Veja outros ambientes/horários abaixo."
              : " Volte e escolha outra data/horário."}
          </div>
        ) : (
          <div className="space-y-2.5">
            {compatible.map((hall) => (
              <HallCard
                key={hall.id}
                hall={hall}
                selected={state.hall_id === hall.id}
                onSelect={() => actions.set("hall_id", hall.id)}
                partySize={state.party_size}
                time={state.time}
              />
            ))}
          </div>
        )}
      </div>

      {hasAlternatives && (
        <div className="border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAlternatives((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-foreground/80 hover:bg-muted/50 transition-colors"
            aria-expanded={showAlternatives}
          >
            <span>Não encontrou opção ideal?</span>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                showAlternatives && "rotate-180",
              )}
            />
          </button>
          {showAlternatives && (
            <div className="px-4 py-4 border-t bg-muted/20 space-y-3">
              <p className="text-xs text-muted-foreground">
                Veja outros ambientes disponíveis para o mesmo dia.
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {alternative.map((hall) => (
                  <button
                    key={hall.id}
                    type="button"
                    onClick={() => {
                      // Marca hall escolhido e volta ao step 1 pra trocar de horário
                      actions.set("hall_id", hall.id);
                      actions.set("time", "");
                      actions.goToStep(1);
                    }}
                    className="flex flex-col items-center gap-2 rounded-lg border bg-background p-3 hover:border-primary/40 hover:shadow-sm transition-all min-h-[88px] justify-center"
                  >
                    <SquareStack className="h-5 w-5 text-muted-foreground" />
                    <span className="text-xs text-center text-foreground/80 leading-tight line-clamp-2">
                      {hall.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HallCard({
  hall,
  selected,
  onSelect,
  partySize,
  time,
}: {
  hall: PublicHall;
  selected: boolean;
  onSelect: () => void;
  partySize: number;
  time: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left rounded-xl border p-4 transition-all relative",
        selected
          ? "border-primary ring-2 ring-primary/20 bg-primary/5"
          : "border-input hover:border-primary/40 hover:bg-muted/30",
      )}
      aria-pressed={selected}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-semibold text-foreground leading-tight">
            {hall.name}
          </div>
          {hall.description && (
            <div className="text-xs text-muted-foreground line-clamp-2">
              {hall.description}
            </div>
          )}
          <div className="text-xs text-foreground/70">
            {partySize} pessoa{partySize === 1 ? "" : "s"} às {time}
          </div>
        </div>
        {selected && (
          <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Check className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
    </button>
  );
}

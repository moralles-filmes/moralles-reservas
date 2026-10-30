import { useEffect, useState, type KeyboardEvent } from "react";
import { ChevronDown, SquareStack, Banknote } from "lucide-react";
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
  const selectedHall = compatible.find((hall) => hall.id === state.hall_id);
  const tabStopHallId = selectedHall?.id ?? compatible[0]?.id;
  const onHallsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const edge = e.key === "Home" ? 0 : e.key === "End" ? compatible.length - 1 : null;
    if (step == null && edge == null || compatible.length === 0) return;
    e.preventDefault();
    const current = Math.max(0, compatible.findIndex((hall) => hall.id === tabStopHallId));
    const nextIndex = edge ?? Math.min(compatible.length - 1, Math.max(0, current + (step ?? 0)));
    const nextHall = compatible[nextIndex];
    if (!nextHall) return;
    actions.set("hall_id", nextHall.id);
    document.getElementById(`wizard-hall-${nextHall.id}`)?.focus();
  };

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
          {compatible.length === 1 ? "Ambiente" : "Selecione um ambiente"}
        </h3>

        {noCompatible ? (
          <div className="rounded-block border border-warning/20 bg-warning/10 p-4 text-sm text-warning">
            Nenhum ambiente disponível para {state.party_size} pessoa
            {state.party_size === 1 ? "" : "s"} às {state.time}.
            {hasAlternatives
              ? " Veja outros ambientes/horários abaixo."
              : " Volte e escolha outra data/horário."}
          </div>
        ) : (
          <>
            {/* Com um ambiente só, o seletor repetiria o cartão abaixo; a seleção é automática. */}
            {compatible.length > 1 && (
            <div role="radiogroup" aria-label="Ambiente" onKeyDown={onHallsKeyDown} className="flex flex-wrap gap-1 rounded-panel bg-muted p-1">
              {compatible.map((hall) => {
                const selected = state.hall_id === hall.id;
                // A caução aparece em cada opção para o cliente comparar antes de escolher.
                const chargeCents = getHallChargeCents(hall, state.date, state.time);
                return (
                  <button
                    key={hall.id}
                    type="button"
                    id={`wizard-hall-${hall.id}`}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={hall.id === tabStopHallId ? 0 : -1}
                    onClick={() => actions.set("hall_id", hall.id)}
                    className={cn(
                      "flex min-h-11 flex-1 basis-[8rem] flex-col items-center justify-center rounded-full px-4 py-1",
                      "text-sm font-medium text-muted-foreground transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-card font-semibold text-foreground shadow-sm",
                    )}
                  >
                    {hall.name}
                    {chargeCents != null && chargeCents > 0 && (
                      <span className="text-[11px] font-medium text-warning tabular">
                        Caução R$ {(chargeCents / 100).toFixed(2).replace(".", ",")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            )}
            {selectedHall && (
              <HallDetails
                hall={selectedHall}
                partySize={state.party_size}
                time={state.time}
                date={state.date}
              />
            )}
          </>
        )}
      </div>

      {hasAlternatives && (
        <div className="surface rounded-card overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAlternatives((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-foreground/80 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
                    className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-block border bg-card p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function HallDetails({
  hall,
  partySize,
  time,
  date,
}: {
  hall: PublicHall;
  partySize: number;
  time: string;
  date: string;
}) {
  const chargeCents = getHallChargeCents(hall, date, time);

  return (
    <div className="surface rounded-card space-y-1 p-4">
      <p className="font-semibold text-foreground leading-tight">{hall.name}</p>
      {hall.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{hall.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-foreground/70">
        <span className="tabular">
          {partySize} pessoa{partySize === 1 ? "" : "s"} às {time}
        </span>
        {chargeCents != null && chargeCents > 0 && (
          <span className="inline-flex items-center gap-1 text-warning font-medium">
            <Banknote className="h-3 w-3" />
            Caução R$ {(chargeCents / 100).toFixed(2).replace(".", ",")}
          </span>
        )}
      </div>
    </div>
  );
}

function getHallChargeCents(hall: PublicHall, date: string, time: string): number | null {
  if (!date || !time) return null;
  const dow = new Date(date + "T12:00:00").getDay();
  const schedule = hall.schedules.find(
    (s) =>
      s.day_of_week === dow &&
      s.open_time <= time &&
      s.close_time > time &&
      s.charge_enabled === true &&
      s.charge_amount_cents != null &&
      s.charge_amount_cents > 0,
  );
  return schedule?.charge_amount_cents ?? null;
}

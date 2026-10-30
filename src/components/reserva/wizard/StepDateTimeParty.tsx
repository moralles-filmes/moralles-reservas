import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarX2, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { addDaysLocalISO, cn, todayLocalISO } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";
import { PartySizeInput } from "./PartySizeInput";
import { shortWeekdayPtBR } from "./summary-line";

/**
 * Passo 1 — Pessoas, Data, Horário.
 * Slots agregam todos os halls compatíveis. O hall em si é escolhido no step 2.
 * Dias em fichas roláveis (de hoje até a janela de reserva) e horários em grade.
 */
export function StepDateTimeParty() {
  const { state, input, computed, actions } = useReservaWizardContext();

  const minDate = useMemo(() => todayLocalISO(), []);
  const dates = useMemo(() => {
    const days = input.bookingWindowDays && input.bookingWindowDays > 0
      ? input.bookingWindowDays
      : 60;
    return Array.from({ length: days + 1 }, (_, i) => addDaysLocalISO(i));
  }, [input.bookingWindowDays]);

  const noSlotsAvailable = state.date && computed.timeSlots.length === 0;
  const unavailable = computed.unavailableDate;

  // Ao voltar ao passo 1, traz a ficha do dia escolhido para a vista. Rola só a
  // faixa (scrollIntoView rolaria também a página que hospeda o widget em iframe).
  const daysRef = useRef<HTMLDivElement>(null);
  const selectedDayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const strip = daysRef.current;
    const chip = selectedDayRef.current;
    if (!strip || !chip) return;
    strip.scrollLeft = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
  }, []);

  // Radiogroup com tabindex itinerante: um Tab entra na faixa e as setas
  // trocam o dia, em vez de 60 paradas de Tab.
  const tabStopDate = state.date && dates.includes(state.date) ? state.date : dates[0];
  const onDaysKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const edge = e.key === "Home" ? 0 : e.key === "End" ? dates.length - 1 : null;
    if (step == null && edge == null) return;
    e.preventDefault();
    const current = dates.indexOf(tabStopDate);
    const next = edge ?? Math.min(dates.length - 1, Math.max(0, current + (step ?? 0)));
    pickDate(dates[next]);
    daysRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${dates[next]}"]`)
      ?.focus();
  };

  const timeTabStop = computed.timeSlots.some((slot) => slot.time === state.time)
    ? state.time
    : computed.timeSlots[0]?.time;
  const onTimesKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const edge = e.key === "Home" ? 0 : e.key === "End" ? computed.timeSlots.length - 1 : null;
    if (step == null && edge == null) return;
    e.preventDefault();
    const currentIndex = Math.max(0, computed.timeSlots.findIndex((slot) => slot.time === timeTabStop));
    const next = edge ?? Math.min(computed.timeSlots.length - 1, Math.max(0, currentIndex + (step ?? 0)));
    const nextTime = computed.timeSlots[next]?.time;
    if (!nextTime) return;
    actions.set("time", nextTime);
    document.getElementById(`wizard-time-${nextTime.replace(":", "-")}`)?.focus();
  };

  const pickDate = (date: string) => {
    if (date === state.date) return;
    actions.set("date", date);
    // Reset time se a data mudou (slots podem ter mudado)
    if (state.time) actions.set("time", "");
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="party_size" className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Número de pessoas
          <span className="text-destructive">*</span>
        </Label>
        <PartySizeInput
          value={state.party_size}
          onChange={(n) => actions.set("party_size", n)}
        />
      </div>

      <div className="space-y-1.5">
        <span id="wizard-date-label" className="block text-sm font-medium">
          Data <span className="text-destructive">*</span>
        </span>
        <div
          ref={daysRef}
          role="radiogroup"
          aria-labelledby="wizard-date-label"
          onKeyDown={onDaysKeyDown}
          className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2 pt-1"
        >
          {dates.map((d) => {
            const selected = state.date === d;
            const parsed = parseISO(d);
            const weekday = shortWeekdayPtBR(parsed);
            const fullLabel = format(parsed, "EEEE, d 'de' MMMM", { locale: ptBR });
            return (
              <button
                key={d}
                ref={selected ? selectedDayRef : undefined}
                type="button"
                role="radio"
                data-date={d}
                aria-checked={selected}
                tabIndex={d === tabStopDate ? 0 : -1}
                aria-label={d === minDate ? `Hoje, ${fullLabel}` : fullLabel}
                onClick={() => pickDate(d)}
                className={cn(
                  "flex h-16 w-[62px] flex-none snap-start flex-col items-center justify-center gap-0.5",
                  "rounded-block border border-input bg-card text-foreground",
                  "transition-transform duration-300 ease-out-expo",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "border-foreground bg-foreground text-background shadow-md motion-safe:-translate-y-0.5",
                )}
              >
                <span className={cn("text-xs text-muted-foreground", selected && "text-background/70")}>
                  {d === minDate ? "Hoje" : weekday.charAt(0).toUpperCase() + weekday.slice(1)}
                </span>
                <b className="text-lg font-semibold tabular">{format(parsed, "dd")}</b>
              </button>
            );
          })}
        </div>
        {unavailable && (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm border rounded-block px-3 py-2.5 bg-destructive/10 border-destructive/30 text-destructive"
          >
            <CalendarX2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{unavailable.message}</span>
          </p>
        )}
      </div>

      <div role="radiogroup" aria-labelledby="wizard-time-label" onKeyDown={onTimesKeyDown} className="space-y-1.5">
        <span id="wizard-time-label" className="block text-sm font-medium">
          Horário <span className="text-destructive">*</span>
        </span>
        {unavailable ? (
          <p className="text-sm text-muted-foreground border rounded-block px-3 py-2.5 bg-muted/30">
            Escolha outra data para liberar os horários.
          </p>
        ) : noSlotsAvailable ? (
          <p className="text-sm text-muted-foreground border rounded-block px-3 py-2.5 bg-muted/30">
            Nenhum horário disponível neste dia. Escolha outra data.
          </p>
        ) : !state.date ? (
          <p className="text-sm text-muted-foreground border rounded-block px-3 py-2.5 bg-muted/30">
            Escolha a data primeiro.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {computed.timeSlots.map((s) => {
              const selected = state.time === s.time;
              return (
                <button
                  key={s.time}
                  type="button"
                  id={`wizard-time-${s.time.replace(":", "-")}`}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={s.time === timeTabStop ? 0 : -1}
                  onClick={() => actions.set("time", s.time)}
                  className={cn(
                    "flex min-h-11 flex-col items-center justify-center rounded-block border border-input bg-card px-1 py-1.5",
                    "text-sm font-medium tabular text-foreground transition-transform duration-300 ease-out-expo",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "border-foreground bg-foreground text-background shadow-md motion-safe:-translate-y-0.5",
                  )}
                >
                  {s.time}
                  {s.discountPercent ? (
                    <span className={cn("text-xs font-medium text-success", selected && "text-background/80")}>
                      {s.discountPercent}% off
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

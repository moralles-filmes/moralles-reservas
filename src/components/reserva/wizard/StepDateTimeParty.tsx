import { useMemo } from "react";
import { CalendarX2, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addDaysLocalISO, todayLocalISO } from "@/lib/utils";
import { useReservaWizardContext } from "./useReservaWizard";
import { PartySizeInput } from "./PartySizeInput";

/**
 * Passo 1 — Pessoas, Data, Horário.
 * Slots agregam todos os halls compatíveis. O hall em si é escolhido no step 2.
 */
export function StepDateTimeParty() {
  const { state, input, computed, actions } = useReservaWizardContext();

  const minDate = useMemo(() => todayLocalISO(), []);
  const maxDate = useMemo(() => {
    const days = input.bookingWindowDays && input.bookingWindowDays > 0
      ? input.bookingWindowDays
      : 60;
    return addDaysLocalISO(days);
  }, [input.bookingWindowDays]);

  const noSlotsAvailable = state.date && computed.timeSlots.length === 0;
  const unavailable = computed.unavailableDate;

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
        <Label htmlFor="wizard-date">
          Data <span className="text-destructive">*</span>
        </Label>
        <Input
          id="wizard-date"
          type="date"
          min={minDate}
          max={maxDate}
          value={state.date}
          onChange={(e) => {
            actions.set("date", e.target.value);
            // Reset time se a data mudou (slots podem ter mudado)
            if (state.time) actions.set("time", "");
          }}
          className="h-12 sm:h-11 text-base"
        />
        {unavailable && (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm border rounded-md px-3 py-2.5 bg-destructive/10 border-destructive/30 text-destructive"
          >
            <CalendarX2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{unavailable.message}</span>
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wizard-time">
          Horário <span className="text-destructive">*</span>
        </Label>
        {unavailable ? (
          <p className="text-sm text-muted-foreground border rounded-md px-3 py-2.5 bg-muted/30">
            Escolha outra data para liberar os horários.
          </p>
        ) : noSlotsAvailable ? (
          <p className="text-sm text-muted-foreground border rounded-md px-3 py-2.5 bg-muted/30">
            Nenhum horário disponível neste dia. Escolha outra data.
          </p>
        ) : (
          <Select
            value={state.time}
            onValueChange={(v) => actions.set("time", v)}
            disabled={!state.date || !!unavailable}
          >
            <SelectTrigger id="wizard-time" className="h-12 sm:h-11 text-base">
              <SelectValue placeholder={state.date ? "Selecione um horário" : "Escolha a data primeiro"} />
            </SelectTrigger>
            <SelectContent>
              {computed.timeSlots.map((s) => (
                <SelectItem key={s.time} value={s.time}>
                  <span className="inline-flex items-center gap-2">
                    <span>{s.time}</span>
                    {s.discountPercent ? (
                      <span className="text-success font-medium text-xs">
                        · {s.discountPercent}% off
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon, ChevronDown } from "lucide-react";
import type { DateRange as RDPRange } from "react-day-picker";
import type { DateRange } from "@/hooks/useFluxoClientes";

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "Últimos 7 dias", days: 7 },
  { label: "Últimos 15 dias", days: 15 },
  { label: "Últimos 30 dias", days: 30 },
  { label: "Últimos 60 dias", days: 60 },
  { label: "Últimos 90 dias", days: 90 },
];

export function presetRange(days: number): DateRange {
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

const MONTHS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RDPRange | undefined>({
    from: value.from,
    to: value.to,
  });

  const handlePreset = (days: number) => {
    onChange(presetRange(days));
    setOpen(false);
  };

  const handleCalendar = (range: RDPRange | undefined) => {
    setDraft(range);
    if (range?.from && range?.to) {
      const from = new Date(range.from);
      from.setHours(0, 0, 0, 0);
      const to = new Date(range.to);
      to.setHours(23, 59, 59, 999);
      onChange({ from, to });
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2 font-normal">
          <CalendarIcon className="h-4 w-4 text-muted-foreground" />
          <span>
            {formatDate(value.from)} - {formatDate(value.to)}
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          <div className="border-r p-2 flex flex-col w-44">
            {PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => handlePreset(p.days)}
                className="text-left text-sm px-3 py-2 rounded-md hover:bg-accent transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Calendar
            mode="range"
            selected={draft}
            onSelect={handleCalendar}
            numberOfMonths={1}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

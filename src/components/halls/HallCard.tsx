import { Link } from "react-router-dom";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DAY_NAMES, type Hall, type HallSchedule } from "@/types/reserva";

type Props = {
  hall: Hall;
  schedules: HallSchedule[];
  detailHref: string;
  onToggleActive?: (active: boolean) => void;
};

const DAY_INITIALS = ["D", "S", "T", "Q", "Q", "S", "S"];

/** Renderiza barras por dia da semana — soma da janela do dia (escala vertical relativa). */
function WeekBars({ schedules }: { schedules: HallSchedule[] }) {
  const minutesPerDay = Array.from({ length: 7 }, (_, dow) =>
    schedules
      .filter((s) => s.day_of_week === dow)
      .reduce((acc, s) => acc + minutesBetween(s.open_time, s.close_time), 0),
  );
  const maxMinutes = Math.max(1, ...minutesPerDay);

  return (
    <div className="grid grid-cols-7 gap-2 px-2">
      {DAY_INITIALS.map((label, dow) => {
        const m = minutesPerDay[dow];
        const ratio = m === 0 ? 0 : m / maxMinutes;
        return (
          <div key={dow} className="flex flex-col items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <div className="h-16 w-2 rounded-full bg-muted relative overflow-hidden">
              <div
                className="absolute bottom-0 left-0 right-0 bg-primary"
                style={{ height: `${Math.round(ratio * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function minutesBetween(open: string, close: string): number {
  const [oh, om] = open.split(":").map(Number);
  const [ch, cm] = close.split(":").map(Number);
  return Math.max(0, ch * 60 + cm - (oh * 60 + om));
}

export function HallCard({ hall, schedules, detailHref, onToggleActive }: Props) {
  return (
    <Card className="p-5 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold truncate" title={hall.name}>
            {hall.name}
          </h3>
          {hall.description && (
            <p className="text-xs text-muted-foreground truncate" title={hall.description}>
              {hall.description}
            </p>
          )}
        </div>
        <Switch
          checked={hall.active}
          onCheckedChange={(checked) => onToggleActive?.(checked)}
          aria-label={hall.active ? "Salão ativo" : "Salão inativo"}
        />
      </header>

      <WeekBars schedules={schedules} />

      <div className="flex justify-center pt-1">
        <Button asChild variant="outline" size="sm">
          <Link to={detailHref}>Ver salão</Link>
        </Button>
      </div>
    </Card>
  );
}

export { DAY_NAMES };

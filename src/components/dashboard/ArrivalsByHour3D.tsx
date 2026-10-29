import type { ArrivalHour } from "@/lib/arrivals-today";
import { arrivalsSentence } from "@/lib/arrivals-today";
import { cn } from "@/lib/utils";

export function ArrivalsByHour3D({ hours, className }: { hours: ArrivalHour[]; className?: string }) {
  const max = Math.max(0, ...hours.map((hour) => hour.reservations));

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={arrivalsSentence(hours) ?? "Sem chegadas hoje"}
        className="w-full"
      >
        <div className="relative h-[200px] flex items-end justify-between pr-[14px]" aria-hidden="true">
          {hours.map((h, index) => {
            const height = max === 0 || h.reservations === 0
              ? 0
              : Math.max(4, Math.round((h.reservations / max) * 170));
            const peak = h.isPeak;
            return (
              <div
                key={h.hour}
                data-peak={String(h.isPeak)}
                data-hour={h.hour}
                className="relative w-[26px] origin-bottom motion-safe:animate-rise"
                style={{ height: `${height}px`, animationDelay: `${index * 60}ms` }}
              >
                {peak && (
                  <span aria-hidden="true" className="absolute bottom-[calc(100%+20px)] -left-[6px] w-[44px] text-center text-xs font-semibold text-gold-ink tabular">
                    {h.reservations}
                  </span>
                )}
                <span aria-hidden="true" className={cn("absolute inset-0 rounded-t-[1px]", peak ? "bg-gold" : "bg-foreground/10")} />
                <span aria-hidden="true" className={cn("absolute left-full top-0 h-full w-[12px]", peak ? "bg-gold/70" : "bg-foreground/[0.07]")} style={{ transform: "skewY(-45deg)", transformOrigin: "0 0" }} />
                <span aria-hidden="true" className={cn("absolute left-0 -top-[12px] h-[12px] w-full", peak ? "bg-gold-ink" : "bg-foreground/[0.14]")} style={{ transform: "skewX(-45deg)", transformOrigin: "0 100%" }} />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between pr-[14px]" aria-hidden="true">
          {hours.map((h) => <span key={h.hour} className="w-[26px] text-center text-xs text-tertiary tabular">{h.label}</span>)}
        </div>
      </div>
      <ul className="sr-only">
        {hours.map((h) => (
          <li key={h.hour}>{`${h.label}: ${h.reservations} ${h.reservations === 1 ? "reserva" : "reservas"}, ${h.guests} ${h.guests === 1 ? "pessoa" : "pessoas"}`}</li>
        ))}
      </ul>
    </div>
  );
}

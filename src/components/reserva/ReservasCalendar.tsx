import { useState } from "react";
import { useReservas } from "@/hooks/useReservas";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDateBR, todayLocalISO } from "@/lib/utils";

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

interface ReservasCalendarProps {
  unitId: string;
}

/**
 * Mini-calendário (mês) + lista de reservas do dia selecionado.
 * Fonte de verdade compartilhada entre gestao/Calendario e operacional/Agenda.
 */
export function ReservasCalendar({ unitId }: ReservasCalendarProps) {
  const today = new Date();
  const todayStr = todayLocalISO();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);

  const { data: allReservas } = useReservas(unitId);
  const { data: dayReservas, isLoading } = useReservas(unitId, { date: selectedDate });

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);

  const reservasByDate = (allReservas || []).reduce<Record<string, number>>(
    (acc, r) => { acc[r.date] = (acc[r.date] || 0) + 1; return acc; },
    {}
  );

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const monthLabel = new Date(year, month).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="grid lg:grid-cols-[360px,1fr] gap-6">
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between mb-4">
            <Button variant="ghost" size="icon" aria-label="Mês anterior" onClick={prevMonth}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="font-semibold capitalize">{monthLabel}</span>
            <Button variant="ghost" size="icon" aria-label="Próximo mês" onClick={nextMonth}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-7 text-center text-xs text-muted-foreground mb-2">
            {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((d) => (
              <div key={d} className="py-1">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const count = reservasByDate[dateStr] || 0;
              const isSelected = dateStr === selectedDate;
              const isToday = dateStr === todayStr;

              return (
                <button
                  key={day}
                  onClick={() => setSelectedDate(dateStr)}
                  className={`relative flex flex-col items-center py-1.5 rounded-md text-sm transition-colors ${
                    isSelected
                      ? "bg-primary text-primary-foreground font-medium"
                      : isToday
                      ? "bg-accent/50 font-medium"
                      : "hover:bg-muted"
                  }`}
                >
                  {day}
                  {count > 0 && (
                    <span className={`text-[9px] leading-none font-semibold ${
                      isSelected ? "text-primary-foreground/80" : "text-primary"
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">
            {formatDateBR(selectedDate, { weekday: "long", day: "numeric", month: "long" })}
          </h2>
          {dayReservas && (
            <Badge variant="outline">{dayReservas.length} reservas</Badge>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-block" />)}
          </div>
        ) : dayReservas?.length === 0 ? (
          <div className="surface rounded-card py-10 text-center text-muted-foreground text-sm">
            Nenhuma reserva neste dia.
          </div>
        ) : (
          dayReservas?.map((r) => (
            <ReservaCard key={r.id} reserva={r} showActions unitId={unitId} />
          ))
        )}
      </div>
    </div>
  );
}

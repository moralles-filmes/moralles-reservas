import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CalendarIcon, CheckCircle, Clock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { arrivalsSentence, type ArrivalHour } from "@/lib/arrivals-today";
import { ArrivalsByHour3D } from "./ArrivalsByHour3D";
import { KpiStat } from "./KpiStat";
import { KpiStrip } from "./KpiStrip";

interface DashboardHeroProps {
  dateLabel: string;
  hours: ArrivalHour[];
  todayStats?: { total_hoje: number; confirmadas_hoje: number; pendentes_hoje: number; pessoas_hoje: number };
  unitSlug: string;
  onNewReservation: () => void;
  aside: ReactNode;
}

export function DashboardHero({ dateLabel, hours, todayStats, unitSlug, onNewReservation, aside }: DashboardHeroProps) {
  const sentence = arrivalsSentence(hours);
  return (
    <section className="glass rounded-panel grid gap-8 p-5 sm:p-8 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-6">
        <p className="text-sm text-muted-foreground">{dateLabel}</p>
        <h2 className="text-[38px] sm:text-[48px] lg:text-[58px] font-semibold tracking-[-0.045em] leading-[1.02]">
          {sentence ?? "Nenhuma reserva para hoje"}
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button asChild><Link to={`/o/${unitSlug}`}>Abrir operacional</Link></Button>
          <Button variant="outline" onClick={onNewReservation}>Nova reserva</Button>
        </div>
        {sentence && (
          <div className="space-y-4">
            <h3 className="text-sm text-muted-foreground">Chegadas por horário</h3>
            <ArrivalsByHour3D hours={hours} />
          </div>
        )}
        <KpiStrip>
          <KpiStat title="Reservas hoje" value={todayStats?.total_hoje} icon={CalendarIcon} color="bg-primary/10 text-primary" />
          <KpiStat title="Confirmadas" value={todayStats?.confirmadas_hoje} icon={CheckCircle} color="bg-success/10 text-success" />
          <KpiStat title="Pendentes" value={todayStats?.pendentes_hoje} icon={Clock} color="bg-warning/10 text-warning" />
          <KpiStat title="Pessoas esperadas" value={todayStats?.pessoas_hoje} icon={Users} color="bg-accent/20 text-accent-foreground" />
        </KpiStrip>
      </div>
      <div className="min-w-0">{aside}</div>
    </section>
  );
}

import { useReservaStats, useReservasHoje } from "@/hooks/useReservas";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon, CheckCircle, Clock, Users } from "lucide-react";
import { formatDateBR } from "@/lib/utils";

function StatCard({
  title,
  value,
  icon: Icon,
  color,
}: {
  title: string;
  value: number | undefined;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            {value === undefined ? (
              <Skeleton className="h-8 w-12 mt-1" />
            ) : (
              <p className="text-3xl font-bold mt-1">{value}</p>
            )}
          </div>
          <div className={`p-3 rounded-full ${color}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const { data: stats } = useReservaStats(unitId);
  const { data: reservasHoje, isLoading } = useReservasHoje(unitId);
  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          {formatDateBR(today, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Reservas hoje"    value={stats?.total_hoje}        icon={CalendarIcon} color="bg-primary/10 text-primary" />
        <StatCard title="Confirmadas"      value={stats?.confirmadas_hoje}  icon={CheckCircle}  color="bg-success/10 text-success" />
        <StatCard title="Pendentes"        value={stats?.pendentes_hoje}    icon={Clock}        color="bg-warning/10 text-warning" />
        <StatCard title="Pessoas esperadas"value={stats?.pessoas_hoje}      icon={Users}        color="bg-accent/20 text-accent-foreground" />
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Reservas de hoje</h2>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : reservasHoje?.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              Nenhuma reserva para hoje.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {reservasHoje?.map((r) => (
              <ReservaCard key={r.id} reserva={r} showActions unitId={unitId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

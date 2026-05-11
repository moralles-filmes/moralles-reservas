import { useState } from "react";
import { Link } from "react-router-dom";
import { useReservaStats, useReservasHoje } from "@/hooks/useReservas";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useDashboardMetrics } from "@/hooks/useDashboardMetrics";
import { useWalkInStatsToday } from "@/hooks/useWalkInStatsToday";
import { useWaitlist } from "@/hooks/useWaitlist";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { PeriodFilter, type Period } from "@/components/dashboard/PeriodFilter";
import { ChartCard } from "@/components/dashboard/ChartCard";
import { EmptyChartCard } from "@/components/dashboard/EmptyChartCard";
import { RatingsSummary } from "@/components/dashboard/RatingsSummary";
import { RecentRatingsList } from "@/components/dashboard/RecentRatingsList";
import { lazy, Suspense } from "react";
const ReservationsByDayChart = lazy(() =>
  import("@/components/dashboard/ReservationsByDayChart").then((m) => ({ default: m.ReservationsByDayChart }))
);
const OccupancyByHourChart = lazy(() =>
  import("@/components/dashboard/OccupancyByHourChart").then((m) => ({ default: m.OccupancyByHourChart }))
);
import {
  CalendarIcon,
  CheckCircle,
  Clock,
  Users,
  XCircle,
  UserX,
  Star,
  UsersRound,
  ListChecks,
  Footprints,
} from "lucide-react";
import { formatDateBR } from "@/lib/utils";

const PERIOD_LABEL: Record<Period, string> = {
  today: "hoje",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
  "90d": "últimos 90 dias",
};

export default function Dashboard() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";
  const unitSlug = unit?.unit_slug ?? "";

  const [period, setPeriod] = useState<Period>("30d");

  const { data: stats } = useReservaStats(unitId);
  const { data: reservasHoje, isLoading: isLoadingReservasHoje } = useReservasHoje(unitId);

  const { kpis, charts, lists, hasDataInPeriod, isLoading: isLoadingMetrics } =
    useDashboardMetrics(unitId, period);

  const { data: walkInStats } = useWalkInStatsToday(unitId);
  const { data: waitlist } = useWaitlist(unitId, true);

  const today = new Date().toISOString().split("T")[0];
  const periodLabel = PERIOD_LABEL[period];

  const valueOrUndef = <T,>(v: T): T | undefined => (isLoadingMetrics ? undefined : v);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description={formatDateBR(today, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
      />

      {/* Bloco A — Operação de hoje */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Operação de hoje</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Reservas hoje"
            value={stats?.total_hoje}
            icon={CalendarIcon}
            color="bg-primary/10 text-primary"
          />
          <KpiCard
            title="Confirmadas"
            value={stats?.confirmadas_hoje}
            icon={CheckCircle}
            color="bg-success/10 text-success"
          />
          <KpiCard
            title="Pendentes"
            value={stats?.pendentes_hoje}
            icon={Clock}
            color="bg-warning/10 text-warning"
          />
          <KpiCard
            title="Pessoas esperadas"
            value={stats?.pessoas_hoje}
            icon={Users}
            color="bg-accent/20 text-accent-foreground"
          />
        </div>

        <div className="pt-2">
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">Reservas de hoje</h3>
          {isLoadingReservasHoje ? (
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
      </section>

      {/* Filtro de período */}
      <section className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t">
        <div>
          <h2 className="text-lg font-semibold">Análise do período</h2>
          <p className="text-xs text-muted-foreground">Comparado com período anterior de mesma duração</p>
        </div>
        <PeriodFilter value={period} onChange={setPeriod} />
      </section>

      {/* Bloco B — KPIs do período */}
      <section className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard
          title="Confirmadas"
          value={valueOrUndef(kpis.reservasConfirmadas)}
          icon={CheckCircle}
          color="bg-primary/10 text-primary"
          delta={kpis.deltas.reservasConfirmadas}
        />
        <KpiCard
          title="Pessoas atendidas"
          value={valueOrUndef(kpis.pessoasAtendidas)}
          icon={UsersRound}
          color="bg-accent/20 text-accent-foreground"
          delta={kpis.deltas.pessoasAtendidas}
        />
        <KpiCard
          title="No-show"
          value={valueOrUndef(kpis.noShowRate)}
          icon={UserX}
          color="bg-destructive/10 text-destructive"
          delta={kpis.deltas.noShowRate}
          invertDelta
          suffix="%"
        />
        <KpiCard
          title="Cancelamento"
          value={valueOrUndef(kpis.cancelRate)}
          icon={XCircle}
          color="bg-destructive/10 text-destructive"
          delta={kpis.deltas.cancelRate}
          invertDelta
          suffix="%"
        />
        <KpiCard
          title={`Avaliação média (${kpis.ratingsCount})`}
          value={valueOrUndef(kpis.avgRating ?? "—")}
          icon={Star}
          color="bg-amber-100 text-amber-600"
          delta={kpis.deltas.avgRating}
          deltaUnit="abs"
          suffix={kpis.avgRating !== null ? " ⭐" : undefined}
        />
        <KpiCard
          title="Tamanho médio do grupo"
          value={valueOrUndef(kpis.avgPartySize)}
          icon={Users}
          color="bg-secondary/10 text-secondary"
          delta={kpis.deltas.avgPartySize}
        />
      </section>

      {/* Bloco C — Charts principais */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Reservas por dia"
          subtitle={`Evolução nos ${periodLabel}`}
          loading={isLoadingMetrics}
          empty={!hasDataInPeriod}
          emptyContent={<EmptyChartCard />}
        >
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <ReservationsByDayChart data={charts.byDay} />
          </Suspense>
        </ChartCard>

        <ChartCard
          title="Ocupação por horário"
          subtitle="Reservas confirmadas por hora"
          loading={isLoadingMetrics}
          empty={!hasDataInPeriod || charts.byHour.every((h) => h.count === 0)}
          emptyContent={<EmptyChartCard message="Sem reservas confirmadas no período" />}
        >
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <OccupancyByHourChart data={charts.byHour} />
          </Suspense>
        </ChartCard>
      </section>

      {/* Bloco D — Avaliações */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Avaliações no período</h2>
        {charts.ratings.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Star className="h-6 w-6 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Nenhuma avaliação recebida {periodLabel}.</p>
            </CardContent>
          </Card>
        ) : (
          <RatingsSummary ratings={charts.ratings} />
        )}
      </section>

      {/* Bloco E — Últimas avaliações */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Últimas avaliações</h2>
          {unitSlug && (
            <Link
              to={`/g/${unitSlug}/avaliacoes`}
              className="text-xs text-primary hover:underline"
            >
              Ver todas →
            </Link>
          )}
        </div>
        <RecentRatingsList ratings={lists.recentRatings} />
      </section>

      {/* Bloco F — Operação live */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-5 pb-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Fila de espera ativa</p>
                <p className="text-2xl font-bold mt-1">{waitlist?.length ?? "—"}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Aguardando + notificados
                </p>
              </div>
              <div className="p-2.5 rounded-full bg-warning/10 text-warning shrink-0">
                <ListChecks className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Walk-ins hoje</p>
                <p className="text-2xl font-bold mt-1">{walkInStats?.total ?? "—"}</p>
                {walkInStats && walkInStats.total > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {walkInStats.seated} sentados · {walkInStats.waiting} aguardando · {walkInStats.left + walkInStats.no_show} saíram
                  </p>
                )}
              </div>
              <div className="p-2.5 rounded-full bg-accent/20 text-accent-foreground shrink-0">
                <Footprints className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

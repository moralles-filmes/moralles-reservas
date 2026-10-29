import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useReservaStats, useReservasHoje } from "@/hooks/useReservas";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useDashboardMetrics } from "@/hooks/useDashboardMetrics";
import { useUnitHourRange } from "@/hooks/useUnitHourRange";
import { useWalkInStatsToday } from "@/hooks/useWalkInStatsToday";
import { useWaitlist } from "@/hooks/useWaitlist";
import { ReservaCard } from "@/components/reserva/ReservaCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHero } from "@/components/dashboard/DashboardHero";
import { UpcomingArrivalsPanel } from "@/components/dashboard/UpcomingArrivalsPanel";
import { ConversationsWaitingPanel } from "@/components/dashboard/ConversationsWaitingPanel";
import { ManualReservaDialog } from "@/components/reserva/ManualReservaDialog";
import { buildArrivalsByHour } from "@/lib/arrivals-today";
import { KpiStrip } from "@/components/dashboard/KpiStrip";
import { KpiStat } from "@/components/dashboard/KpiStat";
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
  CheckCircle,
  Users,
  XCircle,
  UserX,
  Star,
  UsersRound,
  ListChecks,
  Footprints,
} from "lucide-react";
import { formatDateBR, todayLocalISO } from "@/lib/utils";

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

  const [manualOpen, setManualOpen] = useState(false);
  const [period, setPeriod] = useState<Period>("30d");

  const { data: stats } = useReservaStats(unitId);
  const {
    data: reservasHoje,
    isLoading: isLoadingReservasHoje,
    isError: isErrorReservasHoje,
    refetch: refetchReservasHoje,
  } = useReservasHoje(unitId);
  const unitHours = useUnitHourRange(unitId);

  const { kpis, charts, lists, hasDataInPeriod, isLoading: isLoadingMetrics } =
    useDashboardMetrics(unitId, period, unitHours);

  const { data: walkInStats } = useWalkInStatsToday(unitId);
  const { data: waitlist } = useWaitlist(unitId, true);

  const today = useMemo(() => todayLocalISO(), []);
  const periodLabel = PERIOD_LABEL[period];
  const hours = useMemo(() => buildArrivalsByHour(reservasHoje ?? [], unitHours), [reservasHoje, unitHours]);

  const extrasHoje =
    (stats?.canceladas_hoje ?? 0) + (stats?.no_show_hoje ?? 0);

  const valueOrUndef = <T,>(v: T): T | undefined => (isLoadingMetrics ? undefined : v);

  return (
    <div className="space-y-8">
      <DashboardHero
        dateLabel={formatDateBR(today, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        hours={hours}
        todayStats={stats}
        unitSlug={unitSlug}
        onNewReservation={() => setManualOpen(true)}
        isLoading={isLoadingReservasHoje}
        aside={
          <UpcomingArrivalsPanel
            reservas={reservasHoje}
            isLoading={isLoadingReservasHoje}
            isError={isErrorReservasHoje}
            onRetry={() => refetchReservasHoje()}
          />
        }
      />
      {unitId && unit?.organization_id && (
        <ManualReservaDialog open={manualOpen} onOpenChange={setManualOpen} unitId={unitId} organizationId={unit?.organization_id ?? ""} />
      )}

      {/* Operação ao vivo: conversas, fila e walk-ins */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ConversationsWaitingPanel unitId={unitId} unitSlug={unitSlug} />
        <div className="surface rounded-card p-5">
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
        </div>

        <div className="surface rounded-card p-5">
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
        </div>
      </section>

      <section className="space-y-3">
        <div className="pt-2">
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">
            Reservas de hoje
            {stats && extrasHoje > 0 && (
              <span className="text-xs font-normal ml-2">
                ({stats.canceladas_hoje} canc.{stats.no_show_hoje > 0 ? ` · ${stats.no_show_hoje} no-show` : ""})
              </span>
            )}
          </h3>
          {isLoadingReservasHoje ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          ) : isErrorReservasHoje ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground space-y-3">
                <p>Não foi possível carregar as reservas de hoje.</p>
                <Button variant="outline" onClick={() => refetchReservasHoje()}>Tentar de novo</Button>
              </CardContent>
            </Card>
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
      <KpiStrip className="lg:grid-cols-3">
        <KpiStat
          title="Confirmadas"
          value={valueOrUndef(kpis.reservasConfirmadas)}
          icon={CheckCircle}
          color="bg-primary/10 text-primary"
          delta={kpis.deltas.reservasConfirmadas}
        />
        <KpiStat
          title="Pessoas atendidas"
          value={valueOrUndef(kpis.pessoasAtendidas)}
          icon={UsersRound}
          color="bg-accent/20 text-accent-foreground"
          delta={kpis.deltas.pessoasAtendidas}
        />
        <KpiStat
          title="No-show"
          value={valueOrUndef(kpis.noShowRate)}
          icon={UserX}
          color="bg-destructive/10 text-destructive"
          delta={kpis.deltas.noShowRate}
          invertDelta
          suffix="%"
        />
        <KpiStat
          title="Cancelamento"
          value={valueOrUndef(kpis.cancelRate)}
          icon={XCircle}
          color="bg-destructive/10 text-destructive"
          delta={kpis.deltas.cancelRate}
          invertDelta
          suffix="%"
        />
        <KpiStat
          title={`Avaliação média (${kpis.ratingsCount})`}
          value={valueOrUndef(kpis.avgRating ?? "—")}
          icon={Star}
          color="bg-gold/10 text-gold"
          delta={kpis.deltas.avgRating}
          deltaUnit="abs"
          suffix={kpis.avgRating !== null ? " ⭐" : undefined}
        />
        <KpiStat
          title="Tamanho médio do grupo"
          value={valueOrUndef(kpis.avgPartySize)}
          icon={Users}
          color="bg-info/10 text-info"
          delta={kpis.deltas.avgPartySize}
        />
      </KpiStrip>

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
    </div>
  );
}

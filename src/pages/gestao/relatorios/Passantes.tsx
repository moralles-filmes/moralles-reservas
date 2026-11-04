import { useState } from "react";
import {
  AlertTriangle,
  CalendarRange,
  Clock,
  DollarSign,
  Footprints,
  Hourglass,
  LogOut,
  UserMinus,
  Users,
  UsersRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useUnitPublicContent } from "@/hooks/useUnitPublicContent";
import type { DateRange } from "@/hooks/useFluxoClientes";
import { useRelatorioPassantes } from "@/hooks/useRelatorioPassantes";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { DateRangePicker, presetRange } from "@/components/relatorios/DateRangePicker";
import { PassanteKpiCard } from "@/components/relatorios/passantes/PassanteKpiCard";
import { PassanteHeatmap } from "@/components/relatorios/passantes/PassanteHeatmap";
import { PassantePlaceTable } from "@/components/relatorios/passantes/PassantePlaceTable";
import {
  DailyChart,
  DowBarChart,
  HourChart,
  PartySizeBars,
  PartySizeTableTime,
  type Metric,
} from "@/components/relatorios/passantes/PassanteCharts";
import { formatBRL, formatDecimal, formatHM } from "@/components/relatorios/passantes/format";

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function MetricToggle({ value, onChange }: { value: Metric; onChange: (m: Metric) => void }) {
  return (
    <div className="flex gap-1">
      <ToggleChip active={value === "groups"} onClick={() => onChange("groups")}>
        Grupos
      </ToggleChip>
      <ToggleChip active={value === "people"} onClick={() => onChange("people")}>
        Pessoas
      </ToggleChip>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    </div>
  );
}

export default function Passantes() {
  const unit = useCurrentUnit();
  const unitId = unit?.unit_id ?? "";

  const [range, setRange] = useState<DateRange>(() => presetRange(30));
  const [hourMetric, setHourMetric] = useState<Metric>("groups");
  const [dowMetric, setDowMetric] = useState<Metric>("groups");

  const { data: unitContent } = useUnitPublicContent(unitId);
  const ticket = unitContent?.price_range_max ?? null;
  const hasTicket = !!ticket && ticket > 0;

  const { report, comparison, isLoading, isPlaceholderData, error, refetch } = useRelatorioPassantes(
    unitId,
    range,
    ticket,
  );
  const k = report.kpis;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={[
          { label: unit?.unit_name ?? "Unidade", to: `/g/${unit?.unit_slug ?? ""}` },
          { label: "Relatórios" },
          { label: "Passantes" },
        ]}
        title="Passantes"
      />

      <div className="flex items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-3 text-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm">Não foi possível carregar o relatório de passantes.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : k.groups === 0 ? (
        <Card>
          <CardContent className="p-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
            <CalendarRange className="h-6 w-6 opacity-40" />
            <p className="text-sm font-medium text-foreground">Nenhum passante no período</p>
            <p className="text-xs">Escolha outro intervalo de datas.</p>
          </CardContent>
        </Card>
      ) : (
        <div className={cn("space-y-5 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <PassanteKpiCard title="Grupos" value={String(k.groups)} icon={Footprints} delta={comparison.groups} />
            <PassanteKpiCard title="Pessoas" value={String(k.people)} icon={Users} delta={comparison.people} />
            <PassanteKpiCard
              title="Tamanho médio do grupo"
              value={formatDecimal(k.avgPartySize, 1)}
              icon={UsersRound}
              delta={comparison.avgPartySize}
            />
            <PassanteKpiCard
              title="Tempo médio na mesa"
              value={formatHM(k.avgTableSec)}
              icon={Clock}
              subtitle={`${k.releasedGroups} de ${k.tableCoverageDenominator} liberados · mediana ${formatHM(k.medianTableSec)}`}
              delta={comparison.avgTableSec}
            />
            <PassanteKpiCard
              title="Tempo médio de espera"
              value={formatHM(k.avgWaitSec)}
              icon={Hourglass}
              subtitle={`mediana ${formatHM(k.medianWaitSec)} · ${
                k.directSeatedPct == null ? "—" : formatDecimal(k.directSeatedPct, 0)
              }% sentou direto`}
              delta={comparison.avgWaitSec}
              invertDelta
            />
            <PassanteKpiCard
              title="Taxa de desistência"
              value={k.abandonRatePct == null ? "—" : `${formatDecimal(k.abandonRatePct, 1)}%`}
              icon={LogOut}
              subtitle={`${k.abandonedGroups} ${k.abandonedGroups === 1 ? "desistência" : "desistências"}${
                k.waitingGroups > 0 ? ` · ${k.waitingGroups} em espera` : ""
              }`}
              delta={comparison.abandonRatePct}
              invertDelta
            />
            {hasTicket && (
              <PassanteKpiCard
                title="Receita estimada"
                value={formatBRL(k.revenueCents)}
                icon={DollarSign}
                delta={comparison.revenueCents}
              />
            )}
            {k.seatedWithoutTable > 0 && (
              <PassanteKpiCard
                title="Sentados sem mesa registrada"
                value={String(k.seatedWithoutTable)}
                icon={UserMinus}
              />
            )}
          </div>

          <Section
            title="Passantes por dia"
            subtitle="Grupos e pessoas sentadas por dia no período."
            action={
              <div className="flex gap-6 text-right">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Grupos sentados</p>
                  <p className="text-xl font-bold">{k.seatedGroups}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pessoas sentadas</p>
                  <p className="text-xl font-bold">{k.seatedPeople}</p>
                </div>
              </div>
            }
          >
            <div className="h-72">
              <DailyChart data={report.daily} />
            </div>
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section
              title="Por horário de chegada"
              subtitle="Horário de Brasília."
              action={<MetricToggle value={hourMetric} onChange={setHourMetric} />}
            >
              <div className="h-72">
                <HourChart data={report.byHour} metric={hourMetric} />
              </div>
            </Section>
            <Section
              title="Por dia da semana"
              action={<MetricToggle value={dowMetric} onChange={setDowMetric} />}
            >
              <div className="h-72">
                <DowBarChart data={report.byDow} metric={dowMetric} />
              </div>
            </Section>
          </div>

          <Section title="Mapa de calor" subtitle="Grupos que chegaram por dia da semana e hora.">
            <PassanteHeatmap rows={report.heatmap} max={report.heatmapMax} />
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Tamanho dos grupos" subtitle="Grupos por quantidade de pessoas.">
              <div className="h-64">
                <PartySizeBars data={report.byPartySize} />
              </div>
            </Section>
            <Section title="Tempo médio na mesa por tamanho" subtitle="Só grupos liberados pela planta.">
              <div className="h-64">
                <PartySizeTableTime data={report.byPartySize} />
              </div>
            </Section>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Por salão">
              <PassantePlaceTable rows={report.byHall} firstColumn="Salão" />
            </Section>
            <Section title="Por mesa">
              <PassantePlaceTable rows={report.byTable} firstColumn="Mesa" />
            </Section>
          </div>

          <p className="text-xs text-muted-foreground">
            O tempo na mesa só existe para passantes liberados pela planta. Horários em horário de Brasília.
          </p>
        </div>
      )}
    </div>
  );
}
